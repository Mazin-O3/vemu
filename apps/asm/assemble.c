/* Assembler main dispatch and instruction encoding.
 * Two-pass assembler: pass 1 collects labels, pass 2 emits code.
 * Supports RISC-V RV32I base + M extension. */

#include "asm.h"

/* Helpers */

static void asm_check_trailing(AsmState *s)
{
    if (s->lex.type != T_EOF)
        phase_error(s, "TRAILING GARBAGE");
}

static void asm_emit_li_la(AsmState *s, int rd, unsigned int v)
{
    unsigned int upper = (v + 0x800) >> 12;
    unsigned int lower = v - (upper << 12);
    out_emit_word(s, enc_u(OP_LUI, rd, upper));
    out_emit_word(s, enc_i(OP_ALU_I, rd, 0, rd, lower));
}

static int asm_expect_tok(AsmState *s, int type, const char *what)
{
    if (s->lex.type != type)
    {
        phase_error(s, what);
        return 0;
    }
    lex_next(s);
    return 1;
}

static int asm_expect_comma(AsmState *s)
{
    return asm_expect_tok(s, T_COMMA, "COMMA EXPECTED");
}

static int asm_expect_lparen(AsmState *s)
{
    return asm_expect_tok(s, T_LPAREN, "'(' EXPECTED");
}

static int asm_expect_rparen(AsmState *s)
{
    return asm_expect_tok(s, T_RPAREN, "')' EXPECTED");
}

static int asm_resolve_pc_rel(AsmState *s)
{
    int target;
    if (s->expr.is_label)
        target = s->expr.known ? s->expr.val : expr_resolve_label(s);
    else
        return s->expr.val;             /* literal displacement already relative */
    return target - s->out.pc;
}

/* Label */

static int asm_handle_label(AsmState *s)
{
    char label[ASM_LINE_SZ];
    strncpy(label, s->lex.buf, ASM_LINE_SZ - 1);
    label[ASM_LINE_SZ - 1] = 0;
    char *saved = s->lex.p;
    lex_next(s);
    if (s->lex.type != T_COLON)
    {
        s->lex.p = saved;
        strncpy(s->lex.buf, label, ASM_LINE_SZ - 1);
        s->lex.buf[ASM_LINE_SZ - 1] = 0;
        s->lex.type = T_IDENT;
        return 0;
    }

    lex_next(s);
    if (s->phase.pass == 1)
    {
        if (sym_find(s, label) >= 0)
        {
            printf("\n?DUPLICATE LABEL '%s' IN LINE %d\n", label, s->lex.line_num);
            s->phase.errors++;
        }
        else
            sym_add(s, label, s->out.pc);
    }

    return (s->lex.type == T_EOF);
}

/* Directives */

static void dir_org(AsmState *s)
{
    lex_next(s);
    if (s->lex.type == T_NUM)
    {
        s->out.org = s->lex.num;
        s->out.pc = s->lex.num;
        lex_next(s);
    }
    else
        phase_error(s, "NUMBER EXPECTED");
    asm_check_trailing(s);
}

static void dir_byte(AsmState *s)
{
    lex_next(s);
    for (;;)
    {
        if (s->lex.type == T_NUM)
        {
            if (s->phase.pass == 2 && !out_emit_byte(s, s->lex.num & 0xff))
                return;
            s->out.pc++;
            lex_next(s);
        }
        else
        {
            phase_error(s, "BYTE VALUE EXPECTED");
            return;
        }
        if (s->lex.type == T_COMMA)
            lex_next(s);
        else
            break;
    }
    asm_check_trailing(s);
}

static void dir_word(AsmState *s)
{
    lex_next(s);
    for (;;)
    {
        if (!expr_parse(s))
            return;
        if (s->phase.pass == 2)
            out_emit_word(s, s->expr.known ? s->expr.val : expr_resolve_label(s));
        s->out.pc += 4;
        if (s->lex.type == T_COMMA)
            lex_next(s);
        else
            break;
    }
    asm_check_trailing(s);
}

