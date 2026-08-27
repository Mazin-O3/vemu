/* Assembler tokeniser. */

#include "asm.h"

/* Helpers */

static int lex_tokchar(int c)
{
    return isalnum((unsigned char)c) || c == '_' || c == '.';
}

static void lex_skip_space(AsmState *s)
{
    while (*s->lex.p && *s->lex.p <= ' ' && *s->lex.p != '\n')
        s->lex.p++;
}

static int lex_at_eol(AsmState *s)
{
    return !*s->lex.p || *s->lex.p == '\n';
}

static void lex_skip_comment(AsmState *s)
{
    while (*s->lex.p)
        s->lex.p++;
}

/* Token parsers */

static void lex_parse_number(AsmState *s)
{
    char *ep;
    s->lex.num = strtoi(s->lex.p, &ep, 0);
    int i = ep - s->lex.p;
    if (i > ASM_LINE_SZ - 1)
        i = ASM_LINE_SZ - 1;
    memcpy(s->lex.buf, s->lex.p, i);
    s->lex.buf[i] = 0;
    s->lex.p = ep;
    s->lex.type = T_NUM;
}

static void lex_parse_builtin(AsmState *s)
{
    s->lex.p++;
    int i = 0;
    while (isalnum((unsigned char)s->lex.p[i]) || s->lex.p[i] == '_')
    {
        if (i < ASM_LINE_SZ - 1)
            s->lex.buf[i] = s->lex.p[i];
        i++;
    }
    s->lex.buf[i < ASM_LINE_SZ ? i : ASM_LINE_SZ - 1] = 0;
    s->lex.p += i;

    if (!strcmp(s->lex.buf, "SYSCALL"))
    {
        s->lex.num = sys_getenv(ENV_SYSCALL_PTR);
        s->lex.type = T_NUM;
        return;
    }
    phase_error(s, "UNKNOWN BUILTIN");
    s->lex.type = T_EOF;
}

static void lex_parse_string(AsmState *s)
{
    s->lex.p++;
    int i = 0;
    while (*s->lex.p && *s->lex.p != '"')
    {
        if (*s->lex.p == '\n' || *s->lex.p == '\r')
        {
            phase_error(s, "UNTERMINATED STRING");
            break;
        }
        char c = *s->lex.p++;
        if (c == '\\' && *s->lex.p)
        {
            c = *s->lex.p++;
            if (c == 'n')
                c = '\n';
            else if (c == 't')
                c = '\t';
            else if (c == 'r')
                c = '\r';
            else if (c == '0')
                c = '\0';
        }
        if (i < ASM_LINE_SZ - 1)
            s->lex.buf[i++] = c;
    }
    s->lex.buf[i] = 0;
    if (*s->lex.p == '"')
        s->lex.p++;
    s->lex.type = T_STR;
}

static void lex_parse_ident(AsmState *s)
{
    int i = 0;
    while (lex_tokchar(s->lex.p[i]) && i < ASM_LINE_SZ - 1)
    {
        s->lex.buf[i] = s->lex.p[i];
        i++;
    }
    s->lex.buf[i] = 0;
    s->lex.p += i;
    s->lex.type = T_IDENT;
}

static int lex_parse_char(AsmState *s)
{
    s->lex.buf[0] = *s->lex.p;
    s->lex.buf[1] = 0;
    switch (*s->lex.p)
    {
    case ',':
        s->lex.type = T_COMMA;
        break;
    case ':':
        s->lex.type = T_COLON;
        break;
    case '(':
        s->lex.type = T_LPAREN;
        break;
    case ')':
        s->lex.type = T_RPAREN;
        break;
    case '+':
        s->lex.type = T_PLUS;
        break;
    case '-':
        s->lex.type = T_MINUS;
        break;
    default:
        phase_error(s, "SYNTAX ERROR");
        s->lex.type = T_EOF;
        return 0;
    }
    s->lex.p++;
    return 1;
}

/* Main tokeniser */

void lex_next(AsmState *s)
{
    lex_skip_space(s);

    if (lex_at_eol(s) || *s->lex.p == ';' || *s->lex.p == '#')
    {
        if (*s->lex.p == ';' || *s->lex.p == '#')
            lex_skip_comment(s);
        s->lex.type = T_EOF;
        s->lex.buf[0] = 0;
        return;
    }

    if (isdigit((unsigned char)*s->lex.p))
    {
        lex_parse_number(s);
        return;
    }

    if (*s->lex.p == '%')
    {
        lex_parse_builtin(s);
        return;
    }

    if (*s->lex.p == '"')
    {
        lex_parse_string(s);
        return;
    }

    if (lex_tokchar(*s->lex.p))
    {
        lex_parse_ident(s);
        return;
    }

    lex_parse_char(s);
}

void lex_skip_line(AsmState *s)
{
    lex_skip_comment(s);
}