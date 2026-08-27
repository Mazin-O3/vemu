/* Symbol table for the assembler. */

#include "asm.h"

int sym_find(AsmState *s, const char *name)
{
    for (int i = 0; i < s->sym.cnt; i++)
        if (!strcmp(name, s->sym.name[i]))
            return i;
    return -1;
}

int sym_add(AsmState *s, const char *name, int val)
{
    if (s->sym.cnt >= MAX_SYMS)
    {
        phase_error(s, "SYMBOL TABLE FULL");
        return -1;
    }

    /* Truncating would silently merge distinct long names; refuse instead. */
    if ((int)strlen(name) >= SYM_SZ)
    {
        phase_error(s, "SYMBOL NAME TOO LONG");
        return -1;
    }

    strcpy(s->sym.name[s->sym.cnt], name);
    s->sym.val[s->sym.cnt] = val;

    return s->sym.cnt++;
}