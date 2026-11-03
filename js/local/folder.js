// "Cartella sul dispositivo": every note also lives as plain files in a folder the user
// chose (e.g. Documenti/Quadernone), in the same layout as Drive and the home server:
//
//   <Cartella>/.folder.json
//   <Cartella>/<Titolo>/meta.json pages.json note.md cover.png pdftext.json
//   <Cartella>/<Titolo>/ink/<pageId>.json previews/<pageId>.svg attachments/<file>
//   _trash/<note id>/… + trash.json
//
// IndexedDB (local/disk.js) stays the working copy, so writing is instant; this module
// mirrors it to the folder a moment after every change (File System Access API). If the
// browser's data is wiped, choosing the same folder again brings every note back: with an
// empty device, the folder's notes are imported (restore()).
//
// Permission: the folder handle is kept in disk kv. On a PC the browser can keep the
// permission ("Consenti a ogni visita"); on Android it is asked again after each restart,
// with one tap (reconnect()). Until then the notes are saved on the device as usual and
// the folder catches up as soon as it is reachable.
//
// Mirror state in disk kv: 'dir/handle', 'dir/n/<noteId>' = { dir, chg, dchg, files: { rel: sig } },
// 'dir/f/<folderId>' = { path, sig }.
import * as disk from './disk.js';
import { importSource } from './backup.js';
import { segment, unique, UNTITLED } from './names.js';
import { buildMarkdown } from './notefiles.js';

const HANDLE = 'dir/handle';
const NK = (id) => `dir/n/${id}`;
const FK = (id) => `dir/f/${id}`;
const range = (prefix) => IDBKeyRange.bound(prefix, prefix + '￿');
const DEBOUNCE_MS = 1500;

export const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

// Where the folder handle is kept. Automated tests replace it (window.__qnTestFolderStore):
// their stand-in folder cannot be stored in IndexedDB.
const handles = (typeof window !== 'undefined' && window.__qnTestFolderStore) || {
  load: () => disk.read(['kv'], (s) => s.kv.get(HANDLE)),
  save: (h) => disk.write(['kv'], (s) => (h ? s.kv.put(h, HANDLE) : s.kv.del(HANDLE))),
};

/** FNV-1a stamp of a text (to write only files whose content changed). */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + str.length;
}

class FolderMirror extends EventTarget {
  handle = null;
  /** none (no folder chosen) | needs-permission | ready | syncing | error | unsupported */
  state = supported ? 'none' : 'unsupported';
  message = '';
  lastSync = null;
  #timer = 0;
  #running = null;
  #again = false;

  get name() { return this.handle?.name || ''; }

