// The open note: meta + pages.json + handwriting per page, undo/redo, and autosave.
//
// Every edit is one undo step: pages.json snapshots and/or ink changes (old and new
// stroke arrays of a page; strokes are never mutated in place, so keeping the arrays is
// cheap). Changes are stored on the device right away (IndexedDB) and pushed to the
// server ~1.5 s after the last change by local/sync.js, which handles conflicts and offline.
import * as db from '../local/db.js';
import { push } from '../local/sync.js';

// Kept away from the strokes: storing runs on the main thread, so it waits for a pause.
const SAVE_DELAY_MS = 1500;
const PERSIST_DELAY_MS = 500;
const MAX_UNDO = 150;

export class NoteDoc extends EventTarget {
  /** rec: a local record (see local/db.js). */
  constructor(rec) {
    super();
    this.meta = rec.meta;
    this.pages = rec.pages;            // the whole pages.json object
    this.folderId = rec.folderId;
    this.path = rec.path;
    this.sizeBytes = rec.sizeBytes;
    this.localOnly = !!rec.create;
    this.ink = new Map();              // pageId -> stroke array
    for (const [pid, v] of Object.entries(rec.ink || {})) this.ink.set(pid, v.strokes || []);
    this.undoStack = [];
    this.redoStack = [];
    this.pendingMeta = null;           // meta changes not yet written to the device
    const pending = rec.dirty || Object.values(rec.ink || {}).some((v) => v.dirty);
    this.state = pending ? 'pending' : 'saved';   // saved | pending | saving | offline | error
    this.#lastPersisted = JSON.stringify(this.pages);
    this.#hasLocalChanges = pending;
    this.#pageHashes = new Map(this.pages.pages.map((p) => [p.id, this.#pageHash(p)]));
  }
  #timer = 0;
  #persistTimer = 0;
  #persisting = Promise.resolve();
  #lastPersisted = '';
  #inkDirty = new Set();   // pages whose ink changed since the last write to the device
  #inkSerial = new Map();  // pageId -> change counter (for previews)
  #hasLocalChanges = false;
  #pageHashes;
  #retryMs = 0;
  #batch = null;

  get id() { return this.meta.id; }
  get list() { return this.pages.pages; }
  strokes(pageId) { return this.ink.get(pageId) || []; }

  // ------------------------------------------------------------------ edits

  /**
   * Runs fn() as one undoable step. fn may mutate this.pages and call setInk().
   * Returns true if anything changed.
   */
  transact(fn) {
    const before = JSON.stringify(this.pages);
    this.#batch = [];
    let inkOps;
    try { fn(); } finally {
      inkOps = this.#batch;
      this.#batch = null;
    }
    const after = JSON.stringify(this.pages);
    const pagesChanged = after !== before;
    if (!pagesChanged && !inkOps.length) return false;
    this.#pushUndo({ pages: pagesChanged ? [before, after] : null, ink: inkOps });
    return true;
  }

  /** Alias kept for page-level edits. */
  change(fn) { return this.transact(fn); }

  /** Records an already-applied pages.json change, given the JSON from before it. */
  record(beforeJson) {
    const after = JSON.stringify(this.pages);
    if (beforeJson === after) return;
    this.#pushUndo({ pages: [beforeJson, after], ink: [] });
  }

  /** Replaces the strokes of a page (one undo step, or part of the current transact()). */
  setInk(pageId, strokes) {
    const before = this.strokes(pageId);
    if (before === strokes) return;
    this.#applyInk(pageId, strokes);
    const op = { pageId, before, after: strokes };
    if (this.#batch) this.#batch.push(op);
    else this.#pushUndo({ pages: null, ink: [op] });
  }

  #applyInk(pageId, strokes) {
    this.ink.set(pageId, strokes);
    this.#inkDirty.add(pageId);
    this.#inkSerial.set(pageId, (this.#inkSerial.get(pageId) || 0) + 1);
  }

