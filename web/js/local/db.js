// IndexedDB on this device: a copy of the notes (so they open without the server)
// and of the last folder tree. A note record:
//   { id, meta, pages, folderId, path, sizeBytes,
//     baseRevision,   // server revision the local copy is based on (0 = not on the server yet)
//     dirty,          // local changes not confirmed by the server
//     pendingMeta,    // meta fields to send with the next save
//     create }        // { folderId, title } while the note exists only on this device
// and the note attachments (images, PDFs): { key: '<noteId>/<name>', noteId, name, blob,
//     pending }       // true while the file is only on this device (uploaded by sync.js)
//
// Handwriting is stored apart from the note record, one record per page in the 'ink' store
// ({ key: '<noteId>/<pageId>', noteId, strokes }); the note keeps { revision, dirty } per page.
// getNote/putNote still exchange whole records (rec.ink[pid].strokes), but a put only writes
// the pages whose stroke array changed (arrays are never mutated in place: a change is a new
// array), and stroke arrays read or written in this session are reused instead of being
// copied out of the database again. So saving one stroke costs one page, not the whole note.
const DB_NAME = 'quadernone';
const VERSION = 3;
let dbp = null;

const inkKey = (noteId, pageId) => `${noteId}/${pageId}`;
const known = new Map();   // ink key -> stroke array as stored in the database
const hot = [];            // note ids whose arrays are kept (the few notes being worked on)
const HOT_NOTES = 3;
const pinned = new Set();  // the note open in the editor: never dropped

/** Keeps a note's stroke arrays in memory while it is open (see editor.js). */
export function pin(id) { pinned.add(id); }
export function unpin(id) { pinned.delete(id); }
export const isPinned = (id) => pinned.has(id);

/** Remembers a stored array; only the last few notes are kept (background prefetch
 *  goes through every note and must not pin all handwriting in memory). */
function remember(noteId, key, strokes) {
  const i = hot.indexOf(noteId);
  if (i !== 0) {
    if (i > 0) hot.splice(i, 1);
    hot.unshift(noteId);
    for (const old of hot.splice(HOT_NOTES).filter((x) => !pinned.has(x))) {
      for (const k of [...known.keys()]) if (k.startsWith(old + '/')) known.delete(k);
    }
  }
  known.set(key, strokes);
}

function open() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'key' }).createIndex('noteId', 'noteId');
      }
      if (!db.objectStoreNames.contains('ink')) {
        db.createObjectStore('ink', { keyPath: 'key' }).createIndex('noteId', 'noteId');
        // v2 -> v3: move the strokes out of the note records.
        if (e.oldVersion >= 1) {
          const t = req.transaction;
          const notes = t.objectStore('notes'), ink = t.objectStore('ink');
          notes.openCursor().onsuccess = (ev) => {
            const cur = ev.target.result;
            if (!cur) return;
            const rec = cur.value;
            for (const [pid, v] of Object.entries(rec.ink || {})) {
              ink.put({ key: inkKey(rec.id, pid), noteId: rec.id, strokes: v.strokes || [] });
              rec.ink[pid] = { revision: v.revision ?? 0, dirty: !!v.dirty };
            }
            cur.update(rec);
            cur.continue();
          };
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => { /* another tab holds v2: it reloads on the new service worker */ };
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(Array.isArray(store) ? store.map((n) => t.objectStore(n)) : t.objectStore(store), t);
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Note record with its handwriting (stroke arrays shared with this session's cache). */
export async function getNote(id) {
  try {
    const db = await open();
    const t = db.transaction(['notes', 'ink'], 'readonly');
    const rec = await req2p(t.objectStore('notes').get(id));
    if (!rec) return null;
    const ink = t.objectStore('ink');
    const pids = Object.keys(rec.ink || {});
    const missing = pids.filter((pid) => !known.has(inkKey(id, pid)));
    const loaded = await Promise.all(missing.map((pid) => req2p(ink.get(inkKey(id, pid)))));
    const got = new Map(missing.map((pid, i) => [pid, loaded[i]?.strokes || []]));
    for (const pid of pids) {
      const key = inkKey(id, pid);
      const strokes = got.get(pid) ?? known.get(key);
      remember(id, key, strokes);
      rec.ink[pid] = { ...rec.ink[pid], strokes };
    }
    return rec;
  } catch { return null; }
}

/**
 * Stores a note record; only pages whose stroke array changed are written.
 * cache: false for bulk writes (background prefetch) that should not take memory.
 */
export async function putNote(rec, { cache = true } = {}) {
  const light = { ...rec, ink: {} };
  const writes = [];
  for (const [pid, v] of Object.entries(rec.ink || {})) {
    light.ink[pid] = { revision: v.revision ?? 0, dirty: !!v.dirty };
    const key = inkKey(rec.id, pid);
    if (v.strokes && known.get(key) !== v.strokes) writes.push([key, v.strokes]);
  }
  await tx(['notes', 'ink'], 'readwrite', ([notes, ink]) => {
    notes.put(light);
    for (const [key, strokes] of writes) ink.put({ key, noteId: rec.id, strokes });
    // Pages no longer in the record (deleted): drop their ink.
    ink.index('noteId').getAllKeys(rec.id).onsuccess = (e) => {
      for (const key of e.target.result) if (!(key.slice(rec.id.length + 1) in light.ink)) { ink.delete(key); known.delete(key); }
    };
  });
  for (const [key, strokes] of writes) {
    if (cache || pinned.has(rec.id)) remember(rec.id, key, strokes); else known.delete(key);
  }
}

export async function deleteNote(id) {
  await tx(['notes', 'ink'], 'readwrite', ([notes, ink]) => {
    notes.delete(id);
    ink.index('noteId').getAllKeys(id).onsuccess = (e) => { for (const key of e.target.result) ink.delete(key); };
  });
  for (const key of [...known.keys()]) if (key.startsWith(id + '/')) known.delete(key);
}

/** Every note record WITHOUT strokes (rec.ink[pid] = { revision, dirty }): for status checks. */
export const allNotes = () => tx('notes', 'readonly', (s) => s.getAll()).catch(() => []);
export const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k)).catch(() => null);
export const kvSet = (k, v) => tx('kv', 'readwrite', (s) => { s.put(v, k); });

export const getFile = (key) => tx('files', 'readonly', (s) => s.get(key)).catch(() => null);
export const putFile = (rec) => tx('files', 'readwrite', (s) => { s.put(rec); });
export const deleteFile = (key) => tx('files', 'readwrite', (s) => { s.delete(key); });
export const noteFiles = (noteId) => tx('files', 'readonly', (s) => s.index('noteId').getAll(noteId)).catch(() => []);
export async function deleteNoteFiles(noteId) {
  for (const f of await noteFiles(noteId)) if (!f.pending) await deleteFile(f.key);
}
