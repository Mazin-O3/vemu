/* Assembler expression evaluator and label resolution. */

#include "asm.h"

int expr_resolve_label(AsmState *s)
{
    int si = sym_find(s, s->expr.label);
    if (si >= 0)
        return s->sym.val[si];

    if (s->phase.pass == 2)
        phase_error(s, "UNDEFINED LABEL");

    return 0;
}

int expr_parse(AsmState *s)
{
    s->expr.known = 1;
    s->expr.is_label = 0;
    s->expr.label[0] = 0;
    int neg = 0;

    if (s->lex.type == T_MINUS)
    {
        neg = 1;
        lex_next(s);
    }
    else if (s->lex.type == T_PLUS)
        lex_next(s);

    if (s->lex.type == T_NUM)
    {
        s->expr.val = neg ? -s->lex.num : s->lex.num;
        lex_next(s);
        return 1;
    }

    if (s->lex.type == T_IDENT)
    {
        s->expr.is_label = 1;
        int si = sym_find(s, s->lex.buf);
        if (si >= 0)
        {
            s->expr.val = neg ? -s->sym.val[si] : s->sym.val[si];
            s->expr.known = 1;
        }
        else
        {
            s->expr.known = 0;
            strncpy(s->expr.label, s->lex.buf, ASM_LINE_SZ - 1);
            s->expr.label[ASM_LINE_SZ - 1] = 0;
            s->expr.val = 0;
        }

        lex_next(s);
        return 1;
    }

    phase_error(s, "EXPRESSION EXPECTED");
    return 0;
}