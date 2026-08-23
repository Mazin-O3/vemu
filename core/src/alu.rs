use crate::types::AluOp;

fn checked_sdiv(lhs: i32, rhs: i32) -> (i32, i32) {
    if lhs == i32::MIN && rhs == -1 {
        (lhs, 0)
    } else {
        (lhs.wrapping_div(rhs), lhs.wrapping_rem(rhs))
    }
}

pub fn alu(op: AluOp, a: u32, b: u32) -> u32 {
    match op {
        AluOp::Add => a.wrapping_add(b),
        AluOp::Sub => a.wrapping_sub(b),
        AluOp::Sll => a << (b & 0x1F),
        AluOp::Slt => if (a as i32) < (b as i32) { 1 } else { 0 },
        AluOp::Sltu => if a < b { 1 } else { 0 },
        AluOp::Xor => a ^ b,
        AluOp::Srl => a >> (b & 0x1F),
        AluOp::Sra => ((a as i32) >> (b & 0x1F)) as u32,
        AluOp::Or => a | b,
        AluOp::And => a & b,
        AluOp::Mul => a.wrapping_mul(b),
        AluOp::Mulh => {
            let lhs = (a as i32) as i64;
            let rhs = (b as i32) as i64;
            (lhs.wrapping_mul(rhs) >> 32) as u32
        }
        AluOp::Mulhsu => {
            let lhs = (a as i32) as i64;
            let rhs = b as u64;
            let result = lhs.wrapping_mul(rhs as i64);
            (result >> 32) as u32
        }
        AluOp::Mulhu => {
            let lhs = a as u64;
            let rhs = b as u64;
            (lhs.wrapping_mul(rhs) >> 32) as u32
        }
        AluOp::Div => {
            if b == 0 { 0xFFFFFFFF }
            else { checked_sdiv(a as i32, b as i32).0 as u32 }
        }
        AluOp::Divu => {
            if b == 0 { 0xFFFFFFFF } else { a.wrapping_div(b) }
        }
        AluOp::Rem => {
            if b == 0 { a }
            else { checked_sdiv(a as i32, b as i32).1 as u32 }
        }
        AluOp::Remu => {
            if b == 0 { a } else { a.wrapping_rem(b) }
        }
    }
}