static void dir_ascii(AsmState *s)
{
    int is_z = !strcmp(s->lex.buf, ".asciiz") || !strcmp(s->lex.buf, ".asciz");
    lex_next(s);
    if (s->lex.type == T_STR)
    {
        for (int i = 0; s->lex.buf[i]; i++)
        {
            if (s->phase.pass == 2 && !out_emit_byte(s, s->lex.buf[i]))
                return;
            s->out.pc++;
        }
        if (is_z)
        {
            if (s->phase.pass == 2 && !out_emit_byte(s, 0))
                return;
            s->out.pc++;
        }
        lex_next(s);
    }
    else
        phase_error(s, "STRING EXPECTED");
    asm_check_trailing(s);
}

static void dir_align(AsmState *s)
{
    lex_next(s);
    if (s->lex.type == T_NUM)
    {
        if (s->lex.num >= 32)
        {
            phase_error(s, "ALIGNMENT TOO LARGE");
            lex_next(s);
            return;
        }
        int mask = (1 << s->lex.num) - 1;
        if (s->out.pc & mask)
        {
            int pad = (1 << s->lex.num) - (s->out.pc & mask);
            if (s->phase.pass == 2)
            {
                for (int i = 0; i < pad; i++)
                    out_emit_byte(s, 0);
            }
            s->out.pc += pad;
        }
        lex_next(s);
    }
    else
        phase_error(s, "NUMBER EXPECTED");
    asm_check_trailing(s);
}

/* .space count [, fill]  — reserve `count` bytes, each `fill` (default 0). */
static void dir_space(AsmState *s)
{
    int count = 0, fill = 0;
    lex_next(s);
    if (s->lex.type == T_NUM)
    {
        count = s->lex.num;
        lex_next(s);
        if (s->lex.type == T_COMMA)
        {
            lex_next(s);
            if (s->lex.type == T_NUM)
            {
                fill = s->lex.num & 0xff;
                lex_next(s);
            }
            else
            {
                phase_error(s, "FILL VALUE EXPECTED");
                return;
            }
        }
    }
    else
    {
        phase_error(s, "NUMBER EXPECTED");
        return;
    }
    if (count < 0)
    {
        phase_error(s, "NEGATIVE COUNT");
        return;
    }
    if (s->phase.pass == 2)
    {
        for (int i = 0; i < count; i++)
            out_emit_byte(s, (unsigned char)fill);
    }
    s->out.pc += count;
    asm_check_trailing(s);
}

/* .fill count [, size] [, value] — emit `count` copies of `value` written as
 * `size` little-endian bytes (GNU as compatible; defaults size=1, value=0). */
static void dir_fill(AsmState *s)
{
    int count = 0, size = 1, value = 0;
    lex_next(s);
    if (s->lex.type != T_NUM)
    {
        phase_error(s, "NUMBER EXPECTED");
        return;
    }
    count = s->lex.num;
    lex_next(s);
    if (s->lex.type == T_COMMA)
    {
        lex_next(s);
        if (s->lex.type != T_NUM)
        {
            phase_error(s, "NUMBER EXPECTED");
            return;
        }
        size = s->lex.num;
        lex_next(s);
        if (s->lex.type == T_COMMA)
        {
            lex_next(s);
            if (s->lex.type != T_NUM)
            {
                phase_error(s, "NUMBER EXPECTED");
                return;
            }
            value = s->lex.num;
            lex_next(s);
        }
    }
    int total = count * size;
    if (count < 0 || size < 0 || total < 0)
    {
        phase_error(s, "NEGATIVE COUNT");
        return;
    }
    if (s->phase.pass == 2)
    {
        for (int i = 0; i < count; i++)
        {
            for (int j = 0; j < size; j++)
            {
                int shift = j * 8;
                out_emit_byte(s, (unsigned char)((value >> shift) & 0xff));
            }
        }
    }
    s->out.pc += total;
    asm_check_trailing(s);
}

static void dir_section(AsmState *s)
{
    lex_next(s);
    asm_check_trailing(s);
}

