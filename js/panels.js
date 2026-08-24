import { wasm, bootBin } from './main.js';
import {
    DISK_SECTOR_SIZE, VOL_MAX, BD_ROOT_ENTRIES, BD_ENTRY_SIZE, getVmap, volumeStats
} from './bdos.js';

const REG_NAMES = ["zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2"
                   , "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5"
                   , "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7"
                   , "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6"];
const S0_KERN_LOAD = 0x006;
const S0_KERN_SIZE = 0x00A;

let prevRegs = new Array(32)
    .fill(0);
let regFlashTimers = new Array(32)
    .fill(null);
let regEls = null;

let DISK_BASE = null
    , DISK_BUFFER = null
    , DISK_SECTOR = null;
let KBD_BASE = null
    , KBD_DATA = null
    , KBD_STAT = null;
let DSP_BASE = null
    , DSP_DATA = null;
let CLK_BASE = null
    , CLK_KHZ = null;
let TIMER_BASE = null
    , TIMER_CSTR = null
    , TIMER_CNTR = null;
let DMA_BASE = null
    , DMA_SAR = null
    , DMA_DAR = null
    , DMA_WCR = null
    , DMA_CSTR = null;

function inRange(addr, base, size) {
    return addr >= base && addr < base + size;
}
const memFlash = [];
let manualAddr = null;

export function initRegGrid() {
    const grid = document.getElementById('cpu-regs');
    let html = '';
    for (let i = 0; i < 32; i += 2) {
        html += '<span class="r"><span class="rid">x' + i + '</span> (' + REG_NAMES[i] + ')</span><span class="v" id="reg-' + i + '">0x00000000</span>';
        html += '<span class="r"><span class="rid">x' + (i + 1) + '</span> (' + REG_NAMES[i + 1] + ')</span><span class="v" id="reg-' + (i + 1) + '">0x00000000</span>';
    }
    grid.innerHTML = html;
    regEls = [];
    for (let i = 0; i < 32; i++) regEls[i] = document.getElementById('reg-' + i);
}

function resolveDestName(addr) {
    if (inRange(addr, DISK_BUFFER, 1)) return 'DISK_BUFFER';
    if (inRange(addr, DISK_SECTOR, 2)) return 'DISK_SECTOR';
    if (inRange(addr, KBD_DATA, 1)) return 'KBD_DATA';
    if (inRange(addr, KBD_STAT, 1)) return 'KBD_STAT';
    if (inRange(addr, DSP_DATA, 1)) return 'DSP_DATA';
    if (inRange(addr, CLK_KHZ, 2)) return 'CLK_KHZ';
    if (inRange(addr, TIMER_CSTR, 1)) return 'TIMER_CSTR';
    if (inRange(addr, TIMER_CNTR, 2)) return 'TIMER_CNTR';
    if (inRange(addr, DMA_SAR, 2)) return 'DMA_SAR';
    if (inRange(addr, DMA_DAR, 2)) return 'DMA_DAR';
    if (inRange(addr, DMA_WCR, 2)) return 'DMA_WCR';
    if (inRange(addr, DMA_CSTR, 1)) return 'DMA_CSTR';
    if (addr >= 0xFF00) return 'I/O';
    return 'RAM';
}

function busTx(i) {
    const srcKind = wasm.veecore_bus_tx_source_kind(i);
    const dstAddr = wasm.veecore_bus_tx_dest_addr(i);
    const isWrite = wasm.veecore_bus_tx_access_type(i);
    return {
        srcName: ['CPU', 'DMA'][srcKind] || '?',
        dstAddr: dstAddr,
        dstName: resolveDestName(dstAddr),
        arrow: isWrite ? '→' : '←',
        isWrite: isWrite
    };
}

