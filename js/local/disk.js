// The "disk" of Quadernone Locale: what D:\Quaderno\data was on the home server, kept in
// IndexedDB on this device. local/server.js is the only module that writes here (plus
// local/drivesync.js, which mirrors it to Google Drive).
//
// Stores
//   folders  { id, parentId, name, color, created, chg }
//   notes    { id, folderId, meta, pages, markdown, snippet, pdftext, coverStamp,
//              trash: null | { deleted, device, originalFolders: [{id,name,color}], originalTitle },
//              chg,    // content changes (meta/pages/ink/attachments/pdftext/move/trash)
//              dchg }  // derived files (previews, cover)
//   ink      { key: '<noteId>/<pageId>', noteId, pageId, revision, strokes }
//   files    { key: '<noteId>/<path>', noteId, path, blob, mtime }   path: attachments/x.pdf,
//              previews/<pageId>.svg, cover.png
//   feed     { seq, time, type, kind, id, parentId, revision, pageId, device, ... }
//   kv       settings, seq, drive state, tombstones
//
// tx() runs a function inside one transaction. The function may only await the request
// promises of the wrapped stores (never fetch or timers), so the transaction stays open and
// every check-then-write (revisions!) is atomic, also across tabs.
const DB_NAME = 'quadernone-disk';
const VERSION = 1;
let dbp = null;

function open() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('folders', { keyPath: 'id' });
      db.createObjectStore('notes', { keyPath: 'id' });
      db.createObjectStore('ink', { keyPath: 'key' }).createIndex('noteId', 'noteId');
      db.createObjectStore('files', { keyPath: 'key' }).createIndex('noteId', 'noteId');
      db.createObjectStore('feed', { keyPath: 'seq' });
      db.createObjectStore('kv');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbp = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function wrap(s) {
  return {
    get: (k) => p(s.get(k)),
    put: (v, k) => p(k === undefined ? s.put(v) : s.put(v, k)),
    del: (k) => p(s.delete(k)),
    all: (q) => p(s.getAll(q)),
    keys: (q) => p(s.getAllKeys(q)),
    byNote: (noteId) => p(s.index('noteId').getAll(noteId)),
    keysByNote: (noteId) => p(s.index('noteId').getAllKeys(noteId)),
    count: (q) => p(s.count(q)),
    raw: s,
  };
}

export const ALL = ['folders', 'notes', 'ink', 'files', 'feed', 'kv'];

/** Runs fn(stores) in one transaction over the named stores; resolves after commit. */
export async function tx(names, mode, fn) {
  const db = await open();
  const t = db.transaction(names, mode);
  const stores = Object.fromEntries(names.map((n) => [n, wrap(t.objectStore(n))]));
  const done = new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Transazione annullata'));
  });
  let result;
  try {
    result = await fn(stores, t);
  } catch (e) {
    try { t.abort(); } catch { /* already finished */ }
    await done.catch(() => {});
    throw e;
  }
  await done;
  return result;
}

export const read = (names, fn) => tx(names, 'readonly', fn);
export const write = (names, fn) => tx(names, 'readwrite', fn);

export const inkKey = (noteId, pageId) => `${noteId}/${pageId}`;
export const fileKey = (noteId, path) => `${noteId}/${path}`;

// Other tabs and the Drive sync hear about every change.
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('quadernone-disk') : null;
const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function changed(info = {}) {
  for (const fn of listeners) { try { fn(info); } catch { /* listener bug */ } }
  try { channel?.postMessage(info); } catch { /* closed */ }
}
channel?.addEventListener('message', (e) => { for (const fn of listeners) { try { fn({ ...e.data, remote: true }); } catch { /* */ } } });

/** Rough size of what is stored (for the info panel and settings). */
export async function usage() {
  try { return await navigator.storage?.estimate?.(); } catch { return null; }
}

/** Asks the browser not to evict the data when space runs low. */
export async function persist() {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return !!(await navigator.storage?.persist?.());
  } catch { return false; }
}

/** Deletes everything (used by tests and by "Cancella i dati di questo dispositivo"). */
export async function wipe() {
  await write(ALL, async (s) => { for (const n of ALL) s[n].raw.clear(); });
}
