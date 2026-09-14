const DB_NAME = 'veecore-disk';
const DB_STORE = 'disk';

let diskSavePending = false;
let diskDirty = false;
let dbCache = {};
let dbPromises = {};
let currentDBName = DB_NAME;

export function setDiskDBName(name) {
    currentDBName = name || DB_NAME;
}

export function diskDBName(stamp) {
    return DB_NAME + '-' + stamp;
}

export function setDiskDirty(isDirty) {
    diskDirty = isDirty;
}

function getDB(name) {
    name = name || currentDBName;
    if (dbCache[name]) return Promise.resolve(dbCache[name]);
    if (!dbPromises[name]) {
        dbPromises[name] = openDB(name)
            .then(d => {
                dbCache[name] = d;
                return d;
            });
    }
    return dbPromises[name];
}

export function loadBin(url) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = () => {
            if (xhr.status === 200) {
                const data = new Uint8Array(xhr.response);
                let lastModified = null;
                const hdr = xhr.getResponseHeader('Last-Modified');
                if (hdr) {
                    const t = Date.parse(hdr);
                    if (!isNaN(t)) lastModified = Math.floor(t / 1000);
                }
                resolve({ data: data, lastModified: lastModified });
            } else reject(new Error('HTTP ' + xhr.status + ' ' + url));
        };
        xhr.onerror = () => reject(new Error('Network error ' + url));
        xhr.send();
    });
}

function openDB(name) {
    name = name || DB_NAME;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(DB_STORE))
                req.result.createObjectStore(DB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export function loadDiskFromDB(name) {
    name = name || currentDBName;
    return getDB(name)
        .then(d => {
            return new Promise((resolve, reject) => {
                const tx = d.transaction(DB_STORE, 'readonly');
                const req = tx.objectStore(DB_STORE).get('data');
                req.onsuccess = () => {
                    let res = req.result ? (req.result.data || req.result) : null;
                    if (res) {
                        if (res instanceof ArrayBuffer) res = new Uint8Array(res);
                        else if (Array.isArray(res)) res = new Uint8Array(res);
                        else if (!(res instanceof Uint8Array)) res = new Uint8Array(Object.values(res));
                    }
                    resolve(res);
                };
                req.onerror = () => reject(req.error);
            });
        })
        .catch(() => null);
}

export function cleanupOldDatabases(currentName) {
    if (!indexedDB.databases) return Promise.resolve();
    currentName = currentName || currentDBName;
    return indexedDB.databases()
        .then(dbs => {
            const toDelete = [];
            for (let i = 0; i < dbs.length; i++) {
                const n = dbs[i].name;
                if (n === currentName) continue;
                if (n === DB_NAME) { toDelete.push(n); continue; }
                if (/^\d{1,2}-\d{1,2}-\d{4}-\d{1,2}:\d{2}(AM|PM)$/i.test(n)) { toDelete.push(n); continue; }
                if (n.indexOf(DB_NAME + '-') === 0) toDelete.push(n);
            }
            return Promise.all(toDelete.map(name => {
                return new Promise(res => {
                    const req = indexedDB.deleteDatabase(name);
                    req.onsuccess = () => res();
                    req.onerror = () => res();
                    req.onblocked = () => res();
                });
            }));
        })
        .catch(() => {});
}

export function saveDiskToDB(data, name) {
    name = name || currentDBName;
    return getDB(name)
        .then(d => {
            return new Promise((resolve, reject) => {
                const tx = d.transaction(DB_STORE, 'readwrite');
                tx.objectStore(DB_STORE).put(data, 'data');
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        });
}

export function forceScheduleDiskSave(wasm) {
    diskSavePending = false;
    scheduleDiskSave(wasm);
}

export function scheduleDiskSave(wasm) {
    if (diskSavePending || !wasm) return;
    diskSavePending = true;

    try {
        const ptr = wasm.veecore_disk_ptr();
        const len = wasm.veecore_disk_len();
        if (!ptr || !len) {
            diskSavePending = false;
            return;
        }

        // Slice memory immediately to prevent buffer detachment
        const buf = new Uint8Array(wasm.memory.buffer, ptr, len).slice();
        diskDirty = false;

        saveDiskToDB(buf)
            .then(() => {
                diskSavePending = false;
                if (diskDirty) {
                    scheduleDiskSave(wasm);
                }
            })
            .catch(err => {
                console.error('Disk save failed:', err);
                diskSavePending = false;
                diskDirty = true; // Keep dirty state active so it retries on next trigger
            });
    } catch (e) {
        console.error('Error during scheduleDiskSave:', e);
        diskSavePending = false;
    }
}
