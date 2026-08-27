/* ASM .COM entry point — loads .asm/.s, runs two-pass assemble, writes .COM. */

#include "asm.h"

static void rd_reset(AsmState *s, int fd)
{
    s->rd.fd = fd;
    s->rd.pos = 0;
    s->rd.avail = 0;
    s->rd.line_num = 0;
}

static int rd_getc(AsmState *s)
{
    if (s->rd.pos >= s->rd.avail)
    {
        s->rd.avail = read(s->rd.fd, s->rd.buf, RD_BUF_SZ);
        s->rd.pos = 0;
        if (s->rd.avail <= 0)
            return -1;
    }

    return s->rd.buf[s->rd.pos++];
}

static int next_line(AsmState *s)
{
    int pos = 0;
    int c;

    while ((c = rd_getc(s)) >= 0)
    {
        if (c == '\n')
        {
            s->lex.line_buf[pos] = 0;
            s->lex.line_num = ++s->rd.line_num;
            return 0;
        }

        if (c != '\r' && pos < ASM_LINE_SZ - 1)
            s->lex.line_buf[pos++] = c;
    }

    if (pos > 0)
    {
        s->lex.line_buf[pos] = 0;
        s->lex.line_num = ++s->rd.line_num;
        return 0;
    }

    return -1;
}

void phase_error(AsmState *s, const char *msg)
{
    printf("?%s IN LINE %d\n", msg, s->lex.line_num);
    s->phase.errors++;
}

void phase_pass1(AsmState *s, int fd)
{
    s->phase.pass = 1;
    s->sym.cnt = 0;
    s->out.pc = 0;
    s->out.fd = -1;
    rd_reset(s, fd);

    while (next_line(s) == 0)
    {
        s->lex.p = s->lex.line_buf;
        lex_next(s);
        asm_assemble(s);
    }
}

void phase_pass2(AsmState *s, int fd)
{
    s->phase.pass = 2;
    s->out.len = 0;
    s->out.pc = 0;
    rd_reset(s, fd);
    while (next_line(s) == 0)
    {
        s->lex.p = s->lex.line_buf;
        lex_next(s);
        asm_assemble(s);
    }
}

int main(int argc, char **argv)
{
    static AsmState s;

    if (argc != 2)
    {
        printf("Usage: ASM <FILE.ASM | FILE.S>\n");
        return 1;
    }

    const char *fn = argv[1];
    const char *dot = strrchr(fn, '.');
    const char *ext = (dot && dot[1] != '\0') ? dot + 1 : NULL;
    if (!ext || (strcasecmp(ext, "asm") && strcasecmp(ext, "s")))
    {
        printf("?BAD FILE TYPE\n");
        return 1;
    }

    int fd = open(fn, "r");
    if (fd < 0)
    {
        printf("?CANNOT READ %s\n", fn);
        return 1;
    }

    s.phase.errors = 0;
    s.out.org = 0;
    phase_pass1(&s, fd);
    close(fd);

    if (s.phase.errors)
    {
        printf("\n  %d ERROR(S)\n", s.phase.errors);
        return 1;
    }

    fd = open(fn, "r");
    if (fd < 0)
    {
        printf("?CANNOT READ %s\n", fn);
        return 1;
    }

    char out[FILENAME_MAX + 4];
    int len = strrchr(fn, '.') - fn;
    memcpy(out, fn, len);

    out[len] = 0;
    strcpy(out + len, ".COM");

    const char *tmp = "$$ASM.TMP";
    int tmpfd = open(tmp, "w");

    if (tmpfd < 0)
    {
        close(fd);
        const char *msg = (tmpfd == EFILERO) ? "File R/O" : "VOL R/O";
        printf("?%s: %s\n", tmp, msg);
        return 1;
    }

    s.out.fd = tmpfd;
    s.out.total = 0;
    s.out.err = 0;
    s.out.len = 0;

    phase_pass2(&s, fd);
    close(fd);

    if (s.phase.errors || s.out.err)
    {
        close(tmpfd);
        remove(tmp);
        printf("\n  %d ERROR(S)\n", s.phase.errors);
        return 1;
    }

    out_flush(&s);
    close(tmpfd);

    remove(out);

    if (rename(tmp, out) < 0)
    {
        printf("?%s: CANNOT WRITE\n", out);
        return 1;
    }

    return 0;
}