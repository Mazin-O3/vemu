import { wasm, running } from './main.js';

const TERM_COLS = 80
    , TERM_ROWS = 24;

let termScreen = [];
let termAttr = [];
for (let r = 0; r < TERM_ROWS; r++) {
    termScreen[r] = new Array(TERM_COLS)
        .fill(' ');
    termAttr[r] = new Array(TERM_COLS)
        .fill(0);
}
let curRow = 0
    , curCol = 0;
let scrollTop = 0
    , scrollBottom = TERM_ROWS - 1;
let escRemain = [];
let charW = 10
    , charH = 20;
let cursorVisible = true
    , cursorHidden = false;

let currentAttr = 0;
export let lastActivity = 0;
export function toggleCursor() {
    cursorVisible = !cursorVisible;
}

export function resetTerminal() {
    termScreen = [];
    termAttr = [];
    for (let r = 0; r < TERM_ROWS; r++) {
        termScreen[r] = new Array(TERM_COLS)
            .fill(' ');
        termAttr[r] = new Array(TERM_COLS)
            .fill(0);
    }
    curRow = 0;
    curCol = 0;
    scrollTop = 0;
    scrollBottom = TERM_ROWS - 1;
    escRemain = [];
    cursorVisible = true;
    cursorHidden = false;
    lastActivity = 0;
    currentAttr = 0;
}

