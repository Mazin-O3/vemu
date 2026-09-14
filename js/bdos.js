import { wasm } from './main.js';
import { forceScheduleDiskSave, setDiskDirty } from './storage.js';

let uploadFiles = [];

/* ── Sector 0 layout (v2 — mirrors disk_format.h) ──── */
const S0_MAGIC = 0x000;
const DISK_MAGIC = 0x4350;
const DISK_SECTOR_SIZE = 512;
const S0_KERN_SECS = 0x018;

/* ── VMAP layout (sector 1 — mirrors disk_format.h) ──── */
const VMAP_LBA = 1;
const VMAP_NUM_BLOCKS = 0x000;
const VMAP_BLOCK_BASE = 0x002;
const VMAP_MAGIC_OFF = 0x004;
const VMAP_VOLREC = 0x006;
const VMAP_VOLREC_SIZE = 18;
const VMAP_SIG = 0x1FE;
const VMAP_MAGIC = 0x4350;
const VOL_MAX_EXT = 4;
const VOL_MAX = 4;

export { DISK_SECTOR_SIZE, VMAP_LBA, VMAP_NUM_BLOCKS, VMAP_BLOCK_BASE, VMAP_MAGIC_OFF, VMAP_VOLREC, VMAP_VOLREC_SIZE, VOL_MAX_EXT, VOL_MAX, BD_ROOT_ENTRIES, BD_ENTRY_SIZE, getVmap };

/* ── bdos volume header offsets ────────────────────────── */
const BD_MAGIC = 0x00;
const BD_ROOT_LBA = 0x06;
const BD_DATA_LBA = 0x08;
const BD_TOT_BLKS = 0x0A;
/* Block size is fixed at 2 sectors (1 KB) and not stored on disk. */
const BD_BLOCK_SECS = 2;

/* ── bdos directory entry offsets (32 bytes) ───────────── */
const BD_DIR_ATTRIB = 11;
const BD_DIR_USER = 12;
const BD_DIR_EXTENT_IDX = 13;
const BD_DIR_EXTENT_BYTES = 14;
const BD_DIR_BLOCKS = 16;
const BD_ENTRY_SIZE = 32;
const BD_ROOT_ENTRIES = 256;
const BD_BLOCKS_PER_EXT = 8;

const BD_ENTRY_EMPTY = 0x00;
const BD_ENTRY_DELETED = 0xE5;

export function onFilesPicked() {
    const input = document.getElementById('file-input');
    addFiles(input.files);
    input.value = '';
}

export function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    document.getElementById('upload-zone').classList.add('dragover');
}

export function onDrop(e) {
    e.preventDefault();
    document.getElementById('upload-zone').classList.remove('dragover');
    if (e.dataTransfer.files.length)
        addFiles(e.dataTransfer.files);
}

function addFiles(fileList) {
    const total = fileList.length;
    let loaded = 0;
    for (let i = 0; i < total; i++) {
        const file = fileList[i];
        const entry = {
            name: file.name,
            data: null,
            status: 'reading'
        };
        uploadFiles.push(entry);
        const reader = new FileReader();
        reader.onload = (ev) => {
            entry.data = new Uint8Array(ev.target.result);
            if (entry.data.length >= 3 && entry.data[0] === 0xEF && entry.data[1] === 0xBB && entry.data[2] === 0xBF)
                entry.data = entry.data.subarray(3);
            else if (entry.data.length >= 2 && entry.data[0] === 0xFE && entry.data[1] === 0xFF)
                entry.data = entry.data.subarray(2);
            else if (entry.data.length >= 2 && entry.data[0] === 0xFF && entry.data[1] === 0xFE)
                entry.data = entry.data.subarray(2);
            entry.status = 'pending';
            loaded++;
            renderFileList();
            if (loaded === total) {
                const seen83 = {};
                for (let j = 0; j < uploadFiles.length; j++) {
                    const ent = uploadFiles[j];
                    if (ent.status !== 'pending') continue;
                    const f83 = to83(ent.name);
                    const key = f83.name + '.' + f83.ext;
                    if (seen83[key]) {
                        ent.status = 'error';
                        ent.error = 'Name clash';
                    } else seen83[key] = true;
                }
                for (let j = 0; j < uploadFiles.length; j++)
                    if (uploadFiles[j].status === 'pending') doUpload(uploadFiles[j]);
            }
            renderFileList();
        };
        reader.readAsArrayBuffer(file);
    }
    renderFileList();
}