static void dir_equ(AsmState *s)
{
    lex_next(s);
    if (s->lex.type == T_IDENT)
    {
        char ename[ASM_LINE_SZ];
        strncpy(ename, s->lex.buf, ASM_LINE_SZ - 1);
        ename[ASM_LINE_SZ - 1] = 0;
        lex_next(s);
        if (s->lex.type == T_COMMA)
            lex_next(s);
        if (expr_parse(s) && s->phase.pass == 1)
        {
            if (!s->expr.known)
                phase_error(s, "FORWARD REFERENCE IN .EQU NOT SUPPORTED");
            else if (sym_find(s, ename) >= 0)
            {
                printf("\n?DUPLICATE SYMBOL '%s' IN LINE %d\n", ename, s->lex.line_num);
                s->phase.errors++;
            }
            else
                sym_add(s, ename, s->expr.val);
        }
    }
    else
        phase_error(s, "IDENTIFIER EXPECTED");
    asm_check_trailing(s);
}

/* Pseudo-instructions */

static void pseudo_li_la(AsmState *s)
{
    lex_next(s);
    int rd = opc_parse_reg(s);
    if (rd < 0)
        return;
    if (!asm_expect_comma(s))
        return;
    if (!expr_parse(s))
        return;
    if (s->phase.pass == 2)
    {
        unsigned int v = s->expr.known ? (unsigned int)s->expr.val
                                       : (unsigned int)expr_resolve_label(s);
        asm_emit_li_la(s, rd, v);
    }
    s->out.pc += 8;
    asm_check_trailing(s);
}

static void pseudo_mv(AsmState *s)
{
    lex_next(s);
    int rd = opc_parse_reg(s);
    if (rd < 0)
        return;
    if (!asm_expect_comma(s))
        return;
    int rs1 = opc_parse_reg(s);
    if (rs1 < 0)
        return;
    if (s->phase.pass == 2)
        out_emit_word(s, enc_i(OP_ALU_I, rd, 0, rs1, 0));
    s->out.pc += 4;
    asm_check_trailing(s);
}

static void pseudo_nop(AsmState *s)
{
    lex_next(s);
    if (s->phase.pass == 2)
        out_emit_word(s, enc_i(OP_ALU_I, 0, 0, 0, 0));
    s->out.pc += 4;
    asm_check_trailing(s);
}

static void pseudo_j(AsmState *s)
{
    lex_next(s);
    if (!expr_parse(s))
        return;
    int imm = asm_resolve_pc_rel(s);
    if (s->phase.pass == 2)
    {
        if (imm & 1)
        {
            phase_error(s, "MISALIGNED JUMP TARGET");
            return;
        }
        out_emit_word(s, enc_j(OP_JAL, 0, imm));
    }
    s->out.pc += 4;
    asm_check_trailing(s);
}

static void pseudo_jr(AsmState *s)
{
    lex_next(s);
    int rs1 = opc_parse_reg(s);
    if (rs1 < 0)
        return;
    if (s->phase.pass == 2)
        out_emit_word(s, enc_i(OP_JALR, 0, 0, rs1, 0));
    s->out.pc += 4;
    asm_check_trailing(s);
}

static void pseudo_call(AsmState *s)
{
    lex_next(s);
    if (!expr_parse(s))
        return;
    int imm = asm_resolve_pc_rel(s);
    if (s->phase.pass == 2)
    {
        if (imm & 1)
        {
            phase_error(s, "MISALIGNED CALL TARGET");
            return;
        }
        out_emit_word(s, enc_j(OP_JAL, 1, imm));
    }
    s->out.pc += 4;
    asm_check_trailing(s);
}

static void pseudo_ret(AsmState *s)
{
    lex_next(s);
    if (s->phase.pass == 2)
        out_emit_word(s, enc_i(OP_JALR, 0, 0, 1, 0));
    s->out.pc += 4;
    asm_check_trailing(s);
}

/* Real instruction format handlers */

static int asm_parse_rd(AsmState *s)
{
    int rd = opc_parse_reg(s);
    if (rd < 0)
        return -1;
    if (!asm_expect_comma(s))
        return -1;
    return rd;
}

/* Main dispatch helpers */

/* Range-check a resolved immediate before encoding; without this the
 * encoders' field masks would silently truncate out-of-range values. */
static int asm_imm_range(AsmState *s, int imm, int lo, int hi)
{
    if (imm < lo || imm > hi)
    {
        phase_error(s, "IMMEDIATE OUT OF RANGE");
        return 0;
    }
    return 1;
}

