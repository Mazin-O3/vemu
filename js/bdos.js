import {
    wasm
} from './main.js';
import {
    forceScheduleDiskSave
    , setDiskDirty
} from './storage.js';

let uploadFiles = [];

/* ── Sector 0 layout (v2 — mirrors kernel_abi.h) ──────── */
var S0_MAGIC = 0x000;
var DISK_MAGIC = 0x4350;
var DISK_SECTOR_SIZE = 512;
var S0_KERN_SECS = 0x018;

/* ── VMAP layout (sector 1 — mirrors kernel_abi.h) ────── */
var VMAP_LBA = 1;
var VMAP_NUM_BLOCKS = 0x000;
var VMAP_BLOCK_BASE = 0x002;
var VMAP_MAGIC_OFF = 0x004;
var VMAP_VOLREC = 0x006;
var VMAP_VOLREC_SIZE = 18;
var VMAP_SIG = 0x1FE;
var VMAP_MAGIC = 0x4350;
var VOL_MAX_EXT = 4;
var VOL_MAX = 4;

export { DISK_SECTOR_SIZE, VMAP_LBA, VMAP_NUM_BLOCKS, VMAP_BLOCK_BASE, VMAP_MAGIC_OFF, VMAP_VOLREC, VMAP_VOLREC_SIZE, VOL_MAX_EXT, VOL_MAX, BD_ROOT_ENTRIES, BD_ENTRY_SIZE, getVmap };

/* ── bdos volume header offsets ────────────────────────── */
var BD_MAGIC = 0x00;
var BD_ROOT_LBA = 0x06;
var BD_DATA_LBA = 0x08;
var BD_TOT_BLKS = 0x0A;
/* Block size is fixed at 2 sectors (1 KB) and not stored on disk. */
var BD_BLOCK_SECS = 2;

/* ── bdos directory entry offsets (32 bytes) ───────────── */
var BD_DIR_ATTRIB = 11;
var BD_DIR_USER = 12;
var BD_DIR_EXTENT_IDX = 13;
var BD_DIR_EXTENT_BYTES = 14;
var BD_DIR_BLOCKS = 16;
var BD_ENTRY_SIZE = 32;
var BD_ROOT_ENTRIES = 256;
var BD_BLOCKS_PER_EXT = 8;

var BD_ENTRY_EMPTY = 0x00;
var BD_ENTRY_DELETED = 0xE5;

export function onFilesPicked() {
    var input = document.getElementById('file-input');
    addFiles(input.files);
    input.value = '';
}

export function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    document.getElementById('upload-zone')
        .classList.add('dragover');
}

export function onDrop(e) {
    e.preventDefault();
    document.getElementById('upload-zone')
        .classList.remove('dragover');
    if (e.dataTransfer.files.length)
        addFiles(e.dataTransfer.files);
}

function addFiles(fileList) {
    var total = fileList.length;
    var loaded = 0;
    for (var i = 0; i < total; i++) {
        var file = fileList[i];
        var entry = {
            name: file.name
            , data: null
            , status: 'reading'
        };
        uploadFiles.push(entry);
        (function (e) {
            var reader = new FileReader();
            reader.onload = function (ev) {
                e.data = new Uint8Array(ev.target.result);
                if (e.data.length >= 3 && e.data[0] === 0xEF && e.data[1] === 0xBB && e.data[2] === 0xBF)
                    e.data = e.data.subarray(3);
                else if (e.data.length >= 2 && e.data[0] === 0xFE && e.data[1] === 0xFF)
                    e.data = e.data.subarray(2);
                else if (e.data.length >= 2 && e.data[0] === 0xFF && e.data[1] === 0xFE)
                    e.data = e.data.subarray(2);
                e.status = 'pending';
                loaded++;
                renderFileList();
                if (loaded === total) {
                    var seen83 = {};
                    for (var j = 0; j < uploadFiles.length; j++) {
                        var ent = uploadFiles[j];
                        if (ent.status !== 'pending') continue;
                        var f83 = to83(ent.name);
                        var key = f83.name + '.' + f83.ext;
                        if (seen83[key]) {
                            ent.status = 'error';
                            ent.error = 'Name clash';
                        } else seen83[key] = true;
                    }
                    for (var j = 0; j < uploadFiles.length; j++)
                        if (uploadFiles[j].status === 'pending') doUpload(uploadFiles[j]);
                }
                renderFileList();
            };
            reader.readAsArrayBuffer(file);
        })(entry);
    }
    renderFileList();
}

function isVolRO(volId) {
    if (!wasm) return true;
    var vmap = getVmap();
    if (!vmap) return true;
    var vr = vmap.vol[volId];
    if (!vr || vr.extCount === 0) return false;
    return (vr.attr & 1) !== 0;
}

