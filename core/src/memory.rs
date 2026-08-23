use core::fmt;


pub const RAM_SIZE: usize = 64 * 1024;

fn ram_idx(addr: u32) -> usize {
    ((addr as usize) & (RAM_SIZE - 1)) & !3
}

#[derive(Clone)]
pub struct Ram {
    pub data: [u8; RAM_SIZE],
}

impl Default for Ram {
    fn default() -> Self {
        Self::new()
    }
}

impl Ram {
    pub fn new() -> Self {
        Ram { data: [0; RAM_SIZE] }
    }

    pub fn load(&mut self, offset: usize, bytes: &[u8]) {
        if offset >= RAM_SIZE { return; }
        let end = core::cmp::min(offset + bytes.len(), RAM_SIZE);
        self.data[offset..end].copy_from_slice(&bytes[..end - offset]);
    }

    pub fn read_w(&self, addr: u32) -> u32 {
        let idx = ram_idx(addr);
        u32::from_le_bytes([
            self.data[idx],
            self.data[idx + 1],
            self.data[idx + 2],
            self.data[idx + 3],
        ])
    }

    pub fn write_w(&mut self, addr: u32, val: u32, sel: u8) {
        let idx = ram_idx(addr);
        if idx + 3 >= RAM_SIZE { return; }
        let bytes = val.to_le_bytes();
        for (i, b) in bytes.iter().enumerate() {
            if sel & (1 << i) != 0 {
                self.data[idx + i] = *b;
            }
        }
    }
}

impl fmt::Debug for Ram {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Ram(64KB)")
    }
}
