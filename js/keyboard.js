import { wasm, running } from './main.js';
import { flushTTY } from './terminal.js';

const escSeq = {
    ArrowUp: [0x1B, 0x5B, 0x41]
    , ArrowDown: [0x1B, 0x5B, 0x42]
    , ArrowRight: [0x1B, 0x5B, 0x43]
    , ArrowLeft: [0x1B, 0x5B, 0x44]
    , Home: [0x1B, 0x5B, 0x31, 0x7E]
    , End: [0x1B, 0x5B, 0x34, 0x7E]
    , PageUp: [0x1B, 0x5B, 0x35, 0x7E]
    , PageDown: [0x1B, 0x5B, 0x36, 0x7E]
, };

const termInput = document.getElementById('term-input');

termInput.addEventListener('beforeinput', (e) => {
    if (!running) return;
    if (e.inputType === 'deleteContentBackward' && wasm) {
        wasm.veecore_kbd_inject(0x08);
        flushTTY();
    }
});

termInput.addEventListener('input', () => {
    if (!running) return;
    const text = termInput.value;
    termInput.value = '';
    if (!wasm) return;
    for (const ch of text) {
        let code = ch.charCodeAt(0);
        if (code === 0x0D) code = 0x0A;
        if (code === 0x0A || code === 0x08 || code === 0x09 || (code >= 0x20 && code < 0x7F)) {
            wasm.veecore_kbd_inject(code);
        }
    }
    flushTTY();
});

document.getElementById('term-canvas')
    .addEventListener('click', () => { termInput.focus(); });
document.getElementById('term-canvas')
    .addEventListener('touchstart', () => { termInput.focus(); });

document.addEventListener('keydown', (e) => {
    if (!wasm || !running) return;
    
    let code = 0;
    
    if (e.ctrlKey && e.key.length === 1) {
        const c = e.key.toUpperCase()
            .charCodeAt(0);
        if (c >= 0x41 && c <= 0x5A) {
            code = c - 0x40;
            e.preventDefault();
        }
    }
    
    const tag = document.activeElement?.tagName || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (code) {
            wasm.veecore_kbd_inject(code);
            flushTTY();
        } else if (e.key === 'Escape') {
            wasm.veecore_kbd_inject(0x1B);
            flushTTY();
        } else if (escSeq[e.key]) {
            escSeq[e.key].forEach(b => wasm.veecore_kbd_inject(b));
            e.preventDefault();
            flushTTY();
        }
        return;
    }
    if (document.activeElement) document.activeElement.blur();
    
    if (!code) {
        if (e.key.length === 1 && e.key.charCodeAt(0) >= 0x20 && e.key.charCodeAt(0) < 0x7F) {
            code = e.key.charCodeAt(0);
        } else if (e.key === 'Enter') {
            code = 0x0A;
        } else if (e.key === 'Backspace') {
            code = 0x08;
            e.preventDefault();
        } else if (e.key === 'Tab') {
            code = 0x09;
            e.preventDefault();
        } else if (e.key === 'Escape') {
            code = 0x1B;
        } else if (escSeq[e.key]) {
            escSeq[e.key].forEach(b => wasm.veecore_kbd_inject(b));
            e.preventDefault();
            flushTTY();
        }
    }
    
    if (code) {
        wasm.veecore_kbd_inject(code);
        flushTTY();
    }
});