  #pushUndo(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.#touched();
  }

  snapshot() { return JSON.stringify(this.pages); }

  undo() { return this.#step(this.undoStack, this.redoStack, 0); }
  redo() { return this.#step(this.redoStack, this.undoStack, 1); }

  /** side 0 = restore "before", 1 = restore "after". */
  #step(from, to, side) {
    const entry = from.pop();
    if (!entry) return false;
    if (entry.pages) {
      // Keep the same objects so references held by the view stay valid.
      const restored = JSON.parse(entry.pages[side]);
      this.pages.defaults = restored.defaults;
      this.pages.pages.splice(0, this.pages.pages.length, ...restored.pages);
    }
    const ops = side === 0 ? [...entry.ink].reverse() : entry.ink;
    for (const op of ops) this.#applyInk(op.pageId, side === 0 ? op.before : op.after);
    to.push(entry);
    this.#touched();
    this.dispatchEvent(new CustomEvent('restored', { detail: { pages: !!entry.pages, inkPages: entry.ink.map((o) => o.pageId) } }));
    return true;
  }

  setMeta(patch) {
    Object.assign(this.meta, patch);
    this.pendingMeta = { ...(this.pendingMeta || {}), ...patch };
    this.#touched();
  }

  #touched() {
    this.#hasLocalChanges = true;
    this.#setState('pending');
    this.dispatchEvent(new Event('change'));
    clearTimeout(this.#persistTimer);
    this.#persistTimer = setTimeout(() => this.persist(), PERSIST_DELAY_MS);
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  #setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new Event('state'));
  }

  get hasUnsaved() { return this.state !== 'saved'; }

  // ------------------------------------------------------------------ device storage

  /** Writes the current state to IndexedDB (marks what changed as not yet on the server). */
  persist() {
    clearTimeout(this.#persistTimer);
    const pagesJson = JSON.stringify(this.pages);
    const meta = this.pendingMeta;
    const inkPages = [...this.#inkDirty].map((pid) => [pid, this.strokes(pid)]);
    const pagesChanged = pagesJson !== this.#lastPersisted;
    if (!pagesChanged && !meta && !inkPages.length) return this.#persisting;
    this.pendingMeta = null;
    this.#inkDirty.clear();
    this.#lastPersisted = pagesJson;
    this.#persisting = this.#persisting.then(async () => {
      const cur = await db.getNote(this.id);
      if (!cur) return;   // removed meanwhile (e.g. replaced by a conflict copy)
      if (pagesChanged || meta) {
        cur.pages = JSON.parse(pagesJson);
        // Revisions are owned by sync.js: never overwrite them from here.
        cur.meta = { ...this.meta, revision: cur.meta.revision };
        if (meta) cur.pendingMeta = { ...(cur.pendingMeta || {}), ...meta };
        cur.dirty = true;
      }
      cur.ink ||= {};
      for (const [pid, strokes] of inkPages) {
        cur.ink[pid] = { revision: cur.ink[pid]?.revision ?? 0, strokes, dirty: true };
      }
      cur.meta.modified = new Date().toISOString();
      await db.putNote(cur);
    }).catch(() => {});
    return this.#persisting;
  }

  /**
   * Marks work for the next push that is not in pages.json: attachments still only on
   * this device, and PDF text for search ({ [file]: [{ pageIndex, text }] }).
   */
  addPending({ files = false, pdfText = null } = {}) {
    this.#persisting = this.#persisting.then(async () => {
      const cur = await db.getNote(this.id);
      if (!cur) return;
      if (files) cur.pendingFiles = true;
      if (pdfText) cur.pendingPdfText = { ...(cur.pendingPdfText || {}), ...pdfText };
      await db.putNote(cur);
    }).catch(() => {});
    this.#hasLocalChanges = true;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.save(), SAVE_DELAY_MS);
    return this.#persisting;
  }

  // ------------------------------------------------------------------ server

  /** Stores locally and pushes to the server. Resolves when the push attempt is over. */
  async save() {
    clearTimeout(this.#timer);
    await this.persist();
    if (!this.#hasLocalChanges && this.state === 'saved') return;
    this.#setState('saving');
    const r = await push(this.id);
    if (r.status === 'saved' || r.status === 'clean') {
      this.#retryMs = 0;
      if (r.res) {
        this.meta.revision = r.res.revision ?? this.meta.revision;
        this.localOnly = false;
        if (r.res.note) this.folderId = r.res.note.folderId;
        this.dispatchEvent(new CustomEvent('saved', { detail: r.res }));
      }
      if (r.more || this.pendingMeta || this.#inkDirty.size || JSON.stringify(this.pages) !== this.#lastPersisted) {
        this.#setState('pending');
        this.#timer = setTimeout(() => this.save(), 300);
      } else {
        this.#hasLocalChanges = false;
        this.#setState('saved');
      }
    } else if (r.status === 'conflict') {
      this.#hasLocalChanges = false;
      this.#setState('saved');
      this.dispatchEvent(new CustomEvent('conflict', { detail: { copyId: r.copyId } }));
    } else {
      // Offline: everything is on the device; try again later (2 s … 60 s, or when back online).
      this.#setState(r.status === 'offline' ? 'offline' : 'error');
      if (r.status === 'error') this.dispatchEvent(new CustomEvent('saveerror', { detail: r.error }));
      this.#retryMs = Math.min(60000, (this.#retryMs || 1000) * 2);
      this.#timer = setTimeout(() => this.save(), this.#retryMs);
    }
  }

  #pageHash(p) { return JSON.stringify(p) + '|' + (this.#inkSerial.get(p.id) || 0); }

  /** Pages whose content (objects or ink) changed since their preview was last generated. */
  takeChangedPages() {
    const out = [];
    for (const p of this.list) {
      const h = this.#pageHash(p);
      if (this.#pageHashes.get(p.id) !== h) { out.push(p); this.#pageHashes.set(p.id, h); }
    }
    return out;
  }

  /** Forget that a page's preview is up to date (e.g. upload failed). */
  invalidatePreview(pageId) { this.#pageHashes.delete(pageId); }

  dispose() { clearTimeout(this.#timer); clearTimeout(this.#persistTimer); }
}