/* Read + parse the VMAP sector; returns null if invalid/unmounted-present. */
function getVmap() {
    var diskPtr = wasm.veecore_disk_ptr();
    var diskLen = wasm.veecore_disk_len();
    if (!diskPtr || !diskLen) return null;
    var img = new Uint8Array(wasm.memory.buffer, diskPtr, diskLen);
    if (read16(img, S0_MAGIC) !== DISK_MAGIC) return null;
    var voff = VMAP_LBA * DISK_SECTOR_SIZE;
    if (voff + DISK_SECTOR_SIZE > diskLen) return null;
    if (read16(img, voff + VMAP_MAGIC_OFF) !== VMAP_MAGIC) return null;

    var numBlocks = read16(img, voff + VMAP_NUM_BLOCKS);
    var blockBase = read16(img, voff + VMAP_BLOCK_BASE);
    if (!numBlocks || !blockBase) return null;

    var vols = [];
    for (var v = 0; v < VOL_MAX; v++) {
        var vr = voff + VMAP_VOLREC + v * VMAP_VOLREC_SIZE;
        var extCount = img[vr + 16];
        var ext = [];
        for (var i = 0; i < extCount; i++) {
            ext.push({
                start: read16(img, vr + i * 4)
                , count: read16(img, vr + i * 4 + 2)
            });
        }
        vols.push({
            extCount: extCount
            , ext: ext
            , attr: img[vr + 17]
        });
    }

    return {
        blockSecs: BD_BLOCK_SECS
        , numBlocks: numBlocks
        , blockBase: blockBase
        , vol: vols
    };
}

/* Compute per-volume stats for the disk panel. Reads the volume header and
 * scans the root directory to count used data blocks (block 0 is reserved).
 * Mirrors bd_vstat: total_blocks = data blocks - 1 (usable), free_blocks =
 * usable - used, in 1 KB blocks.
 * Returns { mounted, totalBlocks, freeBlocks, ro }. */
export function volumeStats(vmap, volId) {
    var st = { mounted: false, totalBlocks: 0, freeBlocks: 0, ro: false };
    if (!vmap || volId < 0 || volId >= VOL_MAX) return st;
    var vr = vmap.vol[volId];
    if (!vr || vr.extCount === 0) return st;
    st.mounted = true;
    st.ro = (vr.attr & 1) !== 0;

    if (!wasm) return st;
    var diskPtr = wasm.veecore_disk_ptr();
    var diskLen = wasm.veecore_disk_len();
    if (!diskPtr || !diskLen) return st;

    var volLba = volSectorToPhys(vmap, volId, 0);
    if (volLba < 0) return st;
    var memBuf = wasm.memory.buffer;
    var diskEnd = diskPtr + diskLen;
    var volOff = diskPtr + volLba * DISK_SECTOR_SIZE;
    if (volOff + DISK_SECTOR_SIZE > diskEnd) return st;

    var hdr = new Uint8Array(memBuf, volOff, DISK_SECTOR_SIZE);
    if (read16(hdr, BD_MAGIC) !== DISK_MAGIC) return st;

    var rootLba = read16(hdr, BD_ROOT_LBA);
    var totalBlocks = read16(hdr, BD_TOT_BLKS);
    if (!rootLba || !totalBlocks) return st;

    var usableBlocks = totalBlocks - 1;
    if (usableBlocks < 0) return st;
    st.totalBlocks = usableBlocks;

    var rootLbaPhys = volSectorToPhys(vmap, volId, rootLba);
    if (rootLbaPhys < 0) return st;
    var rootOff = diskPtr + rootLbaPhys * DISK_SECTOR_SIZE;
    if (rootOff + BD_ROOT_ENTRIES * BD_ENTRY_SIZE > diskEnd) return st;

    var rootView = new Uint8Array(memBuf, rootOff, BD_ROOT_ENTRIES * BD_ENTRY_SIZE);
    var used = {};
    for (var i = 0; i < BD_ROOT_ENTRIES; i++) {
        var eo = i * BD_ENTRY_SIZE;
        var fb = rootView[eo];
        if (fb === BD_ENTRY_EMPTY || fb === BD_ENTRY_DELETED) continue;
        for (var b = 0; b < BD_BLOCKS_PER_EXT; b++) {
            var blk = read16(rootView, eo + BD_DIR_BLOCKS + b * 2);
            if (blk) used[blk] = true;
        }
    }
    var usedBlocks = Object.keys(used).length;
    var freeBlocks = usableBlocks - usedBlocks;
    if (freeBlocks < 0) freeBlocks = 0;
    st.freeBlocks = freeBlocks;
    return st;
}

/* Translate a volume-relative sector into a physical disk sector through the
 * volume's extent list; returns -1 when out of range or unmounted. */
