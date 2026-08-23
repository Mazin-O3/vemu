use alloc::vec::Vec;
use crate::cpu::Cpu;
use crate::dma;
use crate::memory::Ram;
use crate::peripherals;
use crate::peripherals::{Disk, Kbd, Timer, Tty};
use crate::types::{word_align, byte_offset, byte_n, BusAccess, Trap};

fn in_periph_range(addr: u32) -> bool {
    addr >= peripherals::DISK_BASE as u32
}

pub const BUS_TX_RING_SIZE: usize = 32;

#[derive(Clone, Copy)]
pub struct BusTransaction {
    pub source_addr: u16,
    pub dest_addr: u16,
    pub source_kind: u8,
    pub access_type: u8,
}

pub struct Bus {
    pub ram: Ram,
    pub dma: dma::DmaController,
    pub tty: Tty,
    pub kbd: Kbd,
    pub disk: Disk,
    pub timer: Timer,
    pub clock_khz: u16,
    pub last_mem_addr: u32,
    pub last_mem_size: u8,
    pub last_mem_write: bool,
    pub tx_source_kind: u8,
    pub tx_source_addr: u16,
    pub tx_ring: [BusTransaction; BUS_TX_RING_SIZE],
    pub tx_ring_head: u8,
    pub tx_ring_count: u8,
}

impl Bus {
    pub fn new(disk_image: Vec<u8>) -> Self {
        let mut bus = Bus {
            ram: Ram::new(),
            dma: dma::DmaController::new(),
            tty: Tty::new(),
            kbd: Kbd::new(),
            disk: Disk::new(disk_image),
            timer: Timer::new(),
            clock_khz: 100,
            last_mem_addr: 0,
            last_mem_size: 0,
            last_mem_write: false,
            tx_source_kind: 0,
            tx_source_addr: 0,
            tx_ring: [BusTransaction { source_addr: 0, dest_addr: 0, source_kind: 0, access_type: 0 }; BUS_TX_RING_SIZE],
            tx_ring_head: 0,
            tx_ring_count: 0,
        };
        let boot_bin = include_bytes!("../../freecpm/bootloader.bin");
        bus.ram.load(0, boot_bin);
        bus
    }

    pub fn push_tx(&mut self, dest_addr: u16, is_write: bool) {
        let i = self.tx_ring_head as usize;
        self.tx_ring[i] = BusTransaction {
            source_addr: self.tx_source_addr,
            dest_addr,
            source_kind: self.tx_source_kind,
            access_type: if is_write { 1 } else { 0 },
        };
        self.tx_ring_head = (self.tx_ring_head + 1) % BUS_TX_RING_SIZE as u8;
        if self.tx_ring_count < BUS_TX_RING_SIZE as u8 {
            self.tx_ring_count += 1;
        }
    }
}

impl Bus {
    fn begin_access(&mut self, mem_addr: u32, size: u8, write: bool) {
        self.last_mem_addr = mem_addr;
        self.last_mem_size = size;
        self.last_mem_write = write;
    }

    fn read_periph_b(&mut self, addr: u16) -> u8 {
        match addr {
            ba @ peripherals::DISK_BASE => {
                let v = self.disk.read_byte();
                self.push_tx(ba, false);
                v
            }
            ba @ peripherals::KBD_BASE => {
                let v = self.kbd.read();
                self.push_tx(ba, false);
                v
            }
            ba if ba == peripherals::KBD_STATUS => {
                let v = self.kbd.status();
                self.push_tx(ba, false);
                v
            }
            ba @ peripherals::TIMER_BASE => {
                self.push_tx(ba, false);
                self.timer.read_cstr()
            }
            a if a == peripherals::TIMER_BASE + peripherals::TIMER_CNTR_O => {
                self.push_tx(a, false);
                self.timer.counter as u8
            }
            a if a == peripherals::TIMER_BASE + peripherals::TIMER_CNTR_O + 1 => {
                self.push_tx(a, false);
                (self.timer.counter >> 8) as u8
            }
            ba @ peripherals::CLK_BASE => {
                self.push_tx(ba, false);
                self.clock_khz as u8
            }
            a if a == peripherals::CLK_BASE + 1 => {
                self.push_tx(a, false);
                (self.clock_khz >> 8) as u8
            }
            a if (peripherals::DMA_BASE..peripherals::DMA_BASE + 0x10).contains(&a) => {
                self.push_tx(a, false);
                self.dma.read_byte(a as u32)
            }
            _ => 0,
        }
    }

}

