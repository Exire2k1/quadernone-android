// Library state: folders and note summaries from /api/tree, kept fresh by polling
// the change feed. Components listen to 'change' and 'status' events.
import { api, onReachability } from './api.js';
import * as prefs from './prefs.js';
import * as db from './local/db.js';
import { flushAll, prefetch, summaryOf, isPending } from './local/sync.js';

class Store extends EventTarget {
  folders = new Map();   // id -> { id, parentId, name, color, created }
  notes = new Map();     // id -> summary (see Notes::summary on the server)
  seq = null;
  trashCount = 0;
  serverSettings = { trashRetentionDays: 30 };
  status = 'checking';   // checking | ok | offline | unauthorized
  lastSync = prefs.get('lastSync');
  loaded = false;
  pending = 0;            // notes with changes not yet on the server
  openNoteId = null;      // the note open in the editor (pushed by the editor itself)
  #syncing = false;
  #timer = null;
  #polling = false;

  constructor() {
    super();
    onReachability((state) => this.#setStatus(state === 'online' ? 'ok' : state));
  }

  #setStatus(s) {
    if (s === 'ok') {
      this.lastSync = new Date().toISOString();
      prefs.set('lastSync', this.lastSync);
    }
    if (s !== this.status || s === 'ok') {
      this.status = s;
      this.dispatchEvent(new Event('status'));
    }
  }

  /**
   * Loads the tree from the server, or the last copy kept on the device when the
   * server is unreachable. Notes with local changes (or created offline) are merged in.
   */
  async load() {
    let data, online = true;
    try {
      data = await api.tree();
      if (this.status === 'ok') db.kvSet('tree', data).catch(() => {});
      else online = false;   // served from the service worker cache
    } catch (e) {
      data = await db.kvGet('tree');
      if (!data) throw e;
      online = false;
    }
    this.folders = new Map(data.folders.map((f) => [f.id, f]));
    this.notes = new Map(data.notes.map((n) => [n.id, n]));
    if (online) this.seq = data.seq;
    this.trashCount = data.trashCount;
    this.serverSettings = data.settings;
    await this.#mergeLocal();
    this.loaded = true;
    prefs.set('feedSeq', data.seq);
    this.dispatchEvent(new Event('change'));
    if (online) this.#sync(data.notes);
  }

  async #mergeLocal() {
    let pending = 0;
    for (const rec of await db.allNotes()) {
      if (!isPending(rec)) continue;
      pending++;
      const local = summaryOf(rec);
      const server = this.notes.get(rec.id);
      this.notes.set(rec.id, server ? { ...server, title: local.title, favorite: local.favorite, cover: local.cover, modified: local.modified, pending: true } : local);
    }
    this.pending = pending;
    this.dispatchEvent(new Event('status'));
  }

  /** Background: push local changes, then keep a device copy of every note. */
  async #sync(summaries) {
    if (this.#syncing) return;
    this.#syncing = true;
    try {
      const changed = await flushAll(this.openNoteId);
      if (changed) { this.#syncing = false; await this.load(); return; }
      await prefetch(summaries);
    } catch { /* retried on the next load */ } finally {
      this.#syncing = false;
    }
  }

  /** A note created offline: show it in the Library right away. */
  addLocal(rec) {
    this.notes.set(rec.id, summaryOf(rec));
    this.pending++;
    this.dispatchEvent(new Event('change'));
    this.dispatchEvent(new Event('status'));
  }

  /** Checks the change feed; reloads the tree when another device changed something. */
  async poll() {
    if (this.#polling) return;
    this.#polling = true;
    try {
      if (this.seq === null) { await this.load(); return; }
      const data = await api.changes(this.seq);
      const me = prefs.get('deviceName');
      // Reload also when this device still has changes to send (e.g. just back online).
      if (data.reset || this.pending > 0 || (data.changes || []).some((c) => c.device !== me || c.type === 'rescan')) {
        await this.load();
      } else {
        this.seq = data.seq;
      }
    } catch { /* status already reported by the api layer */ } finally {
      this.#polling = false;
    }
  }

  startPolling() {
    this.stopPolling();
    const every = Math.max(10, Number(prefs.get('syncIntervalSec')) || 30) * 1000;
    this.#timer = setInterval(() => { if (document.visibilityState === 'visible') this.poll(); }, every);
  }

  stopPolling() { clearInterval(this.#timer); }

  // ---- queries

  childFolders(parentId) {
    return [...this.folders.values()]
      .filter((f) => f.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name, 'it', { numeric: true, sensitivity: 'base' }));
  }

  /** Folder chain from the root to id (inclusive). */
  folderChain(id) {
    const out = [];
    let f = this.folders.get(id);
    for (let guard = 0; f && guard < 200; guard++) { out.unshift(f); f = this.folders.get(f.parentId); }
    return out;
  }

  isDescendant(id, ancestorId) {
    return this.folderChain(id).some((f) => f.id === ancestorId);
  }

  conflictCount() {
    let n = 0;
    for (const note of this.notes.values()) if (note.conflictOf) n++;
    return n;
  }

  /** Notes for a library view: { kind: 'all'|'favorites'|'recent'|'conflicts'|'folder', id }. */
  notesFor(view) {
    const all = [...this.notes.values()];
    const monthAgo = Date.now() - 30 * 86400000;
    switch (view.kind) {
      case 'favorites': return all.filter((n) => n.favorite);
      case 'recent': return all.filter((n) => Date.parse(n.modified) >= monthAgo);
      case 'conflicts': return all.filter((n) => n.conflictOf);
      case 'folder': return all.filter((n) => n.folderId === (view.id ?? null));
      default: return all;
    }
  }
}

export const store = new Store();

export function sortNotes(notes, sort) {
  const by = {
    modified: (a, b) => (b.modified || '').localeCompare(a.modified || ''),
    created: (a, b) => (b.created || '').localeCompare(a.created || ''),
    name: (a, b) => a.title.localeCompare(b.title, 'it', { numeric: true, sensitivity: 'base' }),
  }[sort] || ((a, b) => 0);
  return [...notes].sort(by);
}
