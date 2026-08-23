#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trap {
    IllegalInstruction(u32),
}

pub fn word_align(addr: u32) -> u32 { addr & !3 }
pub fn byte_offset(addr: u32) -> u32 { (addr & 3) << 3 }
pub fn byte_n(data: u32, n: u32) -> u8 { ((data >> (n * 8)) & 0xFF) as u8 }

pub trait BusAccess {
    fn read_w(&mut self, addr: u32) -> u32;
    fn write_w(&mut self, addr: u32, data: u32, sel: u8);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AluOp {
    Add,
    Sub,
    Sll,
    Slt,
    Sltu,
    Xor,
    Srl,
    Sra,
    Or,
    And,
    Mul,
    Mulh,
    Mulhsu,
    Mulhu,
    Div,
    Divu,
    Rem,
    Remu,
}


