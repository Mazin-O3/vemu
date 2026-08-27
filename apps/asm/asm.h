#ifndef ASM_H
#define ASM_H

#include <cpm.h>

#define ASM_LINE_SZ 128
#define MAX_SYMS 128
#define SYM_SZ 16
#define OUT_CHUNK_SZ 256
#define RD_BUF_SZ 512

enum
{
    T_NUM,
    T_IDENT,
    T_STR,
    T_COMMA,
    T_COLON,
    T_LPAREN,
    T_RPAREN,
    T_PLUS,
    T_MINUS,
    T_EOF
};
enum
{
    R,
    I,
    S,
    B,
    U,
    J
};

/* RISC-V opcodes */
#define OP_LUI 0x37
#define OP_AUIPC 0x17
#define OP_JAL 0x6F
#define OP_JALR 0x67
#define OP_BRANCH 0x63
#define OP_LOAD 0x03
#define OP_STORE 0x23
#define OP_ALU_I 0x13
#define OP_ALU_R 0x33
#define OP_MUL 0x33

/* Shift-immediate encoding */
#define BIT_SHIFT_5 0x400
#define SHIFT_MASK_5 0x1f
#define SHIFT_F7 0x20

/* Bit-field masks */
#define IMM_12_MASK 0xfff
#define IMM_5_MASK 0x1f
#define IMM_7_MASK 0x7f
#define IMM_6_MASK 0x3f
#define IMM_4_MASK 0x0f
#define IMM_20_MASK 0xfffff
#define IMM_10_MASK 0x3ff
#define IMM_8_MASK 0xff
#define ALIGN_MAX 32

typedef struct
{
    const char *name;
    int op, f3, f7, fmt;
} Opc;

typedef struct
{
    unsigned char data[OUT_CHUNK_SZ];
    int len, pc, org;
    int fd, total, err;
} AsmOut;

typedef struct
{
    char name[MAX_SYMS][SYM_SZ];
    int val[MAX_SYMS], cnt;
} AsmSym;

typedef struct
{
    char *p;
    char line_buf[ASM_LINE_SZ];
    char buf[ASM_LINE_SZ];
    int type, num, line_num;
} AsmLex;

typedef struct
{
    int val, known;
    int is_label; /* operand was a symbol (needs pc-relative offset) */
    char label[ASM_LINE_SZ];
} AsmExpr;

typedef struct
{
    int pass, errors;
} AsmPhase;

/* Buffered line reader over the currently open source file. */
typedef struct
{
    int fd;
    unsigned char buf[RD_BUF_SZ];
    int pos, avail;
    int line_num;
} AsmReader;

typedef struct
{
    AsmOut out;
    AsmSym sym;
    AsmLex lex;
    AsmExpr expr;
    AsmPhase phase;
    AsmReader rd;
} AsmState;

/* Error reporting and pass orchestration */
void         phase_error        (AsmState *s, const char *msg);
void         asm_assemble       (AsmState *s);
void         phase_pass1        (AsmState *s, int fd);
void         phase_pass2        (AsmState *s, int fd);

/* Tokeniser */
void         lex_next           (AsmState *s);
void         lex_skip_line      (AsmState *s);

/* Symbol table */
int          sym_find           (AsmState *s, const char *name);
int          sym_add            (AsmState *s, const char *name, int val);

/* Opcode lookup */
int          opc_reg_id         (const char *name);
const Opc *  opc_find           (const char *name);
int          opc_parse_reg      (AsmState *s);

/* Instruction encoding */
unsigned int enc_r              (int op, int rd, int f3, int rs1, int rs2, int f7);
unsigned int enc_i              (int op, int rd, int f3, int rs1, int imm);
unsigned int enc_s              (int op, int f3, int rs1, int rs2, int imm);
unsigned int enc_b              (int op, int f3, int rs1, int rs2, int imm);
unsigned int enc_u              (int op, int rd, int imm20);
unsigned int enc_j              (int op, int rd, int imm);

/* Code emission */
int          out_emit_byte      (AsmState *s, unsigned char b);
void         out_emit_word      (AsmState *s, unsigned int w);
void         out_flush          (AsmState *s);

/* Expression evaluation */
int          expr_parse         (AsmState *s);
int          expr_resolve_label (AsmState *s);

#endif