export function updatePanels() {
    if (!wasm) return;
    
    updateMemoryMap();
    
    if (DISK_BASE === null) {
        DISK_BASE = wasm.veecore_disk_base();
        DISK_BUFFER = DISK_BASE;
        DISK_SECTOR = DISK_BASE + 2;
        KBD_BASE = wasm.veecore_kbd_base();
        KBD_DATA = KBD_BASE;
        KBD_STAT = KBD_BASE + 4;
        DSP_BASE = wasm.veecore_dsp_base();
        DSP_DATA = DSP_BASE;
        CLK_BASE = wasm.veecore_clk_base();
        CLK_KHZ = CLK_BASE;
        TIMER_BASE = wasm.veecore_timer_base();
        TIMER_CSTR = TIMER_BASE;
        TIMER_CNTR = TIMER_BASE + 2;
        DMA_BASE = wasm.veecore_dma_base();
        DMA_SAR = DMA_BASE;
        DMA_DAR = DMA_BASE + 2;
        DMA_WCR = DMA_BASE + 4;
        DMA_CSTR = DMA_BASE + 6;
    }
    
    const pc = wasm.veecore_pc();
    const pcHex = '0x' + pc.toString(16)
        .toUpperCase()
        .padStart(8, '0');
    document.getElementById('cpu-pc')
        .textContent = pcHex;
    const disasmPtr = wasm.veecore_disasm();
    const disasmLen = wasm.veecore_disasm_len();
    const disasmBytes = new Uint8Array(wasm.memory.buffer, disasmPtr, disasmLen);
    const instr = new TextDecoder()
        .decode(disasmBytes);
    document.getElementById('cpu-inst')
        .textContent = instr;
    document.getElementById('cpu-hdr-status')
        .textContent = instr + ' | PC ' + pcHex;
    
    if (regEls) {
        for (let i = 0; i < 32; i++) {
            const v = wasm.veecore_reg(i) >>> 0;
            const el = regEls[i];
            el.textContent = '0x' + v.toString(16)
                .toUpperCase()
                .padStart(8, '0');
            if (prevRegs[i] !== v) {
                prevRegs[i] = v;
                el.classList.add('reg-flash');
                if (regFlashTimers[i]) clearTimeout(regFlashTimers[i]);
                regFlashTimers[i] = setTimeout(() => { el.classList.remove('reg-flash'); }, 200);
            }
        }
    }
    
    // DMA
    const stepNames = ['Byte', 'HalfWord', 'Word'];
    const sar = wasm.veecore_dma_byte(DMA_SAR) | (wasm.veecore_dma_byte(DMA_SAR + 1) << 8);
    const dar = wasm.veecore_dma_byte(DMA_DAR) | (wasm.veecore_dma_byte(DMA_DAR + 1) << 8);
    let wcr = wasm.veecore_dma_byte(DMA_WCR) | (wasm.veecore_dma_byte(DMA_WCR + 1) << 8);
    const cstr = wasm.veecore_dma_byte(DMA_CSTR);
    const active = !!(cstr & 1);
    const stream = !!(cstr & 2);
    const step = wasm.veecore_dma_step();
    const el = document.getElementById('dma-ch');
    el.innerHTML = '<div class="dma-row"><span class="dma-label">State</span><span class="dma-val">' + (active ? 'Active' : 'Idle') + '</span></div>' +
        '<div class="dma-row"><span class="dma-label">Source</span><span class="dma-val l1">0x' + sar.toString(16)
        .padStart(4, '0') + ' <span class="dma-ctx">(' + resolveDestName(sar) + ')</span></span></div>' +
        '<div class="dma-row"><span class="dma-label">Destination</span><span class="dma-val warn">0x' + dar.toString(16)
        .padStart(4, '0') + ' <span class="dma-ctx">(' + resolveDestName(dar) + ')</span></span></div>' +
        '<div class="dma-row"><span class="dma-label">Bytes</span><span class="dma-val">' + wcr + '</span></div>' +
        '<div class="dma-row"><span class="dma-label">Step</span><span class="dma-val">' + (1 << step) + ' (' + stepNames[step] + ')</span></div>' +
        '<div class="dma-row"><span class="dma-label">Mode</span><span class="dma-val">' + (stream ? 'Stream' : 'Normal') + '</span></div>';
    
    // DMA state badge
    {
        const state = active ? 'Active' : 'Idle';
        document.getElementById('dma-state')
            .textContent = state;
    }
    
    // Timer
    const timerCstr = wasm.veecore_timer_cstr();
    const timerCntr = wasm.veecore_timer_cntr();
    document.getElementById('timer-cntr')
        .textContent = timerCntr.toLocaleString();
    const timerRunning = timerCstr & 1;
    const modeBit = timerCstr & 2;
    const overflow = timerCstr & 4;
    const prescIdx = (timerCstr >> 4) & 3;
    const prescNames = ['1', '8', '64', '256'];
    const stateText = overflow ? 'Overflow' : (timerRunning ? 'Running' : 'Stopped');
    const modeText = modeBit ? 'One-shot' : 'Continuous';
    
    const timerModeEl = document.getElementById('timer-mode');
    timerModeEl.textContent = stateText + ' (' + modeText + ')';
    
    timerModeEl.classList.remove('text-warn', 'text-l1', 'text-l3');
    if (overflow) timerModeEl.classList.add('text-warn');
    else if (timerRunning) timerModeEl.classList.add('text-l1');
    else timerModeEl.classList.add('text-l3');
    
    document.getElementById('timer-prescale')
        .textContent = prescNames[prescIdx];
    
    // Timer badge
    const timerBadge = document.getElementById('timer-badge');
    if (timerCstr & 4) {
        timerBadge.textContent = 'Overflow';
    } else if (timerCstr & 1) {
        timerBadge.textContent = 'Running';
    } else {
        timerBadge.textContent = 'Stopped';
    }
    
    // Disk
    document.getElementById('disk-sector')
        .textContent = wasm.veecore_disk_sector();
    document.getElementById('disk-offset')
        .textContent = wasm.veecore_disk_offset();
    const diskState = wasm.veecore_disk_state();
    const diskStates = ['Idle', 'Buffer Write (BFWR)', 'Buffer Read (BFRD)', 'Disk Read (DISKR)', 'Disk Write (DISKW)'];
    const diskStateEl = document.getElementById('disk-state');
    diskStateEl.textContent = diskStates[diskState];
    
    diskStateEl.classList.remove('text-l1', 'text-l3');
    diskStateEl.classList.add(diskState ? 'text-l1' : 'text-l3');
    document.getElementById('disk-state-badge')
        .textContent = diskStates[diskState];
    
    // Volume stats
    updateVolumeStats();
    
    // Bus
    const txCount = wasm.veecore_bus_tx_count();
    const txList = document.getElementById('bus-tx-list');
    const txItems = [];
    for (let i = 0; i < txCount && i < 64; i++) {
        const t = busTx(i);
        txItems.push('<div class="bus-tx-entry"><span class="bus-tx-src">' + t.srcName + '</span><span class="bus-tx-arrow">' + t.arrow + '</span><span class="bus-tx-addr">0x' + t.dstAddr.toString(16)
            .toUpperCase() + '</span><span class="bus-tx-dst">' + t.dstName + '</span><span class="bus-tx-type ' + (t.isWrite ? 'w' : 'r') + '">' + (t.isWrite ? '(Write)' : '(Read)') + '</span></div>');
    }
    txList.innerHTML = txItems.join('');
    
    // Bus last transaction badge
    const busTxBadge = document.getElementById('bus-last-tx');
    if (txCount > 0) {
        const t = busTx(0);
        busTxBadge.innerHTML = '<span>' + t.srcName + ' <span class="ba">' + t.arrow + '</span> 0x' + t.dstAddr.toString(16)
            .toUpperCase() + ' ' + t.dstName + ' ' + (t.isWrite ? '(Write)' : '(Read)') + '</span>';
    } else {
        busTxBadge.textContent = '—';
    }
    
    updateMemView();
}

