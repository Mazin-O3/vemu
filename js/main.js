import './keyboard.js';
import { loadBin, loadDiskFromDB, scheduleDiskSave, setDiskDBName, diskDBName, saveDiskToDB, cleanupOldDatabases } from './storage.js';
import { flushTTY, renderTerminal, toggleCursor, lastActivity, resetTerminal } from './terminal.js';
import { initRegGrid, resetPanelsMode, updatePanels } from './panels.js';

import { renderFileList, onFilesPicked, onDragOver, onDrop } from './bdos.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js';

export let wasm = null;
export let running = false;
export let xipMode = 0;
let rafId = null;
let ticksPerFrame = Math.round(parseInt(document.getElementById('clock-freq')
    .value, 10) / 60);
let panelTime = 0;
let bootBusy = false;
const diskCache = {};
export let bootBin = null;

window.addEventListener('unhandledrejection', function (e) {
    e.preventDefault();
});

export function toggleRun() {
    if (!wasm) return;
    running = !running;
    document.getElementById('btn-run')
        .innerHTML = running ?
        '<span><svg viewBox="0 0 12 12" width="14" height="14"><rect x="3" y="2" width="2" height="8" rx=".5" fill="currentColor"/><rect x="7" y="2" width="2" height="8" rx=".5" fill="currentColor"/></svg></span>' :
        '<span><svg viewBox="0 0 12 12" width="14" height="14"><path d="M4 2v8l6-4z" fill="currentColor"/></svg></span>';
    if (running && rafId === null) {
        rafId = requestAnimationFrame(mainLoop);
    }
    document.getElementById('btn-step')
        .disabled = running;
}

function setClockHz(hz) {
    if (!wasm) return;
    wasm.veecore_set_clock_hz(parseInt(hz, 10));
    ticksPerFrame = Math.round(parseInt(hz, 10) / 60);
}

function step() {
    if (!wasm || running) return;
    wasm.veecore_tick();
    flushTTY();
    updatePanels();
}

async function resetMachine() {
    if (!wasm) return;
    running = false;
    if (rafId !== null) { cancelAnimationFrame(rafId);
        rafId = null; }
    wasm.veecore_reset();
    if (bootBin) {
        var bootPtr = wasm.veecore_alloc(bootBin.length);
        var bootMem = new Uint8Array(wasm.memory.buffer);
        bootMem.set(bootBin, bootPtr);
        wasm.veecore_load_bootloader(bootPtr, bootBin.length);
    }
    resetTerminal();
    renderTerminal();
    updatePanels();
    toggleRun();
}

function toggle(el) {
    const body = el.nextElementSibling;
    body.classList.toggle('open');
    el.classList.toggle('open');
    el.querySelector('.arrow')
        .classList.toggle('open');
}

function mainLoop() {
    if (!running) { rafId = null; return; }
    try {
        wasm.veecore_tick_n(ticksPerFrame);
        flushTTY();
        const now = performance.now();
        if (now - panelTime > 100) {
            updatePanels();
            panelTime = now;
        }
        if (wasm.veecore_disk_dirty()) {
            scheduleDiskSave(wasm);
        }
    } catch (e) {
        console.error('mainLoop error:', e);
    }
    rafId = requestAnimationFrame(mainLoop);
}

