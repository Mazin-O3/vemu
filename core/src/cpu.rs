use crate::alu;
use crate::decode::{self, BranchKind, InstType, LoadKind, StoreKind};
use crate::regfile::RegFile;
use crate::types::{word_align, byte_offset, BusAccess, Trap};

pub struct Cpu {
    pub pc: u32,
    regs: RegFile,
    pub trap: Option<Trap>,
    pub retired: u64,
    pub current_pc: u32,
    pub current_raw: u32,
}

impl Cpu {
    pub fn new(pc: u32) -> Self {
        Cpu { pc, regs: RegFile::new(), trap: None, retired: 0, current_pc: 0, current_raw: 0 }
    }

    pub fn reset(&mut self, pc: u32) {
        self.pc = pc;
        self.regs.reset();
        self.trap = None;
        self.retired = 0;
        self.current_pc = 0;
        self.current_raw = 0;
    }

    pub fn read_reg(&self, idx: usize) -> u32 {
        self.regs.read(idx)
    }

    pub fn write_reg(&mut self, idx: usize, val: u32) {
        self.regs.write(idx, val);
    }

    fn read_rs1(&self, inst: &decode::DecodedInst) -> u32 {
        self.regs.read(inst.rs1 as usize)
    }

    fn read_rs2(&self, inst: &decode::DecodedInst) -> u32 {
        self.regs.read(inst.rs2 as usize)
    }

    fn write_rd(&mut self, inst: &decode::DecodedInst, val: u32) {
        self.regs.write(inst.rd as usize, val);
    }

    fn pc_add(&self, inst: &decode::DecodedInst) -> u32 {
        self.pc.wrapping_add(inst.imm)
    }

    fn eff_addr(&self, inst: &decode::DecodedInst) -> u32 {
        self.regs.read(inst.rs1 as usize).wrapping_add(inst.imm)
    }

    fn load_aligned(bus: &mut impl BusAccess, addr: u32) -> u32 {
        let val = bus.read_w(word_align(addr));
        val >> byte_offset(addr) 
    }

    fn store_aligned(bus: &mut impl BusAccess, addr: u32, data: u32, kind: StoreKind) {
        let shift = byte_offset(addr);
        let (sel, shifted) = match kind {
            StoreKind::Sb => (1 << (addr & 3), data << shift),
            StoreKind::Sh => (3 << (addr & 3), data << shift),
            StoreKind::Sw => (0xF, data),
        };
        bus.write_w(word_align(addr), shifted, sel as u8);
    }

    pub fn tick(&mut self, bus: &mut impl BusAccess) -> Result<(), Trap> {
        if let Some(trap) = self.trap {
            return Err(trap);
        }

        if self.pc & 3 != 0 {
            self.trap = Some(Trap::IllegalInstruction(0));
            return Ok(());
        }

        let raw = bus.read_w(self.pc);
        self.current_pc = self.pc;
        self.current_raw = raw;
        let inst = decode::decode(raw);
        let itype = decode::classify(&inst);

        let mut next_pc = self.pc.wrapping_add(4);

        match itype {
            InstType::Lui => {
                self.write_rd(&inst, inst.imm);
            }
            InstType::Auipc => {
                self.write_rd(&inst, self.pc_add(&inst));
            }
            InstType::Jal => {
                self.write_rd(&inst, self.pc.wrapping_add(4));
                next_pc = self.pc_add(&inst);
            }
            InstType::Jalr => {
                let base = self.read_rs1(&inst);
                self.write_rd(&inst, self.pc.wrapping_add(4));
                next_pc = base.wrapping_add(inst.imm) & !1;
            }
            InstType::Branch(kind) => {
                let rs1_v = self.read_rs1(&inst);
                let rs2_v = self.read_rs2(&inst);
                let taken = match kind {
                    BranchKind::Beq => rs1_v == rs2_v,
                    BranchKind::Bne => rs1_v != rs2_v,
                    BranchKind::Blt => (rs1_v as i32) < (rs2_v as i32),
                    BranchKind::Bge => (rs1_v as i32) >= (rs2_v as i32),
                    BranchKind::Bltu => rs1_v < rs2_v,
                    BranchKind::Bgeu => rs1_v >= rs2_v,
                };
                if taken {
                    next_pc = self.pc_add(&inst);
                }
            }
            InstType::Load(kind) => {
                let addr = self.eff_addr(&inst);
                let shifted = Self::load_aligned(bus, addr);
                let result = match kind {
                    LoadKind::Lb => (shifted as i8) as i32 as u32,
                    LoadKind::Lh => (shifted as i16) as i32 as u32,
                    LoadKind::Lw => shifted,
                    LoadKind::Lbu => shifted & 0xFF,
                    LoadKind::Lhu => shifted & 0xFFFF,
                };
                self.write_rd(&inst, result);
            }
            InstType::Store(kind) => {
                let addr = self.eff_addr(&inst);
                let data = self.read_rs2(&inst);
                Self::store_aligned(bus, addr, data, kind);
            }
            InstType::AluI(op) => {
                let rs1_v = self.read_rs1(&inst);
                let result = alu::alu(op, rs1_v, inst.imm);
                self.write_rd(&inst, result);
            }
            InstType::AluR(op) => {
                let rs1_v = self.read_rs1(&inst);
                let rs2_v = self.read_rs2(&inst);
                let result = alu::alu(op, rs1_v, rs2_v);
                self.write_rd(&inst, result);
            }
            InstType::Fence => {}
            InstType::Illegal => {
                self.trap = Some(Trap::IllegalInstruction(raw));
                return Err(Trap::IllegalInstruction(raw));
            }
        }

        self.pc = next_pc;
        self.retired += 1;
        Ok(())
    }
}

