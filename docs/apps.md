# Vemu Apps

Vemu bundles two development tools: **PICO**, a text editor, and **ASM**, a
RISC-V assembler. Together they form an edit, assemble, and run workflow.

## PICO
PICO is a full-screen text editor built on the CP/M Neo SDK. It can open, edit, and save text files.

<img src="images/pico-preview.png" alt="boot process" width="100%">

### Usage

```text
PICO <FILENAME>       Open an existing file (or start a new one)
PICO C <FILENAME>     Create a new empty file (errors if it already exists)
PICO                  Start an empty, unnamed buffer
```

### Key bindings

| Keys | Action |
| --- | --- |
| **Ctrl+O** | Open a file (prompts for the filename) |
| **Ctrl+S** | Save the file. Prompts `Save as:` for an unnamed buffer, otherwise writes to the current filename |
| **Ctrl+Q** | Quit. Prompts to save if the buffer has unsaved changes |
| **Arrow keys** | Move the cursor up, down, left, or right |
| Any other key | Insert or type text |


## ASM

A two-pass assembler supporting the **RV32I** instruction set plus the **M**
(multiply/divide) extension. Output is a flat `.COM` executable.

### Usage

```text
ASM <FILE.S>
ASM <FILE.ASM>
```

### Syscall interface

Programs communicate with the operating system through a syscall table located
at `%SYSCALL`. Please refer to the [Syscall reference](https://github.com/Mazin-O3/cpm-neo/blob/main/docs/syscall-reference.md) for more detail.

### Program skeleton

All `.COM` programs **must** begin at `.org 0x100`.

```asm
; HELLO.S

.org 0x100

main:
    li   a0, 1
    la   a1, hello
    li   a2, 14

    la   t1, %SYSCALL
    lw   t2, 8(t1)          ; syscall slot 2: write
    jalr ra, 0(t2)

    li   a0, 0
    la   t1, %SYSCALL
    lw   t2, 16(t1)         ; syscall slot 4: exit
    jalr ra, 0(t2)

hello:
    .asciiz "Hello, World!\n"
```

### Instructions and directives

| Category | Items |
| --- | --- |
| **RV32I** | `lb lh lw lbu lhu sb sh sw`<br><br>`addi slti sltiu xori ori andi slli srli srai`<br><br>`add sub sll slt sltu xor srl sra or and`<br><br>`beq bne blt bge bltu bgeu`<br><br>`jal jalr`<br><br>`lui auipc` |
| **M Extension** | `mul mulh mulhsu mulhu div divu rem remu` |
| **Pseudo** | `li`, `la`, `mv`, `nop`, `j`, `call`, `jr`, `ret` |
| **Directives** | `.org`, `.byte`, `.word`, `.ascii`, `.asciiz`, `.asciz`, `.align`, `.equ`, `.space`, `.fill`, `.text`, `.data`, `.section` |

**Directives**

| Directive | Description |
| --- | --- |
| `.org ADDR` | Set the current output address |
| `.byte V[, V...]` | Emit raw bytes |
| `.word V[, V...]` | Emit 32-bit words |
| `.ascii "STR"` | Emit string bytes (no terminator) |
| `.asciiz "STR"` | Emit string bytes plus a null terminator |
| `.asciz "STR"` | Alias of `.asciiz` |
| `.align N` | Pad with zeros to a `2^N` boundary |
| `.equ NAME, V` | Define a constant (no forward references) |
| `.space COUNT [, FILL]` | Reserve `COUNT` bytes, each set to `FILL` (default `0`). Handy for allocating stacks and buffers |
| `.fill COUNT [, SIZE] [, VALUE]` | Emit `COUNT` copies of `VALUE` written as `SIZE` little-endian bytes (defaults `SIZE=1`, `VALUE=0`) |
| `.text` / `.data` / `.section` | Accepted for compatibility; ignored (single flat output segment) |

**Limits**

- Maximum 128 labels
- Maximum 128 characters per source line
- `.equ` does not allow forward references

### Example: `FIB.S`

Prints the first ten Fibonacci numbers while demonstrating stack setup,
procedures, and console output.

```asm
.org 0x100

main:
    la   sp, stack_top
    li   s0, 0
    li   s1, 1
    li   s2, 10

loop:
    beq  s2, zero, done

    mv   a0, s0
    call print_hex

    li   a0, 32
    call putc

    add  s3, s0, s1
    mv   s0, s1
    mv   s1, s3

    addi s2, s2, -1
    j    loop

done:
    li   a0, 10
    call putc

    li   a0, 0
    la   t1, %SYSCALL
    lw   t2, 16(t1)
    jalr ra, 0(t2)

putc:
    addi sp, sp, -16
    sw   ra, 12(sp)

    la   t0, chbuf
    sb   a0, 0(t0)

    li   a0, 1
    mv   a1, t0
    li   a2, 1

    la   t1, %SYSCALL
    lw   t2, 8(t1)
    jalr ra, 0(t2)

    lw   ra, 12(sp)
    addi sp, sp, 16
    ret

print_hex:
    addi sp, sp, -16
    sw   ra, 12(sp)
    sw   s0, 8(sp)          # Save caller's s0
    sw   s1, 4(sp)          # Save caller's s1

    mv   s0, a0
    li   s1, 8

ph_loop:
    srli t0, s0, 28
    andi t0, t0, 15
    addi t0, t0, 48

    slti t1, t0, 58
    bne  t1, zero, ph_digit
    addi t0, t0, 7

ph_digit:
    mv   a0, t0
    call putc

    slli s0, s0, 4
    addi s1, s1, -1
    bne  s1, zero, ph_loop

    lw   ra, 12(sp)
    lw   s0, 8(sp)          # Restore caller's s0
    lw   s1, 4(sp)          # Restore caller's s1
    addi sp, sp, 16
    ret

    .align 4

chbuf:
    .byte 0

    .align 4
stack_lo:
    .space 128
stack_top:
```
