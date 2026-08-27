/* Register lookup, opcode table, and RISC-V encoding helpers. */

#include "asm.h"

int opc_reg_id(const char *name)
{
    if (!strcmp(name, "fp"))
        return 8;

    static const char *regs[] = {
        "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2",
        "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7",
        "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11",
        "t3", "t4", "t5", "t6", 0};

    for (int i = 0; regs[i]; i++)
        if (!strcmp(name, regs[i]))
            return i;

    if (name[0] == 'x' && isdigit((unsigned char)name[1]))
    {
        int n = 0;
        for (int i = 1; name[i]; i++)
        {
            if (name[i] < '0' || name[i] > '9')
                return -1;
            n = n * 10 + (name[i] - '0');
        }

        return (n >= 0 && n <= 31) ? n : -1;
    }

    return -1;
}

const Opc *opc_find(const char *name)
{
    static const Opc tbl[] = {
        {.name = "lui", .op = 0x37, .f3 = 0, .f7 = 0, .fmt = U},
        {.name = "auipc", .op = 0x17, .f3 = 0, .f7 = 0, .fmt = U},
        {.name = "jal", .op = 0x6F, .f3 = 0, .f7 = 0, .fmt = J},
        {.name = "jalr", .op = 0x67, .f3 = 0, .f7 = 0, .fmt = I},
        {.name = "beq", .op = 0x63, .f3 = 0, .f7 = 0, .fmt = B},
        {.name = "bne", .op = 0x63, .f3 = 1, .f7 = 0, .fmt = B},
        {.name = "blt", .op = 0x63, .f3 = 4, .f7 = 0, .fmt = B},
        {.name = "bge", .op = 0x63, .f3 = 5, .f7 = 0, .fmt = B},
        {.name = "bltu", .op = 0x63, .f3 = 6, .f7 = 0, .fmt = B},
        {.name = "bgeu", .op = 0x63, .f3 = 7, .f7 = 0, .fmt = B},
        {.name = "lb", .op = 0x03, .f3 = 0, .f7 = 0, .fmt = I},
        {.name = "lh", .op = 0x03, .f3 = 1, .f7 = 0, .fmt = I},
        {.name = "lw", .op = 0x03, .f3 = 2, .f7 = 0, .fmt = I},
        {.name = "lbu", .op = 0x03, .f3 = 4, .f7 = 0, .fmt = I},
        {.name = "lhu", .op = 0x03, .f3 = 5, .f7 = 0, .fmt = I},
        {.name = "sb", .op = 0x23, .f3 = 0, .f7 = 0, .fmt = S},
        {.name = "sh", .op = 0x23, .f3 = 1, .f7 = 0, .fmt = S},
        {.name = "sw", .op = 0x23, .f3 = 2, .f7 = 0, .fmt = S},
        {.name = "addi", .op = 0x13, .f3 = 0, .f7 = 0, .fmt = I},
        {.name = "slti", .op = 0x13, .f3 = 2, .f7 = 0, .fmt = I},
        {.name = "sltiu", .op = 0x13, .f3 = 3, .f7 = 0, .fmt = I},
        {.name = "xori", .op = 0x13, .f3 = 4, .f7 = 0, .fmt = I},
        {.name = "ori", .op = 0x13, .f3 = 6, .f7 = 0, .fmt = I},
        {.name = "andi", .op = 0x13, .f3 = 7, .f7 = 0, .fmt = I},
        {.name = "slli", .op = 0x13, .f3 = 1, .f7 = 0, .fmt = I},
        {.name = "srli", .op = 0x13, .f3 = 5, .f7 = 0, .fmt = I},
        {.name = "srai", .op = 0x13, .f3 = 5, .f7 = 0x20, .fmt = I},
        {.name = "add", .op = 0x33, .f3 = 0, .f7 = 0, .fmt = R},
        {.name = "sub", .op = 0x33, .f3 = 0, .f7 = 0x20, .fmt = R},
        {.name = "sll", .op = 0x33, .f3 = 1, .f7 = 0, .fmt = R},
        {.name = "slt", .op = 0x33, .f3 = 2, .f7 = 0, .fmt = R},
        {.name = "sltu", .op = 0x33, .f3 = 3, .f7 = 0, .fmt = R},
        {.name = "xor", .op = 0x33, .f3 = 4, .f7 = 0, .fmt = R},
        {.name = "srl", .op = 0x33, .f3 = 5, .f7 = 0, .fmt = R},
        {.name = "sra", .op = 0x33, .f3 = 5, .f7 = 0x20, .fmt = R},
        {.name = "or", .op = 0x33, .f3 = 6, .f7 = 0, .fmt = R},
        {.name = "and", .op = 0x33, .f3 = 7, .f7 = 0, .fmt = R},
        {.name = "mul", .op = 0x33, .f3 = 0, .f7 = 1, .fmt = R},
        {.name = "mulh", .op = 0x33, .f3 = 1, .f7 = 1, .fmt = R},
        {.name = "mulhsu", .op = 0x33, .f3 = 2, .f7 = 1, .fmt = R},
        {.name = "mulhu", .op = 0x33, .f3 = 3, .f7 = 1, .fmt = R},
        {.name = "div", .op = 0x33, .f3 = 4, .f7 = 1, .fmt = R},
        {.name = "divu", .op = 0x33, .f3 = 5, .f7 = 1, .fmt = R},
        {.name = "rem", .op = 0x33, .f3 = 6, .f7 = 1, .fmt = R},
        {.name = "remu", .op = 0x33, .f3 = 7, .f7 = 1, .fmt = R},
        {0}};
    for (int i = 0; tbl[i].name; i++)
        if (!strcmp(name, tbl[i].name))
            return &tbl[i];
    return 0;
}

