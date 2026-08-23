#![cfg_attr(target_arch = "wasm32", no_std)]
#![allow(static_mut_refs)]

extern crate alloc;

use alloc::boxed::Box;
use core::sync::atomic::{AtomicU32, Ordering};
use veecore::decode;
use veecore::machine::{Machine, BUS_TX_RING_SIZE};
use veecore::peripherals::{DiskState, DISK_BASE, KBD_BASE, DSP_BASE, CLK_BASE, TIMER_BASE, DMA_BASE};

#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOC: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn wasm_panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable();
}

static mut MACHINE: Option<Box<Machine>> = None;

static mut TTY_BUF: [u8; 4096] = [0; 4096];
static TTY_LEN: AtomicU32 = AtomicU32::new(0);

#[no_mangle]
pub extern "C" fn veecore_alloc(size: u32) -> *mut u8 {
    let layout = core::alloc::Layout::from_size_align(size as usize, 4).unwrap();
    let ptr = unsafe { alloc::alloc::alloc(layout) };
    ptr
}

#[no_mangle]
pub extern "C" fn veecore_init_with(disk_ptr: *mut u8, disk_len: u32) {
    let disk_vec = unsafe {
        alloc::vec::Vec::from_raw_parts(disk_ptr, disk_len as usize, disk_len as usize)
    };
    let m = Box::new(Machine::new(disk_vec));
    unsafe { MACHINE = Some(m); }
}

#[no_mangle]
pub extern "C" fn veecore_load_bootloader(ptr: *mut u8, len: u32) {
    let m = unsafe { MACHINE.as_mut().unwrap() };
    let boot_slice = unsafe { core::slice::from_raw_parts(ptr, len as usize) };
    m.bus.ram.load(0, boot_slice);
}

#[no_mangle]
pub extern "C" fn veecore_reset() {
    let m = unsafe { MACHINE.as_mut().unwrap() };
    m.reset(0);
}

#[no_mangle]
pub extern "C" fn veecore_tick() {
    let m = unsafe { MACHINE.as_mut().unwrap() };
    let _ = m.tick();
}

#[no_mangle]
pub extern "C" fn veecore_tick_n(n: u32) {
    let m = unsafe { MACHINE.as_mut().unwrap() };
    for _ in 0..n {
        if m.tick().is_err() {
            break;
        }
    }
}

#[no_mangle]
pub extern "C" fn veecore_tty_read() -> u32 {
    let m = unsafe { MACHINE.as_mut().unwrap() };
    let output = m.bus.tty.drain();
    let n = unsafe {
        let max = TTY_BUF.len();
        let n = core::cmp::min(output.len(), max);
        if n > 0 {
            core::ptr::copy_nonoverlapping(output.as_ptr(), TTY_BUF.as_mut_ptr(), n);
        }
        n
    };
    TTY_LEN.store(n as u32, Ordering::SeqCst);
    n as u32
}

#[no_mangle]
pub extern "C" fn veecore_tty_buf() -> *const u8 {
    unsafe { TTY_BUF.as_ptr() }
}

#[no_mangle]
pub extern "C" fn veecore_kbd_inject(byte: u32) {
    let m = unsafe { MACHINE.as_mut().unwrap() };
    m.bus.kbd.inject(byte as u8);
}

static mut DISASM_BUF: [u8; 64] = [0; 64];
static DISASM_LEN: AtomicU32 = AtomicU32::new(0);

#[no_mangle]
pub extern "C" fn veecore_pc() -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    m.cpu.current_pc
}

#[no_mangle]
pub extern "C" fn veecore_disasm() -> *const u8 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    let n = decode::disasm(m.cpu.current_raw, unsafe { &mut DISASM_BUF });
    DISASM_LEN.store(n as u32, Ordering::SeqCst);
    unsafe { DISASM_BUF.as_ptr() }
}

#[no_mangle]
pub extern "C" fn veecore_disasm_len() -> u32 {
    DISASM_LEN.load(Ordering::SeqCst)
}

#[no_mangle]
pub extern "C" fn veecore_reg(idx: u32) -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    if idx < 32 {
        m.cpu.read_reg(idx as usize)
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn veecore_set_clock_hz(hz: u32) {
    let m = unsafe { MACHINE.as_mut().unwrap() };
    m.set_clock_hz(hz);
}

#[no_mangle]
pub extern "C" fn veecore_ram_byte(addr: u32) -> u8 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    if (addr as usize) < veecore::memory::RAM_SIZE {
        m.bus.ram.data[addr as usize]
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn veecore_dma_byte(addr: u32) -> u8 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    m.bus.dma.read_byte(addr)
}

#[no_mangle]
pub extern "C" fn veecore_dma_step() -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    m.bus.dma.step as u32
}

