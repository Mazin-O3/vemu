use alloc::vec::Vec;
use core::cmp;

/// Execute-in-Place (XIP) flash window geometry.
///
/// Mirrors cpm-neo/platform/vemu/config.sh:
///   XIP_BASE = flash window base address in the CPU's address space
///
/// There is no configured XIP_SIZE: the window is exactly the disk image —
/// the byte at CPU address `addr` in the window is image byte `addr - XIP_BASE`.
///
/// The window is a 1:1 read-only mapping of the disk image.  The kernel and
/// CCP execute in place from this window (see the XIP linker scripts in
/// cpm-neo), so the flash must look like plain linear memory to instruction
/// fetches and data loads.
pub const XIP_BASE: u32 = 0x10000;

/// Read-only XIP flash.  A private snapshot of the boot image, deliberately
/// separate from the Disk controller: disk sector writes (file uploads, the
/// running OS) can never alias or corrupt the executing image.
pub struct Flash {
    pub image: Vec<u8>,
    pub base: u32,
    pub size: u32,
}

impl Flash {
    /// Size the window to the disk image itself.
    pub fn new(image: Vec<u8>, base: u32) -> Self {
        let size = image.len() as u32;
        Flash { image, base, size }
    }

    /// Read a byte from the flash at window offset `off`.  Out-of-window
    /// reads return 0 (the region is zero-filled past the end of the image).
    pub fn read_b(&self, off: u32) -> u8 {
        let idx = off as usize;
        if idx >= self.image.len() {
            0
        } else {
            self.image[idx]
        }
    }

    /// Read a little-endian word from the flash at window offset `off`.
    /// Reads that cross the end of the image (or the end of the VMem window)
    /// are zero-padded instead of faulting.
    pub fn read_w(&self, off: u32) -> u32 {
        let start = off as usize;
        if start >= self.image.len() {
            return 0;
        }
        let end = cmp::min(start + 4, self.image.len());
        let mut v = [0u8; 4];
        v[..end - start].copy_from_slice(&self.image[start..end]);
        u32::from_le_bytes(v)
    }
}