function memGoto(val) {
    const v = parseInt(val, 16);
    if (!isNaN(v)) {
        manualAddr = v & 0xFFFF;
    } else {
        manualAddr = null;
    }
    updateMemView();
}

function updateMemView() {
    if (!wasm) return;
    let addr = manualAddr;
    if (addr === null) {
        addr = (wasm.veecore_last_mem_addr() & 0xFFFF) & 0xFFF0;
        const el = document.getElementById('mem-goto');
        if (document.activeElement !== el) {
            el.value = '0x' + addr.toString(16)
                .padStart(4, '0')
                .toUpperCase();
        }
    }
    const memAddr = wasm.veecore_last_mem_addr() & 0xFFFF;
    const memSize = wasm.veecore_last_mem_size();
    const memWrite = wasm.veecore_last_mem_write();
    
    const now = performance.now();
    if (memSize > 0) {
        memFlash.push({ addr: memAddr, size: memSize, write: memWrite, time: now });
    }
    while (memFlash.length > 0 && memFlash[0].time < now - 300) {
        memFlash.shift();
    }
    
    function isFlashing(a) {
        for (let i = 0; i < memFlash.length; i++) {
            const f = memFlash[i];
            if (a >= f.addr && a < f.addr + f.size) return f.write ? 'mem-highlight-write' : 'mem-highlight-read';
        }
        return '';
    }
    
    let html = '';
    for (let r = 0; r < 8; r++) {
        const a = (addr + r * 16) & 0xFFFF;
        let bytes = '';
        for (let c = 0; c < 16; c++) {
            const addr2 = a + c;
            const b = wasm.veecore_ram_byte(addr2);
            const cls = isFlashing(addr2);
            bytes += (cls ? '<span class="' + cls + '">' : '') +
                b.toString(16)
                .padStart(2, '0')
                .toUpperCase() +
                (cls ? '</span>' : '') + ' ';
            if (c === 7) bytes += ' ';
        }
        html += '<div class="mem-row"><span class="mem-addr">' + a.toString(16)
            .padStart(4, '0')
            .toUpperCase() + ': </span><span class="mem-bytes">' + bytes + '</span></div>';
    }
    document.getElementById('mem-view')
        .innerHTML = html;
}

