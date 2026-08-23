use alloc::vec::Vec;
use core::cmp;

pub const DISK_SECTOR_SIZE: usize = 512;

/// I/O register bases. Keep in sync with freecpm/platform/vemu/mmio.h.
/// Every register sits in its own 4-byte-aligned word.
pub const DISK_BASE: u16 = 0xFF00;
pub const DISK_SECTOR_O: u16 = 0x04;  // 0xFF04
pub const KBD_BASE: u16 = 0xFF08;
pub const KBD_STATUS: u16 = 0xFF0C;  // read-only, no consume
pub const DSP_BASE: u16 = 0xFF10;
pub const CLK_BASE: u16 = 0xFF14;
pub const TIMER_BASE: u16 = 0xFF18;
pub const TIMER_CSTR_O: u16 = 0x00;  // 0xFF18
pub const TIMER_CNTR_O: u16 = 0x04;  // 0xFF1C
pub const DMA_BASE: u16 = 0xFF20;

pub struct Timer {
    pub enabled: bool,
    pub mode: bool,       // false=continuous, true=one-shot
    pub overflow: bool,
    pub prescaler: u8,    // 0=1, 1=8, 2=64, 3=256
    pub counter: u16,
    tick_div: u32,
}

impl Default for Timer {
    fn default() -> Self {
        Self::new()
    }
}

impl Timer {
    pub fn new() -> Self {
        Timer { enabled: false, mode: false, overflow: false, prescaler: 0, counter: 0, tick_div: 0 }
    }

    const PRESCALER_VALS: [u32; 4] = [1, 8, 64, 256];

    pub fn tick(&mut self) {
        if !self.enabled { return; }
        self.tick_div += 1;

        if self.tick_div >= Self::PRESCALER_VALS[self.prescaler as usize] {
            self.tick_div = 0;
            self.counter = self.counter.wrapping_add(1);

            if self.counter == 0 {
                self.overflow = true;
                if self.mode {
                    self.enabled = false;  // one-shot: stop on overflow
                }
            }
        }
    }

    pub fn read_cstr(&self) -> u8 {
        (if self.enabled { 1 } else { 0 })
            | (if self.mode { 2 } else { 0 })
            | (if self.overflow { 4 } else { 0 })
            | ((self.prescaler & 3) << 4)
    }