#define IMM12_LO (-2048)
#define IMM12_HI 2047

static unsigned int asm_fmt_r(AsmState *s, const Opc *opc, int rd)
{
    int rs1 = opc_parse_reg(s);
    if (rs1 < 0)
        return 0;
    if (!asm_expect_comma(s))
        return 0;
    int rs2 = opc_parse_reg(s);
    if (rs2 < 0)
        return 0;
    return s->phase.pass == 2 ? enc_r(opc->op, rd, opc->f3, rs1, rs2, opc->f7) : 1;
}

static unsigned int asm_fmt_i(AsmState *s, const Opc *opc, int rd)
{
    if (opc->op == OP_LOAD || opc->op == OP_JALR)
    {
        if (!expr_parse(s))
            return 0;
        int imm = s->expr.val;
        if (!asm_expect_lparen(s))
            return 0;
        int rs1 = opc_parse_reg(s);
        if (rs1 < 0)
            return 0;
        if (!asm_expect_rparen(s))
            return 0;
        if (!s->expr.known)
        {
            imm = expr_resolve_label(s);
            if (s->phase.pass == 2 && s->phase.errors)
                return 0;
        }
        if (s->phase.pass == 2 && !asm_imm_range(s, imm, IMM12_LO, IMM12_HI))
            return 0;
        return s->phase.pass == 2 ? enc_i(opc->op, rd, opc->f3, rs1, imm) : 1;
    }

    int rs1 = opc_parse_reg(s);
    if (rs1 < 0)
        return 0;
    if (!asm_expect_comma(s))
        return 0;
    if (!expr_parse(s))
        return 0;
    int imm = s->expr.val;
    if (!s->expr.known)
    {
        imm = expr_resolve_label(s);
        if (s->phase.pass == 2 && s->phase.errors)
            return 0;
    }
    if (s->phase.pass == 2)
    {
        if (opc->f7 == SHIFT_F7)
        {
            if (!asm_imm_range(s, imm, 1, 31))
                return 0;
            return enc_i(opc->op, rd, opc->f3, rs1, (imm & SHIFT_MASK_5) | BIT_SHIFT_5);
        }
        if (opc->f3 == 1 || opc->f3 == 5)
        {
            if (!asm_imm_range(s, imm, 0, 31))
                return 0;
            return enc_i(opc->op, rd, opc->f3, rs1, imm & SHIFT_MASK_5);
        }
        if (!asm_imm_range(s, imm, IMM12_LO, IMM12_HI))
            return 0;
        return enc_i(opc->op, rd, opc->f3, rs1, imm);
    }
    return 1;
}

static unsigned int asm_fmt_s(AsmState *s, const Opc *opc)
{
    int rs2 = opc_parse_reg(s);
    if (rs2 < 0)
        return 0;
    if (!asm_expect_comma(s))
        return 0;
    if (!expr_parse(s))
        return 0;
    int imm = s->expr.val;
    if (!asm_expect_lparen(s))
        return 0;
    int rs1 = opc_parse_reg(s);
    if (rs1 < 0)
        return 0;
    if (!asm_expect_rparen(s))
        return 0;
    if (!s->expr.known)
        imm = expr_resolve_label(s);
    if (s->phase.pass == 2 && !asm_imm_range(s, imm, IMM12_LO, IMM12_HI))
        return 0;
    return s->phase.pass == 2 ? enc_s(opc->op, opc->f3, rs1, rs2, imm) : 1;
}

static unsigned int asm_fmt_b(AsmState *s, const Opc *opc)
{
    int rs1 = opc_parse_reg(s);
    if (rs1 < 0)
        return 0;
    if (!asm_expect_comma(s))
        return 0;
    int rs2 = opc_parse_reg(s);
    if (rs2 < 0)
        return 0;
    if (!asm_expect_comma(s))
        return 0;
    if (!expr_parse(s))
        return 0;
    int imm = asm_resolve_pc_rel(s);
    if (s->phase.pass == 2)
    {
        if (imm & 1)
        {
            phase_error(s, "MISALIGNED BRANCH TARGET");
            return 0;
        }
        if (!asm_imm_range(s, imm, -4096, 4094))
            return 0;
        return enc_b(opc->op, opc->f3, rs1, rs2, imm);
    }
    return 1;
}