function isVolRO(volId) {
    if (!wasm) return true;
    const vmap = getVmap();
    if (!vmap) return true;
    const vr = vmap.vol[volId];
    if (!vr || vr.extCount === 0) return false;
    return (vr.attr & 1) !== 0;
}

/* Read + parse the VMAP sector; returns null if invalid/unmounted-present. */
function getVmap() {
    const diskPtr = wasm.veecore_disk_ptr();
    const diskLen = wasm.veecore_disk_len();
    if (!diskPtr || !diskLen) return null;
    const img = new Uint8Array(wasm.memory.buffer, diskPtr, diskLen);
    if (read16(img, S0_MAGIC) !== DISK_MAGIC) return null;
    const voff = VMAP_LBA * DISK_SECTOR_SIZE;
    if (voff + DISK_SECTOR_SIZE > diskLen) return null;
    if (read16(img, voff + VMAP_MAGIC_OFF) !== VMAP_MAGIC) return null;

    const numBlocks = read16(img, voff + VMAP_NUM_BLOCKS);
    const blockBase = read16(img, voff + VMAP_BLOCK_BASE);
    if (!numBlocks || !blockBase) return null;

    const vols = [];
    for (let v = 0; v < VOL_MAX; v++) {
        const vr = voff + VMAP_VOLREC + v * VMAP_VOLREC_SIZE;
        const extCount = img[vr + 16];
        const ext = [];
        for (let i = 0; i < extCount; i++) {
            ext.push({
                start: read16(img, vr + i * 4),
                count: read16(img, vr + i * 4 + 2)
            });
        }
        vols.push({
            extCount: extCount,
            ext: ext,
            attr: img[vr + 17]
        });
    }

    return {
        blockSecs: BD_BLOCK_SECS,
        numBlocks: numBlocks,
        blockBase: blockBase,
        vol: vols
    };
}

/* Compute per-volume stats for the disk panel. Reads the volume header and
 * scans the root directory to count used data blocks (block 0 is reserved).
 * Mirrors bd_vstat: total_blocks = data blocks - 1 (usable), free_blocks =
 * usable - used, in 1 KB blocks.
 * Returns { mounted, totalBlocks, freeBlocks, ro }. */
export function volumeStats(vmap, volId) {
    const st = { mounted: false, totalBlocks: 0, freeBlocks: 0, ro: false };
    if (!vmap || volId < 0 || volId >= VOL_MAX) return st;
    const vr = vmap.vol[volId];
    if (!vr || vr.extCount === 0) return st;
    st.mounted = true;
    st.ro = (vr.attr & 1) !== 0;

    if (!wasm) return st;
    const diskPtr = wasm.veecore_disk_ptr();
    const diskLen = wasm.veecore_disk_len();
    if (!diskPtr || !diskLen) return st;

    const volLba = volSectorToPhys(vmap, volId, 0);
    if (volLba < 0) return st;
    const memBuf = wasm.memory.buffer;
    const diskEnd = diskPtr + diskLen;
    const volOff = diskPtr + volLba * DISK_SECTOR_SIZE;
    if (volOff + DISK_SECTOR_SIZE > diskEnd) return st;

    const hdr = new Uint8Array(memBuf, volOff, DISK_SECTOR_SIZE);
    if (read16(hdr, BD_MAGIC) !== DISK_MAGIC) return st;

    const rootLba = read16(hdr, BD_ROOT_LBA);
    const totalBlocks = read16(hdr, BD_TOT_BLKS);
    if (!rootLba || !totalBlocks) return st;

    const usableBlocks = totalBlocks - 1;
    if (usableBlocks < 0) return st;
    st.totalBlocks = usableBlocks;

    const rootLbaPhys = volSectorToPhys(vmap, volId, rootLba);
    if (rootLbaPhys < 0) return st;
    const rootOff = diskPtr + rootLbaPhys * DISK_SECTOR_SIZE;
    if (rootOff + BD_ROOT_ENTRIES * BD_ENTRY_SIZE > diskEnd) return st;

    const rootView = new Uint8Array(memBuf, rootOff, BD_ROOT_ENTRIES * BD_ENTRY_SIZE);
    const used = {};
    for (let i = 0; i < BD_ROOT_ENTRIES; i++) {
        const eo = i * BD_ENTRY_SIZE;
        const fb = rootView[eo];
        if (fb === BD_ENTRY_EMPTY || fb === BD_ENTRY_DELETED) continue;
        for (let b = 0; b < BD_BLOCKS_PER_EXT; b++) {
            const blk = read16(rootView, eo + BD_DIR_BLOCKS + b * 2);
            if (blk) used[blk] = true;
        }
    }
    const usedBlocks = Object.keys(used).length;
    const freeBlocks = usableBlocks - usedBlocks;
    st.freeBlocks = freeBlocks < 0 ? 0 : freeBlocks;
    return st;
}