export function flushTTY() {
    if (!wasm) return;
    
    const n = wasm.veecore_tty_read();
    const ptr = wasm.veecore_tty_buf();
    
    let srcLen = n;
    let srcPtr = ptr;
    let pending = escRemain;
    escRemain = [];
    
    if (srcLen === 0 && pending.length === 0) return;
    
    let combined;
    if (pending.length > 0) {
        combined = new Uint8Array(pending.length + srcLen);
        combined.set(pending, 0);
        if (srcLen > 0) {
            const newBytes = new Uint8Array(wasm.memory.buffer, srcPtr, srcLen);
            combined.set(newBytes, pending.length);
        }
    } else {
        combined = new Uint8Array(wasm.memory.buffer, srcPtr, srcLen);
    }
    
    if (!termScreen || termScreen.length < TERM_ROWS) {
        termScreen = [];
        termAttr = [];
        for (let r = 0; r < TERM_ROWS; r++) {
            termScreen[r] = new Array(TERM_COLS)
                .fill(' ');
            termAttr[r] = new Array(TERM_COLS)
                .fill(0);
        }
        curRow = 0;
        curCol = 0;
    }
    
    for (let i = 0; i < combined.length; i++) {
        const b = combined[i];
        if (b === 0x1B) {
            const remain = combined.length - i;
            if (remain < 2) {
                escRemain = Array.from(combined.slice(i));
                break;
            }
            const next = combined[i + 1];
            
            // IND = \x1BD — Index: move cursor down, scroll region up if at bottom
            if (next === 0x44) {
                i += 2;
                curRow++;
                if (curRow > scrollBottom) {
                    curRow = scrollBottom;
                    for (let r = scrollTop; r < scrollBottom; r++) {
                        termScreen[r] = termScreen[r + 1].slice();
                        termAttr[r] = termAttr[r + 1].slice();
                    }
                    termScreen[scrollBottom] = new Array(TERM_COLS)
                        .fill(' ');
                    termAttr[scrollBottom] = new Array(TERM_COLS)
                        .fill(0);
                }
                continue;
            }
            
            // RI = \x1BM — Reverse Index: move cursor up, scroll region down if at top
            if (next === 0x4D) {
                i += 2;
                curRow--;
                if (curRow < scrollTop) {
                    curRow = scrollTop;
                    for (let r = scrollBottom; r > scrollTop; r--) {
                        termScreen[r] = termScreen[r - 1].slice();
                        termAttr[r] = termAttr[r - 1].slice();
                    }
                    termScreen[scrollTop] = new Array(TERM_COLS)
                        .fill(' ');
                    termAttr[scrollTop] = new Array(TERM_COLS)
                        .fill(0);
                }
                continue;
            }
            
            // CSI sequences (3+ bytes: ESC [ ...)
            if (remain < 3) {
                escRemain = Array.from(combined.slice(i));
                break;
            }
            const escStart = i;
            i++;
            if (combined[i] !== 0x5B) continue;
            i++;
            let params = [0]
                , pi = 0
                , priv = false;
            while (i < combined.length) {
                const c = combined[i];
                if (c === 0x3F) { priv = true;
                    i++; } else if (c >= 0x30 && c <= 0x39) { params[pi] = params[pi] * 10 + (c - 0x30);
                    i++; } else if (c === 0x3B) { pi++;
                    params[pi] = 0;
                    i++; } else break;
            }
            if (i >= combined.length) { escRemain = Array.from(combined.slice(escStart)); break; }
            const cmd = combined[i];
            if (cmd === 0x48 || cmd === 0x66) {
                const row = (params[0] || 1) - 1
                    , col = (params[1] || 1) - 1;
                curRow = Math.max(0, Math.min(row, TERM_ROWS - 1));
                curCol = Math.max(0, Math.min(col, TERM_COLS - 1));
            } else if (cmd === 0x4A && params[0] === 2) {
                for (let r = 0; r < TERM_ROWS; r++) { termScreen[r].fill(' ');
                    termAttr[r].fill(0); }
            } else if (cmd === 0x4B) {
                if (params[0] === 2) { termScreen[curRow].fill(' ');
                    termAttr[curRow].fill(0); } else if (params[0] === 1)
                    for (let c = 0; c <= curCol; c++) { termScreen[curRow][c] = ' ';
                        termAttr[curRow][c] = 0; }
                else
                    for (let c = curCol; c < TERM_COLS; c++) { termScreen[curRow][c] = ' ';
                        termAttr[curRow][c] = 0; }
            } else if (cmd === 0x4C) {
                const n = params[0] || 1
                    , rStart = scrollTop
                    , rEnd = scrollBottom;
                const r = Math.max(curRow, rStart);
                for (let i = rEnd; i >= r + n; i--) {
                    termScreen[i] = termScreen[i - n].slice();
                    termAttr[i] = termAttr[i - n].slice();
                }
                for (let i = r; i < r + n && i <= rEnd; i++) {
                    termScreen[i] = new Array(TERM_COLS)
                        .fill(' ');
                    termAttr[i] = new Array(TERM_COLS)
                        .fill(0);
                }
            } else if (cmd === 0x4D) {
                const n = params[0] || 1
                    , rStart = scrollTop
                    , rEnd = scrollBottom;
                const r = Math.max(curRow, rStart);
                for (let i = r; i <= rEnd - n; i++) {
                    termScreen[i] = termScreen[i + n].slice();
                    termAttr[i] = termAttr[i + n].slice();
                }
                for (let i = rEnd - n + 1; i <= rEnd; i++) {
                    termScreen[i] = new Array(TERM_COLS)
                        .fill(' ');
                    termAttr[i] = new Array(TERM_COLS)
                        .fill(0);
                }
            } else if (cmd === 0x72) {
                scrollTop = (params[0] || 1) - 1;
                scrollBottom = (params[1] || TERM_ROWS) - 1;
            } else if (priv && cmd === 0x68 && params[0] === 25) {
                cursorHidden = false;
            } else if (priv && cmd === 0x6C && params[0] === 25) {
                cursorHidden = true;
            } else if (cmd === 0x6D) {
                if (params.length === 0) {
                    currentAttr = 0;
                } else {
                    for (let p = 0; p < params.length; p++) {
                        if (params[p] === 0) {
                            currentAttr = 0;
                        } else if (params[p] === 7) {
                            currentAttr = 1;
                        } else if (params[p] === 27) {
                            currentAttr = 0;
                        }
                    }
                }
            }
            continue;
        } else if (b === 0x0A) {
            curCol = 0;
            curRow++;
            if (curRow >= TERM_ROWS) {
                for (let r = 1; r < TERM_ROWS; r++) {
                    termScreen[r - 1] = termScreen[r].slice();
                    termAttr[r - 1] = termAttr[r].slice();
                }
                termScreen[TERM_ROWS - 1] = new Array(TERM_COLS)
                    .fill(' ');
                termAttr[TERM_ROWS - 1] = new Array(TERM_COLS)
                    .fill(0);
                curRow = TERM_ROWS - 1;
            }
        } else if (b === 0x0C) {
            for (let r = 0; r < TERM_ROWS; r++) { termScreen[r].fill(' ');
                termAttr[r].fill(0); }
            curRow = 0;
            curCol = 0;
        } else if (b === 0x08) {
            if (curCol > 0) { curCol--;
                termScreen[curRow][curCol] = ' ';
                termAttr[curRow][curCol] = 0; }
        } else if (b === 0x0D) {
            if (i + 1 < combined.length && combined[i + 1] === 0x0A) continue;
            termScreen[curRow].fill(' ');
            termAttr[curRow].fill(0);
            curCol = 0;
        } else if (b >= 0x20 && b < 0x80) {
            if (curCol >= TERM_COLS) {
                curCol = 0;
                curRow++;
                if (curRow >= TERM_ROWS) {
                    for (let r = 1; r < TERM_ROWS; r++) {
                        termScreen[r - 1] = termScreen[r].slice();
                        termAttr[r - 1] = termAttr[r].slice();
                    }
                    termScreen[TERM_ROWS - 1] = new Array(TERM_COLS)
                        .fill(' ');
                    termAttr[TERM_ROWS - 1] = new Array(TERM_COLS)
                        .fill(0);
                    curRow = TERM_ROWS - 1;
                }
            }
            termScreen[curRow][curCol] = String.fromCharCode(b);
            termAttr[curRow][curCol] = currentAttr;
            curCol++;
        } else if (b >= 0x80) {
            if (curCol >= TERM_COLS) {
                curCol = 0;
                curRow++;
                if (curRow >= TERM_ROWS) {
                    for (let r = 1; r < TERM_ROWS; r++) {
                        termScreen[r - 1] = termScreen[r].slice();
                        termAttr[r - 1] = termAttr[r].slice();
                    }
                    termScreen[TERM_ROWS - 1] = new Array(TERM_COLS)
                        .fill(' ');
                    termAttr[TERM_ROWS - 1] = new Array(TERM_COLS)
                        .fill(0);
                    curRow = TERM_ROWS - 1;
                }
            }
            termScreen[curRow][curCol] = String.fromCharCode(b);
            termAttr[curRow][curCol] = currentAttr;
            curCol++;
        }
    }
    cursorVisible = true;
    lastActivity = performance.now();
    renderTerminal();
}