let mmapInit = false;

/* RAM map rows are dynamic: the kernel sits at the address recorded in disk
 * sector 0 (S0_KERN_LOAD), which varies per build. Read it once so the map
 * always matches the loaded image. */
function updateMemoryMap() {
    if (mmapInit) return;
    var diskPtr = wasm.veecore_disk_ptr();
    var diskLen = wasm.veecore_disk_len();
    if (diskLen < DISK_SECTOR_SIZE) return;
    var s0 = new Uint8Array(wasm.memory.buffer, diskPtr, DISK_SECTOR_SIZE);
    var kernBase = s0[S0_KERN_LOAD] | (s0[S0_KERN_LOAD + 1] << 8) |
        (s0[S0_KERN_LOAD + 2] << 16) | (s0[S0_KERN_LOAD + 3] << 24);
    var kernSize = s0[S0_KERN_SIZE] | (s0[S0_KERN_SIZE + 1] << 8) |
        (s0[S0_KERN_SIZE + 2] << 16) | (s0[S0_KERN_SIZE + 3] << 24);
    if (kernBase < 0x0100 || kernBase >= 0xFF00) return;
    if (kernSize <= 0 || kernBase + kernSize > 0x10000) return;
    mmapInit = true;
    
    function hex4(v) {
        return '0x' + v.toString(16)
            .toUpperCase()
            .padStart(4, '0');
    }
    
    document.getElementById('mmap-user-addr')
        .textContent = hex4(0x0100) + '–' + hex4(kernBase - 1);
    document.getElementById('mmap-user-size')
        .textContent = Math.floor((kernBase - 0x0100) / 1024) + ' KB';
    document.getElementById('mmap-kern-addr')
        .textContent = hex4(kernBase) + '–' + hex4(kernBase + kernSize - 1);
    document.getElementById('mmap-kern-size')
        .textContent = (kernSize / 1024)
        .toFixed(1) + ' KB';

    if (bootBin && bootBin.length > 0) {
        document.getElementById('mmap-boot-addr')
            .textContent = '0x0000–' + hex4(bootBin.length - 1);
        document.getElementById('mmap-boot-size')
            .textContent = bootBin.length < 1024
            ? bootBin.length + ' B'
            : (bootBin.length / 1024)
                .toFixed(1) + ' KB';
    }
}