impl BusAccess for Bus {
    fn read_w(&mut self, addr: u32) -> u32 {
        self.begin_access(word_align(addr), 4, false);
        if in_periph_range(addr) {
            let mut val: u32 = 0;
            for i in 0..4 {
                let byte_addr = word_align(addr) + i as u32;
                if !in_periph_range(byte_addr) {
                    continue;
                }
                val |= (self.read_periph_b(byte_addr as u16) as u32) << (i * 8);
            }
            return val;
        }
        self.ram.read_w(addr)
    }

    fn write_w(&mut self, addr: u32, data: u32, sel: u8) {
        self.begin_access(word_align(addr), sel.count_ones() as u8, true);
        self.push_tx(word_align(addr) as u16, true);
        if in_periph_range(addr) {
            let wa = word_align(addr);
            if wa as u16 == peripherals::DISK_BASE + peripherals::DISK_SECTOR_O {
                let low = if sel & 0x01 != 0 { byte_n(data, 0) } else { 0 };
                let high = if sel & 0x02 != 0 { byte_n(data, 1) } else { 0 };
                self.disk.select_sector(((high as u16) << 8) | low as u16);
            }
            for i in 0..4 {
                if sel & (1 << i) == 0 {
                    continue;
                }
                let byte_addr = word_align(addr) + i;
                if !in_periph_range(byte_addr) {
                    continue;
                }
                let byte_val = byte_n(data, i);
                match byte_addr as u16 {
                    peripherals::DISK_BASE => self.disk.write_byte(byte_val),
                    peripherals::DSP_BASE => self.tty.write(byte_val),
                    peripherals::TIMER_BASE => self.timer.write_cstr(byte_val),
                    ba if ba == peripherals::TIMER_BASE + peripherals::TIMER_CNTR_O => self.timer.counter = (self.timer.counter & 0xFF00) | byte_val as u16,
                    ba if ba == peripherals::TIMER_BASE + peripherals::TIMER_CNTR_O + 1 => self.timer.counter = (self.timer.counter & 0x00FF) | ((byte_val as u16) << 8),
                    a if (peripherals::DMA_BASE..peripherals::DMA_BASE + 0x10).contains(&a) => self.dma.write_byte(a as u32, byte_val),
                    _ => {}
                }
            }
            return;
        }
        self.ram.write_w(addr, data, sel);
    }
}

impl Bus {
    fn read_b(&mut self, addr: u32) -> u8 {
        self.begin_access(addr, 1, false);
        match addr as u16 {
            peripherals::DISK_BASE
            | peripherals::KBD_BASE
            | peripherals::TIMER_BASE
            | peripherals::CLK_BASE => self.read_periph_b(addr as u16),
            a if a == peripherals::TIMER_BASE + peripherals::TIMER_CNTR_O
                || a == peripherals::TIMER_BASE + peripherals::TIMER_CNTR_O + 1
                || a == peripherals::CLK_BASE + 1 => self.read_periph_b(a),
            _ => {
                let v = self.read_w(word_align(addr));
                ((v >> byte_offset(addr)) & 0xFF) as u8
            }
        }
    }
}

pub struct Machine {
    pub cpu: Cpu,
    pub bus: Bus,
    pub cycles: u64,
    pub clock_hz: u64,
    rr_slot: u8,
}

impl Machine {
    pub fn new(disk_image: Vec<u8>) -> Self {
        Machine { cpu: Cpu::new(0), bus: Bus::new(disk_image), cycles: 0, clock_hz: 100_000, rr_slot: 0 }
    }

    pub fn set_clock_hz(&mut self, hz: u32) {
        self.clock_hz = hz as u64;
        self.bus.clock_khz = (hz / 1000) as u16;
    }