#[no_mangle]
pub extern "C" fn veecore_timer_cstr() -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    m.bus.timer.read_cstr() as u32
}

#[no_mangle]
pub extern "C" fn veecore_timer_cntr() -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    m.bus.timer.counter as u32
}

#[no_mangle]
pub extern "C" fn veecore_disk_sector() -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    m.bus.disk.sector_lba as u32
}

#[no_mangle]
pub extern "C" fn veecore_disk_offset() -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    m.bus.disk.offset as u32
}

#[no_mangle]
pub extern "C" fn veecore_disk_usage() -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    let (used, total) = m.bus.disk.used_sectors();
    (used << 16) | total
}

#[no_mangle]
pub extern "C" fn veecore_disk_state() -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    match m.bus.disk.state {
        DiskState::Idle => 0,
        DiskState::BfWr => 1,
        DiskState::BfRd => 2,
        DiskState::Diskr => 3,
    }
}

#[no_mangle]
pub extern "C" fn veecore_disk_ptr() -> *const u8 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    m.bus.disk.image.as_ptr()
}

#[no_mangle]
pub extern "C" fn veecore_disk_base() -> u32 { DISK_BASE as u32 }

#[no_mangle]
pub extern "C" fn veecore_kbd_base() -> u32 { KBD_BASE as u32 }

#[no_mangle]
pub extern "C" fn veecore_dsp_base() -> u32 { DSP_BASE as u32 }

#[no_mangle]
pub extern "C" fn veecore_clk_base() -> u32 { CLK_BASE as u32 }

#[no_mangle]
pub extern "C" fn veecore_timer_base() -> u32 { TIMER_BASE as u32 }

#[no_mangle]
pub extern "C" fn veecore_dma_base() -> u32 { DMA_BASE as u32 }

#[no_mangle]
pub extern "C" fn veecore_disk_len() -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    m.bus.disk.image.len() as u32
}

#[no_mangle]
pub extern "C" fn veecore_disk_dirty() -> u32 {
    let m = unsafe { MACHINE.as_mut().unwrap() };
    let dirty = m.bus.disk.dirty as u32;
    m.bus.disk.dirty = false;
    dirty
}

#[no_mangle]
pub extern "C" fn veecore_last_mem_addr() -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    m.bus.last_mem_addr
}

#[no_mangle]
pub extern "C" fn veecore_last_mem_size() -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    m.bus.last_mem_size as u32
}

#[no_mangle]
pub extern "C" fn veecore_last_mem_write() -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    if m.bus.last_mem_write { 1 } else { 0 }
}

#[no_mangle]
pub extern "C" fn veecore_bus_tx_count() -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    m.bus.tx_ring_count as u32
}

fn tx_idx(m: &Machine, idx: u32) -> usize {
    let count = m.bus.tx_ring_count as u32;
    if idx >= count { return BUS_TX_RING_SIZE; }
    let head = m.bus.tx_ring_head as usize;
    // newest-first: idx 0 = most recent
    (head.wrapping_sub(1).wrapping_sub(idx as usize)) % BUS_TX_RING_SIZE
}

#[no_mangle]
pub extern "C" fn veecore_bus_tx_source_addr(idx: u32) -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    let i = tx_idx(&m, idx);
    if i >= BUS_TX_RING_SIZE { return 0; }
    m.bus.tx_ring[i].source_addr as u32
}

#[no_mangle]
pub extern "C" fn veecore_bus_tx_dest_addr(idx: u32) -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    let i = tx_idx(&m, idx);
    if i >= BUS_TX_RING_SIZE { return 0; }
    m.bus.tx_ring[i].dest_addr as u32
}

#[no_mangle]
pub extern "C" fn veecore_bus_tx_source_kind(idx: u32) -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    let i = tx_idx(&m, idx);
    if i >= BUS_TX_RING_SIZE { return 0; }
    m.bus.tx_ring[i].source_kind as u32
}

#[no_mangle]
pub extern "C" fn veecore_bus_tx_access_type(idx: u32) -> u32 {
    let m = unsafe { MACHINE.as_ref().unwrap() };
    let i = tx_idx(&m, idx);
    if i >= BUS_TX_RING_SIZE { return 0; }
    m.bus.tx_ring[i].access_type as u32
}
