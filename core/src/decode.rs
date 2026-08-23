use crate::types::AluOp;

#[derive(Clone, Copy, Debug)]
pub struct DecodedInst {
    pub opcode: u8,
    pub rd: u8,
    pub rs1: u8,
    pub rs2: u8,
    pub funct3: u8,
    pub funct7: u8,
    pub imm: u32,
}

fn sext(val: u32, bit: u32) -> u32 {
    if val & (1 << bit) != 0 {
        val | (0xFFFFFFFF << bit)
    } else {
        val
    }
}

fn decode_i_imm(raw: u32) -> u32 {
    sext(raw >> 20, 11)
}

fn decode_s_imm(raw: u32) -> u32 {
    let low = raw >> 7 & 0x1F;
    let high = raw >> 25 & 0x7F;
    sext((high << 5) | low, 11)
}

fn decode_b_imm(raw: u32) -> u32 {
    let b12 = raw >> 31 & 1;
    let b10_5 = raw >> 25 & 0x3F;
    let b4_1 = raw >> 8 & 0xF;
    let b11 = raw >> 7 & 1;
    sext((b12 << 12) | (b11 << 11) | (b10_5 << 5) | (b4_1 << 1), 12)
}

fn decode_u_imm(raw: u32) -> u32 {
    raw & 0xFFFFF000
}

fn decode_j_imm(raw: u32) -> u32 {
    let b20 = raw >> 31 & 1;
    let b10_1 = raw >> 21 & 0x3FF;
    let b11 = raw >> 20 & 1;
    let b19_12 = raw >> 12 & 0xFF;
    sext((b20 << 20) | (b19_12 << 12) | (b11 << 11) | (b10_1 << 1), 20)
}

