#[derive(Clone)]
pub struct RegFile {
    regs: [u32; 32],
}

impl Default for RegFile {
    fn default() -> Self {
        Self::new()
    }
}

impl RegFile {
    pub fn new() -> Self {
        RegFile { regs: [0; 32] }
    }

    pub fn read(&self, idx: usize) -> u32 {
        debug_assert!(idx < 32, "RegFile index out of bounds");
        if idx == 0 { 0 } else { self.regs[idx] }
    }

    pub fn write(&mut self, idx: usize, val: u32) {
        debug_assert!(idx < 32, "RegFile index out of bounds");
        if idx != 0 {
            self.regs[idx] = val;
        }
    }

    pub fn reset(&mut self) {
        self.regs = [0; 32];
    }
}