function fnv1a(data) {
    var h = 0x811c9dc5;
    for (var i = 0; i < data.length; i++) {
        h ^= data[i];
        h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/* Boot (or reboot) the machine for the selected storage mode.
 * mode 0 = Disk (kernel/CCP RAM-loaded), 1 = Flash (kernel/CCP run in place,
 * XIP).  A mode switch is a full re-init: the matching disk image is loaded
 * (cached per mode, persisting each flavor under its own IndexedDB identity)
 * and a fresh Machine is built.  Returns the resolved IndexedDB name. */
async function bootMachine(mode) {
    if (bootBusy) return '';
    bootBusy = true;
    try {
        if (!wasm) return '';
        running = false;
        if (rafId !== null) { cancelAnimationFrame(rafId);
            rafId = null; }

        var isXip = mode ? 1 : 0;
        xipMode = isXip;

        var imgPath = isXip ? 'cpm-neo/disk-xip.img' : 'cpm-neo/disk.img';
        var resp = diskCache[imgPath];
        if (!resp) {
            try { resp = await loadBin(imgPath + '?' + Date.now()); } catch (e) {}
            if (!resp) throw new Error('No disk image: ' + imgPath);
            diskCache[imgPath] = resp;
        }

        // The image's build identity (Last-Modified, hash fallback) names the
        // IndexedDB DB, so each mode's disk supersedes any stored snapshot.
        var stamp = resp.lastModified;
        if (!stamp) stamp = fnv1a(resp.data);
        var dbName = diskDBName(stamp);
        setDiskDBName(dbName);

        var diskImage = null;
        try { diskImage = await loadDiskFromDB(dbName); } catch (e) { diskImage = null; }
        if (!diskImage) {
            diskImage = resp.data;
            try { await saveDiskToDB(diskImage, dbName); } catch (e) {}
        }

        var ptr = wasm.veecore_alloc(diskImage.length);
        var mem = new Uint8Array(wasm.memory.buffer);
        mem.set(diskImage, ptr);
        wasm.veecore_init_xip(ptr, diskImage.length, isXip);

        if (bootBin) {
            var bootPtr = wasm.veecore_alloc(bootBin.length);
            var bootMem = new Uint8Array(wasm.memory.buffer);
            bootMem.set(bootBin, bootPtr);
            wasm.veecore_load_bootloader(bootPtr, bootBin.length);
        }

        resetPanelsMode();
        resetTerminal();
        renderTerminal();
        setClockHz(document.getElementById('clock-freq')
            .value);
        updatePanels();
        return dbName;
    } finally {
        bootBusy = false;
    }
}

async function initWasm() {
    try {
        var resp = await fetch('veewasm.wasm?' + Date.now());
        if (!resp.ok) throw new Error('wasm HTTP ' + resp.status);
        var bytes = await resp.arrayBuffer();
        var mod = await WebAssembly.instantiate(bytes, {});
        wasm = mod.instance.exports;

        var bootResp = null;
        try { bootResp = await loadBin('cpm-neo/bootloader.bin?' + Date.now()); } catch (e) {}
        bootBin = bootResp ? bootResp.data : null;

        var mode = parseInt(document.getElementById('xip-mode')
            .value, 10);
        var dbName = await bootMachine(mode);
        cleanupOldDatabases(dbName);

        (async () => {
            try {
                var resp = await fetch('help.md?' + Date.now());
                if (!resp.ok) return;
                var md = await resp.text();
                var html = marked.parse(md);
                var doc = new DOMParser()
                    .parseFromString(html, 'text/html');
                var container = document.getElementById('help-body');
                if (!container) return;
                container.innerHTML = '';
                var children = [...doc.body.children];
                var sectionIdx = 0;
                var currentBody = null;
                var introDone = false;
                
                for (var node of children) {
                    if (node.tagName === 'H1') {
                        node.className = 'help-title';
                        container.appendChild(node);
                    } else if (node.tagName === 'P' && !introDone) {
                        node.classList.add('help-intro');
                        container.appendChild(node);
                        introDone = true;
                    } else if (node.tagName === 'H2') {
                        if (currentBody) container.appendChild(currentBody);
                        var id = 'help-s' + sectionIdx++;
                        var sub = document.createElement('div');
                        sub.className = 'sub-head';
                        sub.dataset.target = id;
                        sub.innerHTML = '<span class="arrow" id="' + id + '-arrow"><svg viewBox="0 0 12 12" width="10" height="10"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span> ' + node.textContent;
                        container.appendChild(sub);
                        currentBody = document.createElement('div');
                        currentBody.id = id;
                        currentBody.className = 'help-sub-body hidden';
                    } else if (node.tagName === 'P' && node.textContent.includes('Created by')) {
                        if (currentBody) { container.appendChild(currentBody);
                            currentBody = null; }
                        node.classList.add('help-about');
                        container.appendChild(node);
                    } else if (currentBody) {
                        if (node.tagName === 'P') node.classList.add('help-p');
                        else if (node.tagName === 'UL') node.classList.add('help-ul');
                        else if (node.tagName === 'PRE') node.classList.add('help-code');
                        currentBody.appendChild(node);
                    }
                }
                if (currentBody) container.appendChild(currentBody);
            } catch (e) {
                console.error('Help load error:', e);
            }
        })();
        
        initRegGrid();
        setClockHz(document.getElementById('clock-freq')
            .value);
        updatePanels();
        
        if (window.innerWidth >= 768) {
            var helpHdr = document.querySelector('.p-help .panel-header');
            if (helpHdr && !helpHdr.classList.contains('open')) toggle(helpHdr);
        }
        
        document.fonts.ready.then(() => {
            renderTerminal();
            setInterval(() => { if (running && performance.now() - lastActivity > 500) { toggleCursor();
                    renderTerminal(); } }, 500);
        });
        
    } catch (e) {
        console.error('Vemu init error:', e);
    }
}

// ── Setup event listeners ──────────────────────────────────────────────────

// Controls
document.getElementById('btn-run')
    .addEventListener('click', toggleRun);
document.getElementById('btn-step')
    .addEventListener('click', step);
document.querySelector('.ctrl-bar-left .btn-danger')
    .addEventListener('click', resetMachine);
document.getElementById('clock-freq')
    .addEventListener('change', (e) => setClockHz(e.target.value));

// Storage mode: Disk (RAM-loaded) vs Flash (XIP).  Switching is a full reboot
// of the machine with the matching disk image.
document.getElementById('xip-mode')
    .addEventListener('change', async (e) => {
        if (!wasm) return;
        await bootMachine(parseInt(e.target.value, 10));
        updatePanels();
        toggleRun();
    });

// Panel headers: toggle on click
document.querySelectorAll('.panel-header')
    .forEach(el => {
        el.addEventListener('click', () => toggle(el));
    });

// Sub-heads: toggle sections via event delegation
document.querySelector('.side-panels')
    .addEventListener('click', (e) => {
        var el = e.target.closest('.sub-head');
        if (!el) return;
        var id = el.dataset.target;
        if (id) {
            var body = document.getElementById(id);
            var arrow = document.getElementById(id + '-arrow');
            if (body) body.classList.toggle('hidden');
            if (arrow) arrow.classList.toggle('open');
        }
    });

// Upload zone
document.getElementById('upload-zone')
    .addEventListener('click', () => {
        document.getElementById('file-input')
            .click();
    });
document.getElementById('upload-zone')
    .addEventListener('dragover', onDragOver);
document.getElementById('upload-zone')
    .addEventListener('dragleave', (e) => {
        e.target.classList.remove('dragover');
    });
document.getElementById('upload-zone')
    .addEventListener('drop', onDrop);

// File input
document.getElementById('file-input')
    .addEventListener('change', onFilesPicked);

// Ctrl-bar blur
document.getElementById('ctrl-bar')
    .addEventListener('mouseleave', () => {
        if (document.activeElement && (document.activeElement.tagName === 'BUTTON' || document.activeElement.tagName === 'INPUT')) {
            document.activeElement.blur();
        }
    });

// Resize → re-render terminal
window.addEventListener('resize', renderTerminal);



// ── Bootstrap ──────────────────────────────────────────────────────────────

initWasm()
    .then(function () { setTimeout(toggleRun, 100);
        renderFileList(); })
    .catch(function (e) {
        console.error('Fatal:', e);
    });