    pub fn write_cstr(&mut self, val: u8) {
        self.enabled = (val & 1) != 0;
        self.mode = (val & 2) != 0;
        // The guest OS must explicitly write a 1 to bit 2 to acknowledge and clear the interrupt.
        if (val & 4) != 0 {
            self.overflow = false;
        }
        self.prescaler = (val >> 4) & 3;
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum DiskState {
    Idle,
    BfWr,
    BfRd,
    Diskr,
}

pub struct Tty {
    pub buf: [u8; 4096],
    pub len: usize,
}

impl Default for Tty {
    fn default() -> Self {
        Self::new()
    }
}

impl Tty {
    pub fn new() -> Self {
        Tty { buf: [0; 4096], len: 0 }
    }

    pub fn write(&mut self, byte: u8) {
        if self.len < self.buf.len() {
            self.buf[self.len] = byte;
            self.len += 1;
        }
    }

    pub fn drain(&mut self) -> &[u8] {
        let end = self.len;
        self.len = 0;
        &self.buf[..end]
    }
}

pub const KBD_BUF_SIZE: usize = 32;

pub struct Kbd {
    pub buf: [u8; KBD_BUF_SIZE],
    pub head: u8,
    pub tail: u8,
    pub count: u8,
    pub last_char: u8,
}

impl Default for Kbd {
    fn default() -> Self {
        Self::new()
    }
}

impl Kbd {
    pub fn new() -> Self {
        Kbd { buf: [0; KBD_BUF_SIZE], head: 0, tail: 0, count: 0, last_char: 0 }
    }

    pub fn read(&mut self) -> u8 {
        if self.count == 0 { return 0; }
        let val = self.buf[self.tail as usize] & 0x7F;
        self.tail = (self.tail + 1) % KBD_BUF_SIZE as u8;
        self.count -= 1;
        val
    }

    pub fn status(&self) -> u8 {
        if self.count == 0 { 0 } else { 1 }
    }

    pub fn inject(&mut self, ascii: u8) {
        self.last_char = ascii;
        if self.count < KBD_BUF_SIZE as u8 {
            self.buf[self.head as usize] = ascii;
            self.head = (self.head + 1) % KBD_BUF_SIZE as u8;
            self.count += 1;
        }
    }
}

pub struct Disk {
    pub image: Vec<u8>,
    pub sector_buf: [u8; DISK_SECTOR_SIZE],
    pub offset: u16,
    pub sector_lba: u16,
    pub state: DiskState,
    pub dirty: bool,
}

impl Disk {
    pub fn new(image: Vec<u8>) -> Self {
        Disk {
            image,
            sector_buf: [0; DISK_SECTOR_SIZE],
            offset: 0,
            sector_lba: 0,
            state: DiskState::Idle,
            dirty: false,
        }
    }

    pub fn select_sector(&mut self, lba: u16) {
        self.state = DiskState::Diskr;
        self.offset = 0;
        let is_write = lba & 0x8000 != 0;
        let phys_lba = lba & 0x7FFF;
        if is_write {
            let start = (phys_lba as usize) * DISK_SECTOR_SIZE;
            if start + DISK_SECTOR_SIZE <= self.image.len() {
                self.image[start..start + DISK_SECTOR_SIZE].copy_from_slice(&self.sector_buf);
                self.dirty = true;
            }
        }
        self.sector_lba = phys_lba;
        self.load_sector(phys_lba);
    }

    pub fn read_byte(&mut self) -> u8 {
        self.state = DiskState::BfRd;
        let val = self.sector_buf[self.offset as usize];
        self.offset = (self.offset + 1) % (DISK_SECTOR_SIZE as u16);
        if self.offset == 0 {
            self.state = DiskState::Idle;
        }
        val
    }

    pub fn write_byte(&mut self, byte: u8) {
        self.state = DiskState::BfWr;
        self.sector_buf[self.offset as usize] = byte;
        self.offset += 1;
        if self.offset >= DISK_SECTOR_SIZE as u16 {
            self.state = DiskState::Idle;
            self.offset = 0;
        }
    }

    /// Populate the buffer from the disk image at the given LBA.
    /// This is called on every sector select (both read and write).
    fn load_sector(&mut self, lba: u16) {
        let start = (lba as usize) * DISK_SECTOR_SIZE;
        let end = cmp::min(start + DISK_SECTOR_SIZE, self.image.len());
        if start < self.image.len() {
            let len = end - start;
            self.sector_buf[..len].copy_from_slice(&self.image[start..end]);
            for i in len..DISK_SECTOR_SIZE {
                self.sector_buf[i] = 0;
            }
        } else {
            for b in &mut self.sector_buf {
                *b = 0;
            }
        }
    }

    pub fn used_sectors(&self) -> (u32, u32) {
        let total = (self.image.len() / DISK_SECTOR_SIZE) as u32;
        if self.image.len() < 512 {
            return (0, total);
        }

        fn u16_at(img: &[u8], off: usize) -> u16 {
            u16::from_le_bytes([img[off], img[off + 1]])
        }

        const KERN_START_LBA: u32 = 2;
        const S0_KERN_SECS: usize = 0x018;
        const VMAP_LBA: usize = 1;
        const VMAP_NUM_BLOCKS: usize = 0x000;
        const VMAP_VOLREC: usize = 0x006;
        const VMAP_VOLREC_SIZE: usize = 18;
        const VOL_MAX_EXT: usize = 4;
        const VOL_MAX: usize = 4;
        const BD_BLOCK_SECS: u32 = 2;

        let s0 = &self.image[..512];
        let reserved_secs = u16_at(s0, S0_KERN_SECS) as u32;
        let mut used = KERN_START_LBA + reserved_secs;

        let vmap_off = VMAP_LBA * DISK_SECTOR_SIZE;
        if vmap_off + 512 <= self.image.len() {
            let vmap = &self.image[vmap_off..vmap_off + 512];
            let num_blocks = u16_at(vmap, VMAP_NUM_BLOCKS) as u32;
            if (1..=32768).contains(&num_blocks) {
                for v in 0..VOL_MAX {
                    let vr = VMAP_VOLREC + v * VMAP_VOLREC_SIZE;
                    let ext_count = vmap[vr] as usize;
                    if ext_count > VOL_MAX_EXT {
                        continue;
                    }
                    for i in 0..ext_count {
                        let count = u16_at(vmap, vr + 1 + i * 4 + 2) as u32;
                        used += count * BD_BLOCK_SECS;
                    }
                }
            }
        }

        (used, total)
    }
}