const VOL_CLASS = ['vol-a', 'vol-b', 'vol-c', 'vol-d'];
const VOL_LETTERS = ['A:', 'B:', 'C:', 'D:'];

let lastVolStatsTime = 0;

function updateVolumeStats() {
    var now = performance.now();
    if (now - lastVolStatsTime < 500) return;
    lastVolStatsTime = now;

    var host = document.getElementById('disk-volumes');
    var vmap = getVmap();
    if (!vmap) {
        host.innerHTML = '';
        return;
    }

    var usedTotal = 0;
    var rows = '';
    for (var v = 0; v < VOL_MAX; v++) {
        var st = volumeStats(vmap, v);
        if (!st.mounted) {
            rows += '<div class="vol-row vol-muted">' +
                '<span class="vol-name">' + VOL_LETTERS[v] + '</span>' +
                '<span class="vol-state">-</span>' +
                '<span class="vol-fill"><div class="vol-dots"></div></span>' +
                '<span class="vol-nums">Not Mounted</span>' +
                '</div>';
            continue;
        }
        var usedBlocks = st.totalBlocks - st.freeBlocks;
        usedTotal += usedBlocks;
        var pct = st.totalBlocks > 0 ? (usedBlocks / st.totalBlocks * 100) : 0;
        var fill = st.totalBlocks > 0 ? Math.min(100, Math.max(0, pct)) : 0;
        rows += '<div class="vol-row">' +
            '<span class="vol-name ' + VOL_CLASS[v] + '">' + VOL_LETTERS[v] + '</span>' +
            '<span class="vol-state">' + (st.ro ? 'R/O' : 'R/W') + '</span>' +
            '<span class="vol-fill"><div class="vol-fill-inner ' + VOL_CLASS[v] + '" style="width:' + fill.toFixed(1) + '%"></div></span>' +
            '<span class="vol-nums">' + usedBlocks + 'k / ' + st.totalBlocks + 'k</span>' +
            '</div>';
    }

    /* Overall usage: used across mounted volumes against the image's fixed
     * usable capacity. Mirrors the kernel's SYS disk_size_kb formula — the
     * raw block grid minus the per-volume reserved (volume header + root dir,
     * rounded to block size, plus the sentinel data block). */
    var rootSecs = Math.ceil(BD_ROOT_ENTRIES * BD_ENTRY_SIZE / DISK_SECTOR_SIZE);
    var hdrBlocks = Math.ceil((1 + rootSecs) / vmap.blockSecs);
    var fixedTotal = vmap.numBlocks - VOL_MAX * (hdrBlocks + 1);
    var upct = fixedTotal > 0 ? Math.min(100, Math.max(0, usedTotal / fixedTotal * 100)) : 0;
    rows += '<div class="vol-row usage-row">' +
        '<span class="vol-name usage-label">Usage</span>' +
        '<span class="vol-fill"><div class="vol-fill-inner usage-fill" style="width:' + upct.toFixed(1) + '%"></div></span>' +
        '<span class="vol-nums">' + usedTotal + 'k / ' + fixedTotal + 'k</span>' +
        '</div>';

    host.innerHTML = rows;
}

document.getElementById('mem-goto')
    .addEventListener('input', (e) => memGoto(e.target.value));
document.getElementById('mem-goto')
    .addEventListener('blur', () => {
        manualAddr = null;
        updatePanels();
    });
