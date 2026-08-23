use crate::peripherals::DMA_BASE;

pub const SAR_O: u32 = 0x00;
pub const DAR_O: u32 = 0x04;
pub const WCR_O: u32 = 0x08;
pub const CSTR_O: u32 = 0x0C;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DmaStep {
    Byte,
    HalfWord,
    Word,
}

#[derive(Clone)]
pub struct DmaController {
    pub sar: u16,
    pub dar: u16,
    pub wcr: u16,
    pub running: bool,
    pub stream: bool,
    pub step: DmaStep,
    pub src_inc: bool,
    pub dst_inc: bool,
}

impl Default for DmaController {
    fn default() -> Self {
        Self::new()
    }
}

impl DmaController {
    pub fn new() -> Self {
        DmaController {
            sar: 0, dar: 0, wcr: 0,
            running: false, stream: false,
            step: DmaStep::Byte, src_inc: false, dst_inc: false,
        }
    }

    fn pack_cstr(&self) -> u8 {
        (if self.running { 1 } else { 0 })
            | (if self.stream { 2 } else { 0 })
            | (if self.src_inc { 4 } else { 0 })
            | (if self.dst_inc { 8 } else { 0 })
            | ((self.step as u8) << 4)
    }

    fn unpack_cstr(&mut self, data: u8) {
        self.stream = data & 0x02 != 0;
        self.src_inc = data & 0x04 != 0;
        self.dst_inc = data & 0x08 != 0;
        self.step = match (data >> 4) & 0x03 {
            0 => DmaStep::Byte,
            1 => DmaStep::HalfWord,
            _ => DmaStep::Word,
        };
    }

    pub fn read_byte(&self, addr: u32) -> u8 {
        let offset = (addr - DMA_BASE as u32) as usize;
        match offset {
            0 => self.sar as u8,
            1 => (self.sar >> 8) as u8,
            4 => self.dar as u8,
            5 => (self.dar >> 8) as u8,
            8 => self.wcr as u8,
            9 => (self.wcr >> 8) as u8,
            12 => self.pack_cstr(),
            _ => 0,
        }
    }

    pub fn write_byte(&mut self, addr: u32, data: u8) {
        let offset = (addr - DMA_BASE as u32) as usize;
        match offset {
            0 => self.sar = (self.sar & 0xFF00) | data as u16,
            1 => self.sar = (self.sar & 0x00FF) | ((data as u16) << 8),
            4 => self.dar = (self.dar & 0xFF00) | data as u16,
            5 => self.dar = (self.dar & 0x00FF) | ((data as u16) << 8),
            8 => self.wcr = (self.wcr & 0xFF00) | data as u16,
            9 => self.wcr = (self.wcr & 0x00FF) | ((data as u16) << 8),
            12 => {
                self.unpack_cstr(data);
                if data & 0x01 != 0 {
                    self.running ^= true;
                }
            }
            _ => {}
        }
    }
}