export function renderTerminal() {
    const c = document.getElementById('term-canvas');
    const parent = document.getElementById('term-container');
    const rect = parent.getBoundingClientRect();
    const cols = TERM_COLS
        , rows = TERM_ROWS;
    const dpr = window.devicePixelRatio || 1;
    
    const w = rect.width;
    const h = rect.height;
    
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    c.width = Math.floor(w * dpr);
    c.height = Math.floor(h * dpr);
    
    charW = w / cols;
    charH = h / rows;
    
    const xOff = 0;
    const yOff = 0;
    
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.textBaseline = 'top';
    
    ctx.clearRect(0, 0, w, h);
    
    ctx.fillStyle = '#33ff33';
    const fontSize = Math.floor(charH);
    ctx.font = fontSize + 'px "VT323", monospace';
    
    if (!termScreen || termScreen.length < rows) {
        termScreen = [];
        termAttr = [];
        for (let r = 0; r < rows; r++) {
            termScreen[r] = new Array(cols)
                .fill(' ');
            termAttr[r] = new Array(cols)
                .fill(0);
        }
        curRow = 0;
        curCol = 0;
    }
    
    for (let r = 0; r < rows; r++) {
        const l = termScreen[r];
        const a = termAttr[r];
        const y0 = Math.round(r * charH + yOff);
        const y1 = Math.round((r + 1) * charH + yOff);
        for (let c = 0; c < cols; c++) {
            const x0 = Math.round(c * charW + xOff);
            const x1 = Math.round((c + 1) * charW + xOff);
            if (a && a[c] & 1) {
                ctx.fillStyle = '#33ff33';
                ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
                ctx.fillStyle = '#030302';
            } else {
                ctx.fillStyle = '#33ff33';
            }
            ctx.fillText(l[c], x0, y0);
        }
    }
    
    const cr = Math.min(curRow, rows - 1);
    const cc = Math.min(curCol, cols - 1);
    
    if (running && cursorVisible && !cursorHidden) {
        const ch = termScreen[cr][cc];
        const x0 = Math.round(cc * charW + xOff);
        const x1 = Math.round((cc + 1) * charW + xOff);
        const y0 = Math.round(cr * charH + yOff);
        const y1 = Math.round((cr + 1) * charH + yOff);
        
        if (ch && ch !== ' ') {
            ctx.fillStyle = '#33ff33';
            ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
            ctx.fillStyle = '#030302';
            ctx.fillText(ch, x0, y0);
        } else {
            ctx.fillStyle = '#33ff33';
            ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        }
    }
}