static unsigned int asm_fmt_u(AsmState *s, const Opc *opc, int rd)
{
    if (!expr_parse(s))
        return 0;
    int imm = s->expr.val;
    if (!s->expr.known)
        imm = expr_resolve_label(s);
    (void)opc;
    if (s->phase.pass == 2 && !asm_imm_range(s, imm, -0x80000, 0xFFFFF))
        return 0;
    return s->phase.pass == 2 ? enc_u(opc->op, rd, imm) : 1;
}

static unsigned int asm_fmt_j(AsmState *s, const Opc *opc, int rd)
{
    if (!expr_parse(s))
        return 0;
    int imm = asm_resolve_pc_rel(s);
    if (s->phase.pass == 2)
    {
        if (imm & 1)
        {
            phase_error(s, "MISALIGNED JUMP TARGET");
            return 0;
        }
        if (!asm_imm_range(s, imm, -1048576, 1048574))
            return 0;
        return enc_j(opc->op, rd, imm);
    }
    return 1;
}

/* Main dispatch */

typedef void (*AsmFn)(AsmState *s);

typedef struct
{
    const char *name;
    AsmFn fn;
} AsmEntry;

static const AsmEntry g_directives[] = {
    {".org", dir_org},
    {".byte", dir_byte},
    {".word", dir_word},
    {".ascii", dir_ascii},
    {".asciz", dir_ascii},
    {".asciiz", dir_ascii},
    {".align", dir_align},
    {".space", dir_space},
    {".fill", dir_fill},
    {".text", dir_section},
    {".data", dir_section},
    {".section", dir_section},
    {".equ", dir_equ},
    {0}};

static const AsmEntry g_pseudos[] = {
    {"li", pseudo_li_la},
    {"la", pseudo_li_la},
    {"mv", pseudo_mv},
    {"nop", pseudo_nop},
    {"j", pseudo_j},
    {"call", pseudo_call},
    {"jr", pseudo_jr},
    {"ret", pseudo_ret},
    {0}};

static const AsmEntry *asm_lookup(const AsmEntry *tbl, const char *name)
{
    for (int i = 0; tbl[i].name; i++)
        if (!strcmp(tbl[i].name, name))
            return &tbl[i];
    return NULL;
}

void asm_assemble(AsmState *s)
{
    if (s->lex.type == T_EOF)
        return;

    /* Label */
    if (s->lex.type == T_IDENT && asm_handle_label(s))
        return;

    /* Directives */
    if (s->lex.buf[0] == '.')
    {
        const AsmEntry *d = asm_lookup(g_directives, s->lex.buf);
        if (!d)
        {
            phase_error(s, "UNKNOWN DIRECTIVE");
            return;
        }
        d->fn(s);
        return;
    }

    /* Pseudo-instructions */
    const AsmEntry *p = asm_lookup(g_pseudos, s->lex.buf);
    if (p)
    {
        p->fn(s);
        return;
    }

    /* Real instruction */
    const Opc *opc = opc_find(s->lex.buf);
    if (!opc)
    {
        phase_error(s, "UNKNOWN OPCODE");
        lex_skip_line(s);
        return;
    }
    lex_next(s);

    unsigned int word = 0;
    int rd = 0;

    int has_rd = (opc->fmt == R || opc->fmt == I || opc->fmt == U || opc->fmt == J);
    if (has_rd)
    {
        rd = asm_parse_rd(s);
        if (rd < 0)
            return;
    }

    switch (opc->fmt)
    {
    case R:
        word = asm_fmt_r(s, opc, rd);
        break;
    case I:
        word = asm_fmt_i(s, opc, rd);
        break;
    case S:
        word = asm_fmt_s(s, opc);
        break;
    case B:
        word = asm_fmt_b(s, opc);
        break;
    case U:
        word = asm_fmt_u(s, opc, rd);
        break;
    case J:
        word = asm_fmt_j(s, opc, rd);
        break;
    }

    if (word == 0 && s->phase.errors)
        return;

    if (s->phase.pass == 2 && word)
        out_emit_word(s, word);
    s->out.pc += 4;
    asm_check_trailing(s);
}