function volSectorToPhys(vmap, volId, lba) {
    if (!vmap || volId < 0 || volId >= VOL_MAX) return -1;
    var vr = vmap.vol[volId];
    if (!vr || vr.extCount === 0) return -1;
    var sofar = 0;
    for (var i = 0; i < vr.extCount; i++) {
        var seg = vr.ext[i].count * vmap.blockSecs;
        if (lba < sofar + seg) {
            return vmap.blockBase + vr.ext[i].start * vmap.blockSecs + (lba - sofar);
        }
        sofar += seg;
    }
    return -1;
}

function doUpload(entry) {
    var volId = parseInt(document.getElementById('upload-vol')
        .value);
    var userArea = parseInt(document.getElementById('upload-user')
        .value);
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
        var diskPtr = wasm.veecore_disk_ptr();
        var diskLen = wasm.veecore_disk_len();
        if (!diskPtr || !diskLen) {
            entry.status = 'error';
            entry.error = 'No disk image';
            return;
        }
        
        var diskEnd = diskPtr + diskLen;
        
        function checkOff(off, len) {
            if (off < diskPtr || off + len > diskEnd)
                throw new Error('Write outside disk bounds');
        }
        
        var memBuf = wasm.memory.buffer;
        var disk = new Uint8Array(memBuf, diskPtr, diskLen);
        var s0 = new Uint8Array(memBuf, diskPtr, DISK_SECTOR_SIZE);
        if (read16(s0, S0_MAGIC) !== DISK_MAGIC) {
            entry.status = 'error';
            entry.error = 'Invalid disk image';
            return;
        }

        var vmap = getVmap();
        if (!vmap) {
            entry.status = 'error';
            entry.error = 'Invalid volume map';
            return;
        }
        var vr = vmap.vol[volId];
        if (!vr || vr.extCount === 0) {
            entry.status = 'error';
            entry.error = String.fromCharCode(65 + volId) + ': is not mounted';
            return;
        }
        var volLba = volSectorToPhys(vmap, volId, 0);
        if (volLba < 0) {
            entry.status = 'error';
            entry.error = String.fromCharCode(65 + volId) + ': is missing';
            return;
        }
        var volSectors = vr.extCount;
        var volSecsTotal = 0;
        for (var e = 0; e < vr.extCount; e++)
            volSecsTotal += vr.ext[e].count * vmap.blockSecs;
        var volOff = diskPtr + volLba * DISK_SECTOR_SIZE;
        checkOff(volOff, volSecsTotal * DISK_SECTOR_SIZE);
        
        var hdr = new Uint8Array(memBuf, volOff, DISK_SECTOR_SIZE);
        if (read16(hdr, BD_MAGIC) !== DISK_MAGIC) {
            entry.status = 'error';
            entry.error = 'Bad bdos volume';
            return;
        }
        
        var rootLba = read16(hdr, BD_ROOT_LBA);
        var dataLba = read16(hdr, BD_DATA_LBA);
        var totalBlocks = read16(hdr, BD_TOT_BLKS);
        var blockSecs = BD_BLOCK_SECS;
        var rootEntries = BD_ROOT_ENTRIES;
        if (!rootLba || !dataLba || !totalBlocks || !blockSecs) {
            entry.status = 'error';
            entry.error = 'Bad bdos header';
            return;
        }
        
var blockBytes = blockSecs * DISK_SECTOR_SIZE;
        var extentBytesPerExt = BD_BLOCKS_PER_EXT * blockBytes;

        var rootLbaPhys = volSectorToPhys(vmap, volId, rootLba);
        if (rootLbaPhys < 0) {
            entry.status = 'error';
            entry.error = 'Bad bdos root';
            return;
        }
        var rootOff = diskPtr + rootLbaPhys * DISK_SECTOR_SIZE;
        checkOff(rootOff, rootEntries * BD_ENTRY_SIZE);
        
        var rootView = new Uint8Array(memBuf, rootOff, rootEntries * BD_ENTRY_SIZE);
        var f83 = to83(entry.name);
        if (!f83.name.trim()
            .length) {
            entry.status = 'error';
            entry.error = 'Invalid filename';
            return;
        }
        
        /* Pass 1: record used blocks and check name collision (stop at EMPTY) */
        var usedBlocks = {};
        var nameMatch = false;
        for (var i = 0; i < rootEntries; i++) {
            var eo = i * BD_ENTRY_SIZE;
            var fb = rootView[eo];
            if (fb === BD_ENTRY_EMPTY || fb === BD_ENTRY_DELETED) continue;
            
            for (var b = 0; b < BD_BLOCKS_PER_EXT; b++) {
                var blk = read16(rootView, eo + BD_DIR_BLOCKS + b * 2);
                usedBlocks[blk] = true;
            }
            
            if (rootView[eo + BD_DIR_USER] !== userArea) continue;
            nameMatch = true;
            for (var j = 0; j < 8; j++) {
                if (rootView[eo + j] !== f83.name.charCodeAt(j)) {
                    nameMatch = false;
                    break;
                }
            }
            if (nameMatch) {
                for (var j = 0; j < 3; j++) {
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
        var needExtents = Math.max(1, Math.ceil(entry.data.length / extentBytesPerExt));
        var extSlots = [];
        for (var i = 0; i < rootEntries; i++) {
            var eo = i * BD_ENTRY_SIZE;
            var fb = rootView[eo];
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
        
        var allocNext = 0;
        
        function allocBlock() {
            while (allocNext < totalBlocks) {
                if (allocNext !== 0 && !usedBlocks[allocNext]) {
                    usedBlocks[allocNext] = true;
                    var blk = allocNext;
                    allocNext++;
                    return blk;
                }
                allocNext++;
            }
            for (var b = 1; b < totalBlocks; b++) {
                if (!usedBlocks[b]) {
                    usedBlocks[b] = true;
                    return b;
                }
            }
            return -1;
        }
        
        var written = 0;
        for (var ei = 0; ei < needExtents; ei++) {
            var remaining = entry.data.length - written;
            var extentBytes = Math.min(remaining, extentBytesPerExt);
            var needBlocks = Math.max(1, Math.ceil(extentBytes / blockBytes));
            
            var blocks = [];
            for (var bi = 0; bi < needBlocks; bi++) {
                var blk = allocBlock();
                if (blk < 0) {
                    entry.status = 'error';
                    entry.error = 'Disk full';
                    return;
                }
                blocks.push(blk);
                
                var dataLbaPhys = volSectorToPhys(vmap, volId, dataLba + blk * blockSecs);
                if (dataLbaPhys < 0) {
                    entry.status = 'error';
                    entry.error = 'Bad bdos data';
                    return;
                }
                var coff = diskPtr + dataLbaPhys * DISK_SECTOR_SIZE;
                var chunkStart = written + bi * blockBytes;
                var chunkLen = Math.min(blockBytes, entry.data.length - chunkStart);
                checkOff(coff, chunkLen);
                var dst = new Uint8Array(memBuf, coff, chunkLen);
                dst.set(entry.data.subarray(chunkStart, chunkStart + chunkLen));
            }
            
            var es = extSlots[ei] * BD_ENTRY_SIZE;
            checkOff(rootOff + es, BD_ENTRY_SIZE);
            var dent = new Uint8Array(memBuf, rootOff + es, BD_ENTRY_SIZE);
            dent.fill(0);
            for (var j = 0; j < 8; j++) dent[j] = f83.name.charCodeAt(j);
            for (var j = 0; j < 3; j++) dent[8 + j] = f83.ext.charCodeAt(j);
            dent[BD_DIR_ATTRIB] = 0x00;
            dent[BD_DIR_USER] = userArea;
            dent[BD_DIR_EXTENT_IDX] = ei;
            write16(dent, BD_DIR_EXTENT_BYTES, extentBytes);
            for (var bi = 0; bi < blocks.length; bi++)
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
    var list = document.getElementById('file-list');
    var counter = document.getElementById('file-counter');
    var pending = false;
    var html = '';
    
    for (var i = 0; i < uploadFiles.length; i++) {
        var e = uploadFiles[i];
        var cls = 'file-row';
        var icon = '';
        var loc = '';
        var meta = '';
        
        if (e.status === 'ok') {
            cls += ' ok';
            icon = '✓';
            loc = String.fromCharCode(65 + e.volId) + ':' + e.user;
            meta = e.data.length < 1024 ? e.data.length + ' B' : (e.data.length / 1024)
                .toFixed(1) + ' KB';
        } else if (e.status === 'error') {
            cls += ' err';
            icon = '✗';
            meta = e.error || 'Error';
        } else {
            icon = '○';
            pending = true;
        }
        
        var f83_ = to83(e.name);
        var displayName = f83_.name.trim() + (f83_.ext.trim() ? '.' + f83_.ext.trim() : '');
        html += '<div class="' + cls + '">' +
            '<span class="icon">' + icon + '</span>' +
            '<span class="loc">' + loc + '</span>' +
            '<span class="name">' + displayName.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;') + '</span>' +
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
    var dot = name.lastIndexOf('.');
    var base = dot >= 0 ? name.substring(0, dot) : name;
    var ext = dot >= 0 ? name.substring(dot + 1) : '';
    if (base.length > 8) base = base.substring(0, 8);
    if (ext.length > 3) ext = ext.substring(0, 3);
    while (base.length < 8) base += ' ';
    while (ext.length < 3) ext += ' ';
    return {
        name: base
        , ext: ext
    };
}
