// Offline support: every edit is stored on the device first (IndexedDB), then pushed to
// the server. Pushes for the same note run one at a time and always send the latest
// local state with the server revision it is based on, so ten offline saves become one
// request, and a stale base produces one conflict copy on the server — never an overwrite.
import { api, request } from '../api.js';
import * as db from './db.js';
import * as files from './files.js';

const chains = new Map();   // noteId -> promise of the running push

/** Record from a server response (GET /api/notes/{id}?ink=1). */
export function fromServer(data) {
  const ink = {};
  for (const [pid, v] of Object.entries(data.ink || {})) ink[pid] = { revision: v.revision, strokes: v.strokes, dirty: false };
  return {
    id: data.meta.id, meta: data.meta, pages: data.pages, folderId: data.folderId ?? null,
    path: data.path ?? '', sizeBytes: data.sizeBytes ?? 0, ink,
    baseRevision: data.meta.revision, dirty: false, pendingMeta: null, create: null,
    serverStamp: stamp(data.meta.revision, data.meta.modified),
  };
}

/** Changes whenever the note changes on the server (handwriting does not bump the revision). */
export const stamp = (revision, modified) => `${revision}|${modified}`;

/** Local changes not yet confirmed by the server (pages/meta or any page's ink). */
export const isPending = (rec) => !!(rec.dirty || rec.create || rec.pendingFiles || rec.pendingPdfText || Object.values(rec.ink || {}).some((v) => v.dirty));

export const getNoteWithInk = (id, opts) => request('GET', `/notes/${id}?ink=1`, undefined, opts);

const newHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A note created while the server is unreachable. Returns its record. */
export async function createLocal(folderId, title, defaults) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const meta = {
    version: 1, id, title: title || 'Senza titolo', created: now, modified: now, favorite: false,
    cover: { mode: 'auto', color: null, icon: null, image: null }, revision: 0, lastDevice: null, conflictOf: null,
  };
  const page = { id: 'pg-' + newHex(4), size: structuredClone(defaults.size), orientation: defaults.orientation,
    background: structuredClone(defaults.background), pdf: null, inkRevision: 0, objects: [] };
  const rec = {
    id, meta, pages: { version: 1, defaults: structuredClone(defaults), pages: [page] }, folderId, path: '', sizeBytes: 0,
    ink: {}, baseRevision: 0, dirty: true, pendingMeta: null, create: { folderId, title: meta.title },
  };
  await db.putNote(rec);
  return rec;
}

/** Summary (as in /api/tree) for a local record. */
export function summaryOf(rec) {
  return {
    id: rec.id, folderId: rec.folderId, title: rec.meta.title, created: rec.meta.created, modified: rec.meta.modified,
    favorite: !!rec.meta.favorite, cover: rec.meta.cover, hasCoverImage: false, coverVersion: null,
    revision: rec.baseRevision, lastDevice: rec.meta.lastDevice, conflictOf: rec.meta.conflictOf, snippet: '',
    localOnly: !!rec.create, pending: isPending(rec),
  };
}

/**
 * Sends the local state of a note to the server.
 * Resolves to { status: 'clean' | 'saved' | 'conflict' | 'offline' | 'error', res, copyId, error }.
 */
export function push(id) {
  const prev = chains.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => pushNow(id));
  chains.set(id, next);
  next.finally(() => { if (chains.get(id) === next) chains.delete(id); });
  return next;
}

