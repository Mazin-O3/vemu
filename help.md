# Vemu

Vemu is an 8-bit inspired RISC-V computer emulator, designed to give a simple environment for learning about computer architecture and operating systems. Try **type welcome.txt** to get started.

## Boot Process

CP/M Neo follows a unified boot sequence across all storage configurations:

* **Bootloader**: Initializes hardware and hands off control to the Kernel.
* **Kernel**: Initializes system services and starts the **Console Command Processor (CCP)**.

Code Execution Modes:

* **Disk Mode:** Copies code into RAM before execution.
* **Flash Mode:** Uses Execute-In-Place (XIP) to execute code directly from the Flash window.

<img src="images/boot-process.png" alt="Boot process diagram" width="100%">

## OS Architecture

CP/M Neo is a single-user, single-tasking operating system — it runs only one program at a time, and that program has full access to memory above `0x0100`. Think of it as a small workshop where you clear the bench for each new project.

<img src="images/os-arch.png" alt="os layers" width="100%">

<br>

- **Memory layout — The workbench**: The Transient Program Area (TPA) runs from `0x0100` up to kernel region. Memory-mapped I/O occupies `0xFF00-0xFFFF` — the wall of dials and switches at the back of the shop.
- **Syscalls — Ringing the bell**: Programs request OS services (open a file, print text, read the keyboard) by calling through a syscall table in kernel memory — like ringing for the supervisor.
- **Environment — Four hooks by the door**: 3 kernel-managed memory slots plus a user slot. Slot 0 holds the syscall table pointer. Slot 1 stores the exit code of the last program. Slot 2 stores the SUBMIT batch offset — the CCP resumes batch from where it left off after each program reload. Slot 3 is free for user programs.
- **Volumes — The storage room map**: The disk is a grid of fixed-size 1 KB blocks. The four volumes (A:–D:) are pre-provisioned from it — each volume gets an equal share — and all four are mounted at boot. Use `SET X: MT` to mount an unmounted volume, `SET X: EX N` to extend it by N KB (blocks), or `SET X: UM N` to shrink it.
- **One program at a time**: One program runs at a time. Running a program overwrites the CCP. When it exits, the kernel reloads the CCP from disk.

## File System

CP/M Neo uses a filesystem inspired by CP/M's BDOS. The disk is divided into **fixed-size 1 KB blocks**. The **4 logical volumes** (A:-D:) are split equally from that block grid, and each volume is formatted and mounted at boot. A volume map (VMAP) records each volume's extents (contiguous runs of blocks) in the disk metadata.

- **User areas — the private rooms**: 16 numbered workspaces (0-15) per volume. Switch with `USER n`.
- **Format — the card catalog**: An extent-based BDOS with 32-byte directory entries. Each extent holds 8 blocks (8 KB), and a file can span up to 256 extents — a 2 MB maximum per volume.
- **8.3 filenames — the book spine**: A filename can have up to 8 characters for the name and 3 characters for the extension. Examples: `HELLO.TXT`, `GAME.BAS`.
- **Max 256 files** per volume: one 256-entry root directory, with each entry tagged with its user area.

<img src="images/disk-format.png" alt="Disk format" width="100%">