int opc_parse_reg(AsmState *s)
{
    if (s->lex.type != T_IDENT)
    {
        phase_error(s, "REGISTER EXPECTED");
        return -1;
    }
    int r = opc_reg_id(s->lex.buf);
    if (r < 0)
    {
        phase_error(s, "UNKNOWN REGISTER");
        return -1;
    }
    lex_next(s);
    return r;
}

unsigned int enc_r(int op, int rd, int f3, int rs1, int rs2, int f7)
{
    return (f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op;
}

unsigned int enc_i(int op, int rd, int f3, int rs1, int imm)
{
    return ((imm & IMM_12_MASK) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op;
}

unsigned int enc_s(int op, int f3, int rs1, int rs2, int imm)
{
    return (((imm >> 5) & IMM_7_MASK) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & IMM_5_MASK) << 7) | op;
}

unsigned int enc_b(int op, int f3, int rs1, int rs2, int imm)
{
    return (((imm >> 12) & 1) << 31) | (((imm >> 5) & IMM_6_MASK) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) |
           (((imm >> 1) & IMM_4_MASK) << 8) | (((imm >> 11) & 1) << 7) | op;
}

unsigned int enc_u(int op, int rd, int imm20)
{
    return ((imm20 & IMM_20_MASK) << 12) | (rd << 7) | op;
}

unsigned int enc_j(int op, int rd, int imm)
{
    return (((imm >> 20) & 1) << 31) | (((imm >> 1) & IMM_10_MASK) << 21) | (((imm >> 11) & 1) << 20) |
           (((imm >> 12) & IMM_8_MASK) << 12) | (rd << 7) | op;
}

/* Streams output through a small chunk buffer to the scratch file open in
 * s->out.fd. Pass 1 (fd < 0) drops bytes; write failures are reported once
 * and remembered in s->out.err so the rest of the pass no-ops. */
static void out_push(AsmState *s, unsigned char b)
{
    if (s->out.fd < 0 || s->out.err)
        return;
    s->out.data[s->out.len++] = b;
    if (s->out.len == OUT_CHUNK_SZ)
        out_flush(s);
}

void out_flush(AsmState *s)
{
    if (s->out.fd < 0 || s->out.err || s->out.len == 0)
        return;
    int n = write(s->out.fd, s->out.data, s->out.len);
    if (n != s->out.len)
    {
        s->out.err = 1;
        phase_error(s, "OUTPUT WRITE FAILED");
    }
    s->out.total += s->out.len;
    s->out.len = 0;
}

int out_emit_byte(AsmState *s, unsigned char b)
{
    out_push(s, b);
    return !s->out.err;
}

void out_emit_word(AsmState *s, unsigned int w)
{
    out_push(s, w & 0xff);
    out_push(s, (w >> 8) & 0xff);
    out_push(s, (w >> 16) & 0xff);
    out_push(s, (w >> 24) & 0xff);
}