pub fn decode(raw: u32) -> DecodedInst {
    let opcode = (raw & 0x7F) as u8;
    let rd = ((raw >> 7) & 0x1F) as u8;
    let funct3 = ((raw >> 12) & 0x7) as u8;
    let rs1 = ((raw >> 15) & 0x1F) as u8;
    let rs2 = ((raw >> 20) & 0x1F) as u8;
    let funct7 = ((raw >> 25) & 0x7F) as u8;

    let imm = match opcode & 0x7F {
        0x03 | 0x13 | 0x1B | 0x67 | 0x73 => decode_i_imm(raw),
        0x23 => decode_s_imm(raw),
        0x63 => decode_b_imm(raw),
        0x37 | 0x17 => decode_u_imm(raw),
        0x6F => decode_j_imm(raw),
        _ => 0,
    };

    DecodedInst { opcode, rd, rs1, rs2, funct3, funct7, imm }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstType {
    // RV32I
    Lui,
    Auipc,
    Jal,
    Jalr,
    Branch(BranchKind),
    Load(LoadKind),
    Store(StoreKind),
    AluI(AluOp),
    AluR(AluOp),
    Fence,

    // pseudo-instruction hint
    Illegal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BranchKind {
    Beq,
    Bne,
    Blt,
    Bge,
    Bltu,
    Bgeu,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoadKind {
    Lb,
    Lh,
    Lw,
    Lbu,
    Lhu,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreKind {
    Sb,
    Sh,
    Sw,
}

pub fn classify(inst: &DecodedInst) -> InstType {
    match inst.opcode {
        0x37 => InstType::Lui,
        0x17 => InstType::Auipc,
        0x6F => InstType::Jal,
        0x67 => InstType::Jalr,
        0x63 => {
            match inst.funct3 {
                0 => InstType::Branch(BranchKind::Beq),
                1 => InstType::Branch(BranchKind::Bne),
                4 => InstType::Branch(BranchKind::Blt),
                5 => InstType::Branch(BranchKind::Bge),
                6 => InstType::Branch(BranchKind::Bltu),
                7 => InstType::Branch(BranchKind::Bgeu),
                _ => InstType::Illegal,
            }
        }
        0x03 => {
            match inst.funct3 {
                0 => InstType::Load(LoadKind::Lb),
                1 => InstType::Load(LoadKind::Lh),
                2 => InstType::Load(LoadKind::Lw),
                4 => InstType::Load(LoadKind::Lbu),
                5 => InstType::Load(LoadKind::Lhu),
                _ => InstType::Illegal,
            }
        }
        0x23 => {
            match inst.funct3 {
                0 => InstType::Store(StoreKind::Sb),
                1 => InstType::Store(StoreKind::Sh),
                2 => InstType::Store(StoreKind::Sw),
                _ => InstType::Illegal,
            }
        }
        0x13 => {
            let alu = match inst.funct3 {
                0 => AluOp::Add,
                1 => AluOp::Sll,
                2 => AluOp::Slt,
                3 => AluOp::Sltu,
                4 => AluOp::Xor,
                5 => {
                    if inst.funct7 & 0x20 != 0 { AluOp::Sra } else { AluOp::Srl }
                }
                6 => AluOp::Or,
                7 => AluOp::And,
                _ => return InstType::Illegal,
            };
            InstType::AluI(alu)
        }
        0x33 => {
            let alu = match inst.funct3 {
                0 => {
                    if inst.funct7 == 0x01 { AluOp::Mul }
                    else if inst.funct7 & 0x20 != 0 { AluOp::Sub }
                    else { AluOp::Add }
                }
                1 => {
                    if inst.funct7 == 0x01 { AluOp::Mulh }
                    else { AluOp::Sll }
                }
                2 => {
                    if inst.funct7 == 0x01 { AluOp::Mulhsu }
                    else { AluOp::Slt }
                }
                3 => {
                    if inst.funct7 == 0x01 { AluOp::Mulhu }
                    else { AluOp::Sltu }
                }
                4 => {
                    if inst.funct7 == 0x01 { AluOp::Div }
                    else { AluOp::Xor }
                }
                5 => {
                    if inst.funct7 == 0x01 { AluOp::Divu }
                    else if inst.funct7 & 0x20 != 0 { AluOp::Sra }
                    else { AluOp::Srl }
                }
                6 => {
                    if inst.funct7 == 0x01 { AluOp::Rem }
                    else { AluOp::Or }
                }
                7 => {
                    if inst.funct7 == 0x01 { AluOp::Remu }
                    else { AluOp::And }
                }
                _ => return InstType::Illegal,
            };
            InstType::AluR(alu)
        }
        0x0F => InstType::Fence,
        0x73 => InstType::Illegal,
        _ => InstType::Illegal,
    }
}

fn fmt_reg(r: u8) -> &'static [u8] {
    match r {
        0 => b"x0", 1 => b"x1", 2 => b"x2", 3 => b"x3",
        4 => b"x4", 5 => b"x5", 6 => b"x6", 7 => b"x7",
        8 => b"x8", 9 => b"x9", 10 => b"x10", 11 => b"x11",
        12 => b"x12", 13 => b"x13", 14 => b"x14", 15 => b"x15",
        16 => b"x16", 17 => b"x17", 18 => b"x18", 19 => b"x19",
        20 => b"x20", 21 => b"x21", 22 => b"x22", 23 => b"x23",
        24 => b"x24", 25 => b"x25", 26 => b"x26", 27 => b"x27",
        28 => b"x28", 29 => b"x29", 30 => b"x30", 31 => b"x31",
        _ => b"??",
    }
}

fn write_sep(buf: &mut [u8], pos: &mut usize) {
    write_str(buf, pos, b", ");
}

fn write_imm(buf: &mut [u8], pos: &mut usize, imm: u32) {
    write_dec(buf, pos, imm as isize);
}

fn write_str(buf: &mut [u8], pos: &mut usize, s: &[u8]) {
    let n = s.len();
    let end = core::cmp::min(*pos + n, buf.len());
    let copy_len = end - *pos;
    if copy_len > 0 {
        buf[*pos..end].copy_from_slice(&s[..copy_len]);
        *pos = end;
    }
}

fn write_dec(buf: &mut [u8], pos: &mut usize, val: isize) {
    if val < 0 {
        if *pos < buf.len() { buf[*pos] = b'-'; *pos += 1; }
        write_dec_pos(buf, pos, (-val) as u32);
    } else {
        write_dec_pos(buf, pos, val as u32);
    }
}

fn write_dec_pos(buf: &mut [u8], pos: &mut usize, mut n: u32) {
    if n == 0 {
        if *pos < buf.len() { buf[*pos] = b'0'; *pos += 1; }
        return;
    }
    let mut stack = [0u8; 10];
    let mut sp = 0;
    while n > 0 {
        stack[sp] = b'0' + (n % 10) as u8;
        sp += 1;
        n /= 10;
    }
    while sp > 0 {
        sp -= 1;
        if *pos < buf.len() { buf[*pos] = stack[sp]; *pos += 1; }
    }
}

fn mnemonic(itype: &InstType) -> &'static [u8] {
    match itype {
        InstType::Lui => b"lui ",
        InstType::Auipc => b"auipc ",
        InstType::Jal => b"jal ",
        InstType::Jalr => b"jalr ",
        InstType::Branch(kind) => match kind {
            BranchKind::Beq => b"beq ",
            BranchKind::Bne => b"bne ",
            BranchKind::Blt => b"blt ",
            BranchKind::Bge => b"bge ",
            BranchKind::Bltu => b"bltu ",
            BranchKind::Bgeu => b"bgeu ",
        },
        InstType::Load(kind) => match kind {
            LoadKind::Lb => b"lb ",
            LoadKind::Lh => b"lh ",
            LoadKind::Lw => b"lw ",
            LoadKind::Lbu => b"lbu ",
            LoadKind::Lhu => b"lhu ",
        },
        InstType::Store(kind) => match kind {
            StoreKind::Sb => b"sb ",
            StoreKind::Sh => b"sh ",
            StoreKind::Sw => b"sw ",
        },
        InstType::AluI(op) => match op {
            AluOp::Add => b"addi ",
            AluOp::Sll => b"slli ",
            AluOp::Slt => b"slti ",
            AluOp::Sltu => b"sltiu ",
            AluOp::Xor => b"xori ",
            AluOp::Srl => b"srli ",
            AluOp::Sra => b"srai ",
            AluOp::Or => b"ori ",
            AluOp::And => b"andi ",
            _ => b"??i ",
        },
        InstType::AluR(op) => match op {
            AluOp::Add => b"add ",
            AluOp::Sub => b"sub ",
            AluOp::Sll => b"sll ",
            AluOp::Slt => b"slt ",
            AluOp::Sltu => b"sltu ",
            AluOp::Xor => b"xor ",
            AluOp::Srl => b"srl ",
            AluOp::Sra => b"sra ",
            AluOp::Or => b"or ",
            AluOp::And => b"and ",
            AluOp::Mul => b"mul ",
            AluOp::Mulh => b"mulh ",
            AluOp::Mulhsu => b"mulhsu ",
            AluOp::Mulhu => b"mulhu ",
            AluOp::Div => b"div ",
            AluOp::Divu => b"divu ",
            AluOp::Rem => b"rem ",
            AluOp::Remu => b"remu ",
        },
        InstType::Fence => b"fence",
        InstType::Illegal => b"illegal",
    }
}

pub fn disasm(raw: u32, buf: &mut [u8]) -> usize {
    let inst = decode(raw);
    let itype = classify(&inst);
    let mut p = 0;

    match itype {
        InstType::Lui | InstType::Auipc => {
            write_str(buf, &mut p, mnemonic(&itype));
            write_str(buf, &mut p, fmt_reg(inst.rd));
            write_str(buf, &mut p, b", 0x");
            let h = hex_fmt(inst.imm >> 12);
            write_str(buf, &mut p, trim_hex_leading(&h));
        }
        InstType::Jal => {
            write_str(buf, &mut p, mnemonic(&itype));
            write_str(buf, &mut p, fmt_reg(inst.rd));
            write_sep(buf, &mut p);
            write_imm(buf, &mut p, inst.imm);
        }
        InstType::Jalr => {
            write_str(buf, &mut p, mnemonic(&itype));
            write_str(buf, &mut p, fmt_reg(inst.rd));
            write_sep(buf, &mut p);
            write_str(buf, &mut p, fmt_reg(inst.rs1));
            write_sep(buf, &mut p);
            write_imm(buf, &mut p, inst.imm);
        }
        InstType::Branch(_) => {
            write_str(buf, &mut p, mnemonic(&itype));
            write_str(buf, &mut p, fmt_reg(inst.rs1));
            write_sep(buf, &mut p);
            write_str(buf, &mut p, fmt_reg(inst.rs2));
            write_sep(buf, &mut p);
            write_imm(buf, &mut p, inst.imm);
        }
        InstType::Load(_) => {
            write_str(buf, &mut p, mnemonic(&itype));
            write_str(buf, &mut p, fmt_reg(inst.rd));
            write_sep(buf, &mut p);
            write_imm(buf, &mut p, inst.imm);
            write_str(buf, &mut p, b"(");
            write_str(buf, &mut p, fmt_reg(inst.rs1));
            write_str(buf, &mut p, b")");
        }
        InstType::Store(_) => {
            write_str(buf, &mut p, mnemonic(&itype));
            write_str(buf, &mut p, fmt_reg(inst.rs2));
            write_sep(buf, &mut p);
            write_imm(buf, &mut p, inst.imm);
            write_str(buf, &mut p, b"(");
            write_str(buf, &mut p, fmt_reg(inst.rs1));
            write_str(buf, &mut p, b")");
        }
        InstType::AluI(_) => {
            write_str(buf, &mut p, mnemonic(&itype));
            write_str(buf, &mut p, fmt_reg(inst.rd));
            write_sep(buf, &mut p);
            write_str(buf, &mut p, fmt_reg(inst.rs1));
            write_sep(buf, &mut p);

            let imm = match itype {
                InstType::AluI(AluOp::Sll) | InstType::AluI(AluOp::Srl) | InstType::AluI(AluOp::Sra) => inst.imm & 0x1F,
                _ => inst.imm,
            };
            write_imm(buf, &mut p, imm);
        }
        InstType::AluR(_) => {
            write_str(buf, &mut p, mnemonic(&itype));
            write_str(buf, &mut p, fmt_reg(inst.rd));
            write_sep(buf, &mut p);
            write_str(buf, &mut p, fmt_reg(inst.rs1));
            write_sep(buf, &mut p);
            write_str(buf, &mut p, fmt_reg(inst.rs2));
        }
        InstType::Fence => write_str(buf, &mut p, mnemonic(&itype)),

        InstType::Illegal => write_str(buf, &mut p, mnemonic(&itype)),
    }
    p
}

fn hex_fmt(n: u32) -> [u8; 8] {
    let mut buf = [0u8; 8];
    for (i, b) in buf.iter_mut().enumerate() {
        let nibble = ((n >> ((7 - i) * 4)) & 0xF) as u8;
        *b = if nibble < 10 { b'0' + nibble } else { b'a' + nibble - 10 };
    }
    buf
}

fn trim_hex_leading(hex: &[u8; 8]) -> &[u8] {
    let mut i = 0;
    while i < 7 && hex[i] == b'0' {
        i += 1;
    }
    &hex[i..]
}