/* Translate a volume-relative sector into a physical disk sector through the
 * volume's extent list; returns -1 when out of range or unmounted. */
function volSectorToPhys(vmap, volId, lba) {
    if (!vmap || volId < 0 || volId >= VOL_MAX) return -1;
    const vr = vmap.vol[volId];
    if (!vr || vr.extCount === 0) return -1;
    let sofar = 0;
    for (let i = 0; i < vr.extCount; i++) {
        const seg = vr.ext[i].count * vmap.blockSecs;
        if (lba < sofar + seg) {
            return vmap.blockBase + vr.ext[i].start * vmap.blockSecs + (lba - sofar);
        }
        sofar += seg;
    }
    return -1;
}

function doUpload(entry) {
    const volId = parseInt(document.getElementById('upload-vol').value);
    const userArea = parseInt(document.getElementById('upload-user').value);
    entry.volId = volId;

    if (!entry.data) {
        entry.status = 'error';
        entry.error = 'No data';
        return;
    }
    if (entry.data.length === 0) {
        entry.status = 'error';
        entry.error = 'Empty file';
        return;
    }
    if (!wasm) {
        entry.status = 'error';
        entry.error = 'Not initialized';
        return;
    }

    if (isVolRO(volId)) {
        entry.status = 'error';
        entry.error = String.fromCharCode(65 + volId) + ': is read-only';
        return;
    }

    try {
        const diskPtr = wasm.veecore_disk_ptr();
        const diskLen = wasm.veecore_disk_len();
        if (!diskPtr || !diskLen) {
            entry.status = 'error';
            entry.error = 'No disk image';
            return;
        }

        const diskEnd = diskPtr + diskLen;

        function checkOff(off, len) {
            if (off < diskPtr || off + len > diskEnd)
                throw new Error('Write outside disk bounds');
        }

        const memBuf = wasm.memory.buffer;
        const disk = new Uint8Array(memBuf, diskPtr, diskLen);
        const s0 = new Uint8Array(memBuf, diskPtr, DISK_SECTOR_SIZE);
        if (read16(s0, S0_MAGIC) !== DISK_MAGIC) {
            entry.status = 'error';
            entry.error = 'Invalid disk image';
            return;
        }

        const vmap = getVmap();
        if (!vmap) {
            entry.status = 'error';
            entry.error = 'Invalid volume map';
            return;
        }
        const vr = vmap.vol[volId];
        if (!vr || vr.extCount === 0) {
            entry.status = 'error';
            entry.error = String.fromCharCode(65 + volId) + ': is not mounted';
            return;
        }
        const volLba = volSectorToPhys(vmap, volId, 0);
        if (volLba < 0) {
            entry.status = 'error';
            entry.error = String.fromCharCode(65 + volId) + ': is missing';
            return;
        }
        let volSecsTotal = 0;
        for (let e = 0; e < vr.extCount; e++)
            volSecsTotal += vr.ext[e].count * vmap.blockSecs;
        const volOff = diskPtr + volLba * DISK_SECTOR_SIZE;
        checkOff(volOff, volSecsTotal * DISK_SECTOR_SIZE);

        const hdr = new Uint8Array(memBuf, volOff, DISK_SECTOR_SIZE);
        if (read16(hdr, BD_MAGIC) !== DISK_MAGIC) {
            entry.status = 'error';
            entry.error = 'Bad bdos volume';
            return;
        }

        const rootLba = read16(hdr, BD_ROOT_LBA);
        const dataLba = read16(hdr, BD_DATA_LBA);
        const totalBlocks = read16(hdr, BD_TOT_BLKS);
        const blockSecs = BD_BLOCK_SECS;
        const rootEntries = BD_ROOT_ENTRIES;
        if (!rootLba || !dataLba || !totalBlocks || !blockSecs) {
            entry.status = 'error';
            entry.error = 'Bad bdos header';
            return;
        }

        const blockBytes = blockSecs * DISK_SECTOR_SIZE;
        const extentBytesPerExt = BD_BLOCKS_PER_EXT * blockBytes;

        const rootLbaPhys = volSectorToPhys(vmap, volId, rootLba);
        if (rootLbaPhys < 0) {
            entry.status = 'error';
            entry.error = 'Bad bdos root';
            return;
        }
        const rootOff = diskPtr + rootLbaPhys * DISK_SECTOR_SIZE;
        checkOff(rootOff, rootEntries * BD_ENTRY_SIZE);

        const rootView = new Uint8Array(memBuf, rootOff, rootEntries * BD_ENTRY_SIZE);
        const f83 = to83(entry.name);
        if (!f83.name.trim().length) {
            entry.status = 'error';
            entry.error = 'Invalid filename';
            return;
        }

        /* Pass 1: record used blocks and check name collision (stop at EMPTY) */
        const usedBlocks = {};
        let nameMatch = false;
        for (let i = 0; i < rootEntries; i++) {
            const eo = i * BD_ENTRY_SIZE;
            const fb = rootView[eo];
            if (fb === BD_ENTRY_EMPTY || fb === BD_ENTRY_DELETED) continue;

            for (let b = 0; b < BD_BLOCKS_PER_EXT; b++) {
                const blk = read16(rootView, eo + BD_DIR_BLOCKS + b * 2);
                usedBlocks[blk] = true;
            }

            if (rootView[eo + BD_DIR_USER] !== userArea) continue;
            nameMatch = true;
            for (let j = 0; j < 8; j++) {
                if (rootView[eo + j] !== f83.name.charCodeAt(j)) {
                    nameMatch = false;
                    break;
                }
            }
            if (nameMatch) {
                for (let j = 0; j < 3; j++) {
                    if (rootView[eo + 8 + j] !== f83.ext.charCodeAt(j)) {
                        nameMatch = false;
                        break;
                    }
                }
            }
            if (nameMatch) {
                entry.status = 'error';
                entry.error = 'File exists';
                return;
            }
        }

        /* Pass 2: find free slots (EMPTY or DELETED) */
        const needExtents = Math.max(1, Math.ceil(entry.data.length / extentBytesPerExt));
        const extSlots = [];
        for (let i = 0; i < rootEntries; i++) {
            const eo = i * BD_ENTRY_SIZE;
            const fb = rootView[eo];
            if (fb === BD_ENTRY_EMPTY || fb === BD_ENTRY_DELETED) {
                extSlots.push(i);
                if (extSlots.length >= needExtents) break;
            }
        }
        if (extSlots.length < needExtents) {
            entry.status = 'error';
            entry.error = 'Root dir full';
            return;
        }

        let allocNext = 0;

        function allocBlock() {
            while (allocNext < totalBlocks) {
                if (allocNext !== 0 && !usedBlocks[allocNext]) {
                    usedBlocks[allocNext] = true;
                    const blk = allocNext;
                    allocNext++;
                    return blk;
                }
                allocNext++;
            }
            for (let b = 1; b < totalBlocks; b++) {
                if (!usedBlocks[b]) {
                    usedBlocks[b] = true;
                    return b;
                }
            }
            return -1;
        }

        let written = 0;
        for (let ei = 0; ei < needExtents; ei++) {
            const remaining = entry.data.length - written;
            const extentBytes = Math.min(remaining, extentBytesPerExt);
            const needBlocks = Math.max(1, Math.ceil(extentBytes / blockBytes));

            const blocks = [];
            for (let bi = 0; bi < needBlocks; bi++) {
                const blk = allocBlock();
                if (blk < 0) {
                    entry.status = 'error';
                    entry.error = 'Disk full';
                    return;
                }
                blocks.push(blk);

                const dataLbaPhys = volSectorToPhys(vmap, volId, dataLba + blk * blockSecs);
                if (dataLbaPhys < 0) {
                    entry.status = 'error';
                    entry.error = 'Bad bdos data';
                    return;
                }
                const coff = diskPtr + dataLbaPhys * DISK_SECTOR_SIZE;
                const chunkStart = written + bi * blockBytes;
                const chunkLen = Math.min(blockBytes, entry.data.length - chunkStart);
                checkOff(coff, chunkLen);
                const dst = new Uint8Array(memBuf, coff, chunkLen);
                dst.set(entry.data.subarray(chunkStart, chunkStart + chunkLen));
            }

            const es = extSlots[ei] * BD_ENTRY_SIZE;
            checkOff(rootOff + es, BD_ENTRY_SIZE);
            const dent = new Uint8Array(memBuf, rootOff + es, BD_ENTRY_SIZE);
            dent.fill(0);
            for (let j = 0; j < 8; j++) dent[j] = f83.name.charCodeAt(j);
            for (let j = 0; j < 3; j++) dent[8 + j] = f83.ext.charCodeAt(j);
            dent[BD_DIR_ATTRIB] = 0x00;
            dent[BD_DIR_USER] = userArea;
            dent[BD_DIR_EXTENT_IDX] = ei;
            write16(dent, BD_DIR_EXTENT_BYTES, extentBytes);
            for (let bi = 0; bi < blocks.length; bi++)
                write16(dent, BD_DIR_BLOCKS + bi * 2, blocks[bi]);

            written += extentBytes;
        }

        entry.user = userArea;
        entry.status = 'ok';
        setDiskDirty(true);
        forceScheduleDiskSave(wasm);
    } catch (e) {
        entry.status = 'error';
        entry.error = e.message || e;
        console.error('Upload error:', e);
    }
}