async function pushNow(id) {
  let rec = await db.getNote(id);
  if (!rec || !isPending(rec)) return { status: 'clean' };
  try {
    if (rec.create) {
      const body = { id, folderId: rec.create.folderId, title: rec.meta.title, pageDefaults: rec.pages.defaults };
      let res;
      try {
        res = await api.createNote(body.folderId, body.title, body.pageDefaults, id);
      } catch (e) {
        if (e.status !== 404) throw e;
        res = await api.createNote(null, body.title, body.pageDefaults, id);   // its folder is gone: put it at the top
      }
      rec = await db.getNote(id);
      rec.create = null;
      rec.baseRevision = res.note.revision;
      rec.meta.revision = res.note.revision;
      rec.folderId = res.note.folderId;
      rec.dirty = true;   // the server has an empty note: send our pages
      await db.putNote(rec);
    }
    let last = null;
    // 0. Attachments added offline, before the pages that use them.
    if (rec.pendingFiles) {
      const renamed = await files.flushPending(id);
      rec = await db.getNote(id);
      if (Object.keys(renamed).length) { renameRefs(rec, renamed); rec.dirty = true; }
      rec.pendingFiles = false;
      await db.putNote(rec);
    }
    if (rec.pendingPdfText) {
      for (const [file, pages] of Object.entries(rec.pendingPdfText)) {
        await request('PUT', `/notes/${id}/pdftext/${encodeURIComponent(file)}`, { pages });
      }
      rec = await db.getNote(id);
      rec.pendingPdfText = null;
      await db.putNote(rec);
    }
    // 1. Pages and meta (first: new pages must exist on the server before their ink).
    if (rec.dirty) {
      const sentPages = JSON.stringify(rec.pages);
      const sentMeta = rec.pendingMeta;
      const body = { pages: JSON.parse(sentPages) };
      if (sentMeta) body.meta = sentMeta;
      const res = await api.saveNote(id, rec.baseRevision, body);
      // The editor may have stored newer changes meanwhile: only clear what was sent.
      const cur = await db.getNote(id) || rec;
      cur.baseRevision = res.revision;
      cur.meta.revision = res.revision;
      if (res.note) { cur.meta.title = cur.pendingMeta?.title ?? res.note.title; cur.folderId = res.note.folderId; cur.serverStamp = stamp(res.note.revision, res.note.modified); }
      if (JSON.stringify(cur.pendingMeta) === JSON.stringify(sentMeta)) cur.pendingMeta = null;
      cur.dirty = JSON.stringify(cur.pages) !== sentPages || !!cur.pendingMeta;
      await db.putNote(cur);
      rec = cur;
      last = res;
    }
    // 2. Handwriting, page by page, each with its own base revision.
    const pageIds = new Set(rec.pages.pages.map((p) => p.id));
    for (const [pid, v] of Object.entries(rec.ink || {})) {
      if (!v.dirty) continue;
      if (!pageIds.has(pid)) {   // page deleted: its ink stays out of the note
        const cur = await db.getNote(id); delete cur.ink[pid]; await db.putNote(cur);
        continue;
      }
      const sent = v.strokes;
      let res;
      try {
        res = await request('PUT', `/notes/${id}/ink/${pid}`, { baseInkRevision: v.revision, strokes: sent });
      } catch (e) {
        if (e.status === 404 && e.code === 'page_not_found') {
          const cur = await db.getNote(id); delete cur.ink[pid]; await db.putNote(cur);
          continue;
        }
        throw e;
      }
      const cur = await db.getNote(id);
      cur.ink[pid].revision = res.inkRevision;
      if (cur.ink[pid].strokes === sent || JSON.stringify(cur.ink[pid].strokes) === JSON.stringify(sent)) cur.ink[pid].dirty = false;
      await db.putNote(cur);
      rec = cur;
      last = { ...(last || {}), inkRevision: res.inkRevision };
    }
    const final = await db.getNote(id);
    return { status: 'saved', res: last, more: isPending(final) };
  } catch (e) {
    if (e.status === 0) return { status: 'offline', error: e };
    if (e.status === 409 && e.extra?.copyId) return conflict(id, e.extra.copyId);
    if (e.status === 404 && e.code === 'note_not_found') {
      // Deleted on the server while edited here: keep the work as a new note.
      const cur = await db.getNote(id);
      if (cur) {
        cur.create = { folderId: cur.folderId, title: cur.meta.title };
        cur.baseRevision = 0;
        for (const v of Object.values(cur.ink || {})) { v.revision = 0; v.dirty = true; }
        await db.putNote(cur);
      }
      return pushNow(id);
    }
    return { status: 'error', error: e };
  }
}

/** The server stored an attachment under another name: update every reference to it. */
function renameRefs(rec, renamed) {
  const fix = (n) => renamed[n] ?? n;
  for (const p of rec.pages.pages) {
    if (p.pdf) p.pdf.file = fix(p.pdf.file);
    for (const o of p.objects || []) {
      if (o.file) o.file = fix(o.file);
      if (o.view) o.view = fix(o.view);
    }
  }
  if (rec.meta.cover?.image) {
    rec.meta.cover.image = fix(rec.meta.cover.image);
    rec.pendingMeta = { ...(rec.pendingMeta || {}), cover: rec.meta.cover };
  }
  if (rec.pendingPdfText) {
    rec.pendingPdfText = Object.fromEntries(Object.entries(rec.pendingPdfText).map(([f, v]) => [fix(f), v]));
  }
}

/** The server stored our version as a conflict copy: keep both locally in sync with that. */
async function conflict(id, copyId) {
  const cur = await db.getNote(id);
  try {
    const copy = fromServer(await getNoteWithInk(copyId));
    // Handwriting of other pages not sent yet goes on in the copy, so nothing is lost.
    for (const [pid, v] of Object.entries(cur?.ink || {})) {
      if (v.dirty && copy.ink[pid]) copy.ink[pid] = { revision: copy.ink[pid].revision, strokes: v.strokes, dirty: true };
    }
    await db.putNote(copy);
  } catch { /* fetched later by prefetch */ }
  if (cur) await db.deleteNote(id);   // the server version of the original is fetched fresh
  return { status: 'conflict', copyId };
}

let flushing = null;

/** Pushes every note with local changes (except the one open in the editor). */
export function flushAll(skipId = null) {
  flushing ||= (async () => {
    let changed = false;
    for (const rec of await db.allNotes()) {
      if (!isPending(rec) || rec.id === skipId) continue;
      const r = await push(rec.id);
      if (r.status === 'offline') break;
      if (r.status === 'saved' || r.status === 'conflict') changed = true;
    }
    return changed;
  })().finally(() => { flushing = null; });
  return flushing;
}

let prefetching = null;

/** Keeps the editor's working cache (IndexedDB) consistent with the notes folder. */
export function prefetch(summaries) {
  prefetching ||= (async () => {
    const live = new Map(summaries.map((n) => [n.id, n]));
    const local = new Map((await db.allNotes()).map((r) => [r.id, r]));
    for (const [id, rec] of local) {
      if (!live.has(id) && !isPending(rec) && !db.isPinned(id)) { await db.deleteNote(id); await db.deleteNoteFiles(id); }
    }
    // Standalone app: the notes are already on this device, so nothing is downloaded.
    // Copies of notes opened earlier (the editor's working cache) are dropped when they
    // no longer match the folder, so the next opening reads the files again.
    for (const n of summaries) {
      const rec = local.get(n.id);
      if (rec && !isPending(rec) && !db.isPinned(n.id) && rec.serverStamp !== stamp(n.revision, n.modified)) {
        await db.deleteNote(n.id);
        await db.deleteNoteFiles(n.id);
      }
    }
  })().finally(() => { prefetching = null; });
  return prefetching;
}

export async function pendingCount() {
  return (await db.allNotes()).filter(isPending).length;
}