  #set(state, message = '') {
    this.state = state;
    this.message = message;
    this.dispatchEvent(new Event('change'));
  }

  /** At start: picks up the saved folder and, if it is reachable, catches up. */
  async start() {
    if (!supported) return;
    disk.onChange((info) => { if (!info.remote && !info.fromFolder) this.schedule(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.schedule(0); });
    try { this.handle = (await handles.load()) || null; } catch { this.handle = null; }
    if (!this.handle) { this.#set('none'); return; }
    if (await this.#permission(false)) {
      this.#set('ready');
      await this.#afterConnect();
    } else this.#set('needs-permission');
  }

  /** Lets the user choose the folder (from a tap). Resolves to { restored } or null if cancelled. */
  async choose() {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'quadernone', mode: 'readwrite', startIn: 'documents' });
    } catch (e) {
      if (e?.name === 'AbortError') return null;
      throw e;
    }
    // Unrelated notes from an earlier folder must not be deleted from the new one.
    await this.#clearState();
    await handles.save(handle);
    this.handle = handle;
    this.#set('ready');
    return this.#afterConnect();
  }

  /** Asks again for the permission on the saved folder (must come from a tap). */
  async reconnect() {
    if (!this.handle) return this.choose();
    if (!(await this.#permission(true))) { this.#set('needs-permission'); return null; }
    this.#set('ready');
    return this.#afterConnect();
  }

  /** Stops writing to the folder (its files stay where they are). */
  async forget() {
    clearTimeout(this.#timer);
    await this.#clearState();
    await handles.save(null);
    this.handle = null;
    this.lastSync = null;
    this.#set('none');
  }

  #clearState() {
    return disk.write(['kv'], async (s) => {
      for (const k of [...await s.kv.keys(range('dir/n/')), ...await s.kv.keys(range('dir/f/'))]) await s.kv.del(k);
    });
  }

  async #permission(ask) {
    try {
      const opts = { mode: 'readwrite' };
      if ((await this.handle.queryPermission(opts)) === 'granted') return true;
      return ask && (await this.handle.requestPermission(opts)) === 'granted';
    } catch { return false; }
  }

  async #afterConnect() {
    let restored = 0;
    try { restored = await this.#restore(); } catch (e) { this.#set('error', e.message || String(e)); return { restored: 0 }; }
    await this.syncNow();
    return { restored };
  }

  schedule(ms = DEBOUNCE_MS) {
    if (!this.handle || this.state === 'needs-permission' || this.state === 'none') return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.syncNow(), ms);
  }

  /** Writes to the folder whatever changed since the last time. */
  async syncNow() {
    if (!this.handle) return;
    if (this.#running) { this.#again = true; return this.#running; }
    this.#running = (async () => {
      do {
        this.#again = false;
        if (!(await this.#permission(false))) { this.#set('needs-permission'); break; }
        this.#set('syncing');
        try {
          await this.#mirror();
          this.lastSync = new Date().toISOString();
          this.#set('ready');
        } catch (e) {
          if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') this.#set('needs-permission');
          else if (e?.name === 'NotFoundError') this.#set('error', 'La cartella non si trova più: sceglila di nuovo in Impostazioni.');
          else this.#set('error', e?.message || String(e));
          break;
        }
      } while (this.#again);
    })().finally(() => { this.#running = null; });
    return this.#running;
  }

  // ------------------------------------------------------------------ files

  async #dir(path, create = true) {
    let d = this.handle;
    for (const seg of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(seg, { create });
    return d;
  }

  async #write(dirPath, rel, data) {
    const parts = rel.split('/');
    const name = parts.pop();
    const d = await this.#dir([dirPath, ...parts].filter(Boolean).join('/'));
    const fh = await d.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }

  async #size(dirPath, rel) {
    try {
      const parts = rel.split('/');
      const name = parts.pop();
      const d = await this.#dir([dirPath, ...parts].filter(Boolean).join('/'), false);
      return (await (await d.getFileHandle(name)).getFile()).size;
    } catch { return -1; }
  }

  async #remove(path, { recursive = true } = {}) {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) return;
    try { await (await this.#dir(parts.join('/'), false)).removeEntry(name, { recursive }); } catch { /* gone already, or not empty */ }
  }

  // ------------------------------------------------------------------ mirror

  async #mirror() {
    const data = await disk.read(['folders', 'notes', 'kv'], async (s) => ({
      folders: await s.folders.all(), notes: await s.notes.all(),
      nkeys: await s.kv.keys(range('dir/n/')), nvals: await s.kv.all(range('dir/n/')),
      fkeys: await s.kv.keys(range('dir/f/')), fvals: await s.kv.all(range('dir/f/')),
    }));
    const nstate = new Map(data.nkeys.map((k, i) => [k.slice(6), data.nvals[i]]));
    const fstate = new Map(data.fkeys.map((k, i) => [k.slice(6), data.fvals[i]]));

    // Paths, exactly as the .zip export names them (names unique among siblings).
    const taken = new Map();
    const take = (parent, name) => {
      const used = taken.get(parent) || new Set();
      const n = unique(name, used);
      used.add(n);
      taken.set(parent, used);
      return n;
    };
    const byId = new Map(data.folders.map((f) => [f.id, f]));
    const fpath = new Map();
    const resolve = (f, guard = 0) => {
      if (fpath.has(f.id)) return fpath.get(f.id);
      const parent = f.parentId && guard < 100 ? byId.get(f.parentId) : null;
      const base = parent ? resolve(parent, guard + 1) + '/' : '';
      const p = base + take(base, segment(f.name, 'Cartella'));
      fpath.set(f.id, p);
      return p;
    };
    data.folders.forEach((f) => resolve(f));
    const npath = new Map();
    for (const n of data.notes) {
      if (n.trash) { npath.set(n.id, `_trash/${n.id}`); continue; }
      const base = n.folderId && fpath.has(n.folderId) ? fpath.get(n.folderId) + '/' : '';
      npath.set(n.id, base + take(base, segment(n.meta.title, UNTITLED)));
    }
    // Directories in use now: never removed when a note or folder leaves an old path.
    const live = new Set([...fpath.values(), ...npath.values()]);
    const inUse = (p) => [...live].some((x) => x === p || x.startsWith(p + '/'));

    // Folders: their .folder.json (written first, so a restore finds the folder names).
    for (const f of data.folders) {
      const path = fpath.get(f.id);
      const json = JSON.stringify({ version: 1, id: f.id, name: f.name, color: f.color ?? null, created: f.created }, null, 2);
      const st = fstate.get(f.id);
      if (st && st.path === path && st.sig === hash(json)) continue;
      await this.#write(path, '.folder.json', json);
      await disk.write(['kv'], (s) => s.kv.put({ path, sig: hash(json) }, FK(f.id)));
    }

    // Notes: only those changed (content, derived files or path) since the last time.
    for (const n of data.notes) {
      const dir = npath.get(n.id);
      const st = nstate.get(n.id);
      if (st && st.dir === dir && st.chg === n.chg && st.dchg === n.dchg) continue;
      const moved = !st || st.dir !== dir;
      const { ink, rows } = await disk.read(['ink', 'files'], async (s) => ({ ink: await s.ink.byNote(n.id), rows: await s.files.byNote(n.id) }));
      const want = [];   // { rel, data, sig, blob }
      const text = (rel, str) => want.push({ rel, data: str, sig: hash(str) });
      text('pages.json', JSON.stringify(n.pages, null, 1));
      text('note.md', n.markdown || buildMarkdown(n.meta.title, n.pages));
      if (n.trash) text('trash.json', JSON.stringify({ version: 1, id: n.id, ...n.trash }, null, 2));
      for (const r of ink) {
        if (r.strokes?.length) text(`ink/${r.pageId}.json`, JSON.stringify({ version: 1, pageId: r.pageId, revision: r.revision, strokes: r.strokes }));
      }
      for (const f of rows) want.push({ rel: f.path, data: f.blob, sig: `${f.blob.size}:${f.mtime || 0}`, blob: true });
      text('meta.json', JSON.stringify(n.meta, null, 2));   // last: the note is complete when it is there
      const old = moved ? {} : (st.files || {});
      const files = {};
      for (const x of want) {
        files[x.rel] = x.sig;
        if (old[x.rel] === x.sig) continue;
        // Big attachments already in the folder (after a restore) are not copied again.
        if (x.blob && moved && (await this.#size(dir, x.rel)) === x.data.size) continue;
        await this.#write(dir, x.rel, x.data);
      }
      for (const rel of Object.keys(old)) if (!(rel in files)) await this.#remove(`${dir}/${rel}`, { recursive: false });
      if (moved && st?.dir && !inUse(st.dir)) await this.#remove(st.dir);
      await disk.write(['kv'], (s) => s.kv.put({ dir, chg: n.chg, dchg: n.dchg, files }, NK(n.id)));
    }

    // Notes deleted for good: their folder goes too.
    const noteIds = new Set(data.notes.map((n) => n.id));
    for (const [id, st] of nstate) {
      if (noteIds.has(id)) continue;
      if (st.dir && !inUse(st.dir)) await this.#remove(st.dir);
      await disk.write(['kv'], (s) => s.kv.del(NK(id)));
    }
    // Folders deleted or renamed: the old directory goes, only if nothing else is left in it.
    const gone = [...fstate].filter(([id, st]) => !byId.has(id) || fpath.get(id) !== st.path)
      .sort((a, b) => b[1].path.split('/').length - a[1].path.split('/').length);
    for (const [id, st] of gone) {
      if (!inUse(st.path)) {
        await this.#remove(`${st.path}/.folder.json`, { recursive: false });
        await this.#remove(st.path, { recursive: false });
      }
      if (!byId.has(id)) await disk.write(['kv'], (s) => s.kv.del(FK(id)));
    }
  }

  // ------------------------------------------------------------------ restore

  /** With nothing on this device yet, imports the notes found in the folder. */
  async #restore() {
    const empty = await disk.read(['folders', 'notes'], async (s) => (await s.notes.count()) === 0 && (await s.folders.count()) === 0);
    if (!empty) return 0;
    const handles = new Map();   // path -> file handle
    const walk = async (d, prefix, depth) => {
      if (depth > 30) return;
      for await (const [name, h] of d.entries()) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (h.kind === 'file') handles.set(p, h);
        else await walk(h, p, depth + 1);
      }
    };
    await walk(this.handle, '', 0);
    if (![...handles.keys()].some((p) => /(^|\/)meta\.json$/.test(p))) return 0;
    this.#set('syncing', 'restore');
    const file = (p) => handles.get(p)?.getFile();
    const res = await importSource({
      paths: [...handles.keys()],
      text: async (p) => (handles.has(p) ? (await file(p)).text() : null),
      blob: (p) => file(p),
    }, { device: 'Cartella sul dispositivo' });
    disk.changed({ import: true, fromFolder: true });
    return res.imported;
  }
}

export const folderMirror = new FolderMirror();
