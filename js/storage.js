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
            .then(function (d) {
                dbCache[name] = d;
                return d;
            });
    }
    return dbPromises[name];
}

export function loadBin(url) {
    return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function () {
            if (xhr.status === 200) {
                var data = new Uint8Array(xhr.response);
                var lastModified = null;
                var hdr = xhr.getResponseHeader('Last-Modified');
                if (hdr) {
                    var t = Date.parse(hdr);
                    if (!isNaN(t)) lastModified = Math.floor(t / 1000);
                }
                resolve({ data: data, lastModified: lastModified });
            } else reject(new Error('HTTP ' + xhr.status + ' ' + url));
        };
        xhr.onerror = function () { reject(new Error('Network error ' + url)); };
        xhr.send();
    });
}

function openDB(name) {
    name = name || DB_NAME;
    return new Promise(function (resolve, reject) {
        var req = indexedDB.open(name, 1);
        req.onupgradeneeded = function () {
            if (!req.result.objectStoreNames.contains(DB_STORE))
                req.result.createObjectStore(DB_STORE);
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
    });
}

export function loadDiskFromDB(name) {
    name = name || currentDBName;
    return getDB(name)
        .then(function (d) {
            return new Promise(function (resolve, reject) {
                var tx = d.transaction(DB_STORE, 'readonly');
                var req = tx.objectStore(DB_STORE)
                    .get('data');
                req.onsuccess = function () {
                    var res = req.result ? (req.result.data || req.result) : null;
                    if (res) {
                        if (res instanceof ArrayBuffer) res = new Uint8Array(res);
                        else if (Array.isArray(res)) res = new Uint8Array(res);
                        else if (!(res instanceof Uint8Array)) res = new Uint8Array(Object.values(res));
                    }
                    resolve(res);
                };
                req.onerror = function () { reject(req.error); };
            });
        })
        .catch(function () { return null; });
}

export function cleanupOldDatabases(currentName) {
    if (!indexedDB.databases) return Promise.resolve();
    currentName = currentName || currentDBName;
    return indexedDB.databases()
        .then(function (dbs) {
            var toDelete = [];
            for (var i = 0; i < dbs.length; i++) {
                var n = dbs[i].name;
                if (n === currentName) continue;
                if (n === DB_NAME) { toDelete.push(n); continue; }
                if (/^\d{1,2}-\d{1,2}-\d{4}-\d{1,2}:\d{2}(AM|PM)$/i.test(n)) { toDelete.push(n); continue; }
                if (n.indexOf(DB_NAME + '-') === 0) toDelete.push(n);
            }
            return Promise.all(toDelete.map(function (name) {
                return new Promise(function (res) {
                    var req = indexedDB.deleteDatabase(name);
                    req.onsuccess = function () { res(); };
                    req.onerror = function () { res(); };
                    req.onblocked = function () { res(); };
                });
            }));
        })
        .catch(function () {});
}

export function saveDiskToDB(data, name) {
    name = name || currentDBName;
    return getDB(name)
        .then(function (d) {
            return new Promise(function (resolve, reject) {
                var tx = d.transaction(DB_STORE, 'readwrite');
                tx.objectStore(DB_STORE)
                    .put(data, 'data');
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
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
        var ptr = wasm.veecore_disk_ptr();
        var len = wasm.veecore_disk_len();
        if (!ptr || !len) {
            diskSavePending = false;
            return;
        }
        
        // Slice memory immediately to prevent buffer detachment
        var buf = new Uint8Array(wasm.memory.buffer, ptr, len)
            .slice();
        diskDirty = false;
        
        saveDiskToDB(buf)
            .then(function () {
                diskSavePending = false;
                if (diskDirty) {
                    scheduleDiskSave(wasm);
                }
            })
            .catch(function (err) {
                console.error('Disk save failed:', err);
                diskSavePending = false;
                diskDirty = true; // Keep dirty state active so it retries on next trigger
            });
    } catch (e) {
        console.error('Error during scheduleDiskSave:', e);
        diskSavePending = false;
    }
}
