import './keyboard.js';
import { loadBin, loadDiskFromDB, scheduleDiskSave, setDiskDBName, diskDBName, saveDiskToDB, cleanupOldDatabases } from './storage.js';
import { flushTTY, renderTerminal, toggleCursor, lastActivity, resetTerminal } from './terminal.js';
import { initRegGrid, updatePanels } from './panels.js';

import { renderFileList, onFilesPicked, onDragOver, onDrop } from './bdos.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js';

export let wasm = null;
export let running = false;
let rafId = null;
let ticksPerFrame = Math.round(parseInt(document.getElementById('clock-freq')
    .value, 10) / 60);
let panelTime = 0;
let diskImage = null;
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

async function initWasm() {
    try {
        var resp = await fetch('veewasm.wasm?' + Date.now());
        if (!resp.ok) throw new Error('wasm HTTP ' + resp.status);
        var bytes = await resp.arrayBuffer();
        var mod = await WebAssembly.instantiate(bytes, {});
        wasm = mod.instance.exports;
        
        // Fetch disk.img first — its build identity (Last-Modified, hash fallback)
        // names the IndexedDB DB, so a rebuilt disk supersedes any stored snapshot.
        var diskResp = null;
        try { diskResp = await loadBin('cpm-neo/disk.img?' + Date.now()); } catch (e) {}
        if (!diskResp) throw new Error('No disk image');
        
        var stamp = diskResp.lastModified;
        if (!stamp) stamp = fnv1a(diskResp.data);
        var dbName = diskDBName(stamp);
        setDiskDBName(dbName);
        
        try { diskImage = await loadDiskFromDB(dbName); } catch (e) { diskImage = null; }
        if (!diskImage) {
            diskImage = diskResp.data;
            try { await saveDiskToDB(diskImage, dbName); } catch (e) {}
        }
        
        cleanupOldDatabases(dbName);
        
        var ptr = wasm.veecore_alloc(diskImage.length);
        var mem = new Uint8Array(wasm.memory.buffer);
        mem.set(diskImage, ptr);
        wasm.veecore_init_with(ptr, diskImage.length);
        
        try {
            var bootResp = await loadBin('cpm-neo/bootloader.bin?' + Date.now());
            bootBin = bootResp ? bootResp.data : null;
        } catch (e) {}
        if (bootBin) {
            var bootPtr = wasm.veecore_alloc(bootBin.length);
            var bootMem = new Uint8Array(wasm.memory.buffer);
            bootMem.set(bootBin, bootPtr);
            wasm.veecore_load_bootloader(bootPtr, bootBin.length);
        }
        
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