    fn cpu_tick(&mut self) -> Result<(), Trap> {
        self.bus.tx_source_kind = 0;
        self.bus.tx_source_addr = self.cpu.current_pc as u16;
        self.cpu.tick(&mut self.bus)
    }

    fn try_dma_transfer(&mut self) -> Result<(), Trap> {
        let (sar, dar, step, src_inc, dst_inc, running, wcr) = {
            let d = &self.bus.dma;
            (d.sar, d.dar, d.step, d.src_inc, d.dst_inc, d.running, d.wcr)
        };
        self.bus.tx_source_kind = 1;
        self.bus.tx_source_addr = sar;
        if !running || wcr == 0 {
            self.bus.dma.running = false;
            return Ok(());
        }
        let src = sar as u32;
        let dst = dar as u32;
        match step {
            dma::DmaStep::Byte => {
                let data = self.bus.read_b(src);
                let b_idx = (dst & 3) as usize;
                let sel = 1 << b_idx;
                self.bus.write_w(word_align(dst), (data as u32) << (b_idx * 8), sel);
            }
            dma::DmaStep::HalfWord => {
                let lo = self.bus.read_b(src) as u16;
                let hi = self.bus.read_b(src.wrapping_add(1)) as u16;
                let data = lo as u32 | ((hi as u32) << 8);
                let b_idx = (dst & 3) as usize;
                let sel = 3 << b_idx;
                self.bus.write_w(word_align(dst), data << (b_idx * 8), sel);
            }
            dma::DmaStep::Word => {
                let b0 = self.bus.read_b(src) as u32;
                let b1 = self.bus.read_b(src.wrapping_add(1)) as u32;
                let b2 = self.bus.read_b(src.wrapping_add(2)) as u32;
                let b3 = self.bus.read_b(src.wrapping_add(3)) as u32;
                let data = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
                self.bus.write_w(word_align(dst), data, 0xF);
            }
        }
        {
            let d = &mut self.bus.dma;
            let step_size = match step {
                dma::DmaStep::Byte => 1u16,
                dma::DmaStep::HalfWord => 2,
                dma::DmaStep::Word => 4,
            };
            if src_inc { d.sar = d.sar.wrapping_add(step_size); }
            if dst_inc { d.dar = d.dar.wrapping_add(step_size); }
            d.wcr = d.wcr.wrapping_sub(1);
            if d.wcr == 0 { d.running = false; }
        }
        Ok(())
    }

    pub fn tick(&mut self) -> Result<(), Trap> {
        self.cycles += 1;
        self.bus.timer.tick();

        if self.bus.dma.running && self.bus.dma.stream {
            self.try_dma_transfer()
        } else if self.bus.dma.running {
            if self.rr_slot != 0 {
                self.try_dma_transfer()?;
            } else {
                self.cpu_tick()?;
            }
            self.rr_slot ^= self.bus.dma.running as u8;
            Ok(())
        } else {
            self.cpu_tick()
        }
    }

    pub fn reset(&mut self, pc: u32) {
        self.cpu.reset(pc);
        self.bus.dma = dma::DmaController::new();
        self.bus.tty = Tty::new();
        self.bus.kbd = Kbd::new();
        self.cycles = 0;
        self.rr_slot = 0;
        let boot_bin = include_bytes!("../../freecpm/bootloader.bin");
        self.bus.ram.load(0, boot_bin);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bootloader_loads() {
        let disk_img = include_bytes!("../../freecpm/disk.img");
        let mut m = Machine::new(disk_img.to_vec());
        for _ in 0..2000000 {
            if m.cpu.trap.is_some() {
                break;
            }
            if m.tick().is_err() {
                break;
            }
        }
        let output = m.bus.tty.drain();
        let s = core::str::from_utf8(output).unwrap_or("");
        assert!(s.contains("TPA"), "output missing startup banner: got {:?}", s);
        assert!(m.cpu.trap.is_none(), "CPU trapped unexpectedly: {:?} at pc={:x}", m.cpu.trap, m.cpu.pc);
        assert!(s.contains(">"), "ccp prompt missing");
    }
}