export function renderFileList() {
    const list = document.getElementById('file-list');
    const counter = document.getElementById('file-counter');
    let pending = false;
    let html = '';

    for (let i = 0; i < uploadFiles.length; i++) {
        const e = uploadFiles[i];
        let cls = 'file-row';
        let icon = '';
        let loc = '';
        let meta = '';

        if (e.status === 'ok') {
            cls += ' ok';
            icon = '✓';
            loc = String.fromCharCode(65 + e.volId) + ':' + e.user;
            meta = e.data.length < 1024 ? e.data.length + ' B' : (e.data.length / 1024).toFixed(1) + ' KB';
        } else if (e.status === 'error') {
            cls += ' err';
            icon = '✗';
            meta = e.error || 'Error';
        } else {
            icon = '○';
            pending = true;
        }

        const f83 = to83(e.name);
        const displayName = f83.name.trim() + (f83.ext.trim() ? '.' + f83.ext.trim() : '');
        html += '<div class="' + cls + '">' +
            '<span class="icon">' + icon + '</span>' +
            '<span class="loc">' + loc + '</span>' +
            '<span class="name">' + displayName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>' +
            '<span class="meta">' + meta + '</span>' +
            '</div>';
    }

    counter.textContent = uploadFiles.length + ' Files';

    if (uploadFiles.length === 0) {
        html = '<div class="drop-prompt">' +
            'Drag & drop files here' +
            '<span class="drop-sub">or click to browse</span></div>';
    }

    list.innerHTML = html;
}

function read16(arr, off) {
    return arr[off] | (arr[off + 1] << 8);
}

function write16(arr, off, val) {
    arr[off] = val & 0xFF;
    arr[off + 1] = (val >> 8) & 0xFF;
}

function to83(name) {
    name = name.toUpperCase();
    const dot = name.lastIndexOf('.');
    let base = dot >= 0 ? name.substring(0, dot) : name;
    let ext = dot >= 0 ? name.substring(dot + 1) : '';
    if (base.length > 8) base = base.substring(0, 8);
    if (ext.length > 3) ext = ext.substring(0, 3);
    while (base.length < 8) base += ' ';
    while (ext.length < 3) ext += ' ';
    return {
        name: base,
        ext: ext
    };
}
