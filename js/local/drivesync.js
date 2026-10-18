// Google Drive sync: keeps a copy of the device "disk" (local/disk.js) in the user's Drive,
// with the same readable layout the home server had:
//
//   Quadernone/                      (appProperties qk=root)
//     _cestino/                      (qk=trash)  deleted notes
//     Università/                    (qk=folder, qid=<folder id>)
//       Lezione MIMO/                (qk=note, qid=<note id>, v=<version>)
//         meta.json  pages.json  note.md  cover.png  pdftext.json  trash.json
//         ink/<pageId>.json  previews/<pageId>.svg  attachments/<file>
//
// Versions: every note folder carries v (appProperties), bumped by each device's push AFTER
// all its files are uploaded (the commit point, like meta.json on the server). A device
// remembers the v it last saw for each note. When both the note here and the note on Drive
// changed since then, nothing is overwritten: the version on this device becomes a conflict
// copy (a new note) and the original takes the Drive version — the same rule as the server.
//
// Local state in disk kv: 'drive/root', 'drive/n/<noteId>', 'drive/f/<folderId>'.
import * as disk from './disk.js';
import { drive, DriveError, FOLDER_MIME } from './drive.js';
import { appendFeed, conflictCopy, hooks } from './server.js';
import { ServerError } from './errors.js';
import { buildMarkdown, snippetOf } from './notefiles.js';
import { segment, UNTITLED, now } from './names.js';
import * as files from './files.js';
import * as prefs from '../prefs.js';

const NOTE_STORES = ['folders', 'notes', 'ink', 'files', 'feed', 'kv'];
const DEVICE_DRIVE = 'Google Drive';
const NK = (id) => `drive/n/${id}`;
const FK = (id) => `drive/f/${id}`;
const range = (prefix) => IDBKeyRange.bound(prefix, prefix + '￿');
const SUBS = ['ink', 'previews', 'attachments'];

/** FNV-1a: cheap stamp of a file's content (to know what changed since the last upload). */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + str.length;
}

const deviceName = () => prefs.get('deviceName') || 'Questo dispositivo';
const jsonBlob = (v, indent) => new Blob([JSON.stringify(v, null, indent)], { type: 'application/json' });

/** The files of a note as they go to Drive: path -> { stamp, blob() }. */
function noteFiles(n, inkRows, fileRows) {
  const out = new Map();
  const add = (path, text, type) => out.set(path, { stamp: hash(text), blob: () => new Blob([text], { type }) });
  add('meta.json', JSON.stringify(n.meta, null, 2), 'application/json');
  add('pages.json', JSON.stringify(n.pages, null, 1), 'application/json');
  add('note.md', n.markdown || buildMarkdown(n.meta.title, n.pages), 'text/markdown');
  if (n.trash) add('trash.json', JSON.stringify({ version: 1, id: n.id, ...n.trash }, null, 2), 'application/json');
  const rows = new Map(inkRows.map((r) => [r.pageId, r]));
  for (const p of n.pages.pages) {
    const r = rows.get(p.id);
    if (!r?.strokes?.length) continue;
    out.set(`ink/${p.id}.json`, { stamp: `r${r.revision}:${r.strokes.length}`,
      blob: () => jsonBlob({ version: 1, pageId: p.id, revision: r.revision, strokes: r.strokes }) });
  }
  for (const f of fileRows) out.set(f.path, { stamp: `m${f.mtime}:${f.blob.size}`, blob: () => f.blob, size: f.blob.size });
  return out;
}

class DriveSync extends EventTarget {
  state = 'off';          // off | idle | syncing | offline | auth | error | setup
  message = '';
  lastSync = prefs.get('driveLastSync') || null;
  pending = 0;
  progress = null;        // { done, total } while uploading or downloading many notes
  #running = null;
  #again = false;
  #timer = 0;
  #debounce = 0;
  #store = null;
  #root = null;           // { rootId, trashId }

  start(store) {
    this.#store = store;
    hooks.convertPptx = (blob, name) => this.#convertPptx(blob, name);
    // While a note is open, its handwriting is uploaded every 15 s at most; on leaving, at once.
    disk.onChange((info) => { if (!info.fromDrive) { this.countPending(); this.#schedule(this.#store?.openNoteId ? 15000 : 4000); } });
    drive.addEventListener('change', () => { this.#refreshState(); if (drive.ready) this.#schedule(500); });
    drive.addEventListener('accountchange', () => this.resetState());
    addEventListener('online', () => this.#schedule(1000));
    document.addEventListener('visibilitychange', () => this.#schedule(document.visibilityState === 'visible' ? 1500 : 0));
    this.#timer = setInterval(() => { if (document.visibilityState === 'visible') this.#schedule(0); }, 60000);
    this.#refreshState();
    this.#schedule(1500);
  }

  #emit() { this.dispatchEvent(new Event('change')); }

  #set(state, message = '') {
    if (state === this.state && message === this.message) return;
    this.state = state;
    this.message = message;
    this.#emit();
  }

  #refreshState() {
    if (!drive.connected) this.#set('off');
    else if (!drive.token) this.#set('auth', 'Tocca per ricollegare Google Drive.');
    else if (this.state === 'off' || this.state === 'auth') this.#set('idle');
    this.countPending();
  }

  #schedule(ms) {
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => this.syncNow().catch(() => {}), ms);
  }

  /** Notes and folders with changes not yet on Drive. */
  async countPending() {
    const n = await disk.read(['notes', 'folders', 'kv'], async (s) => {
      const keys = await s.kv.keys(range('drive/n/'));
      const vals = await s.kv.all(range('drive/n/'));
      const byId = new Map(keys.map((k, i) => [k.slice(8), vals[i]]));
      let count = 0;
      for (const note of await s.notes.all()) {
        const x = byId.get(note.id);
        if (!x || x.chg !== note.chg || x.dchg !== note.dchg || (!x.folderId && !x.localOnly)) count++;
      }
      const fkeys = new Set((await s.kv.keys(range('drive/f/'))).map((k) => k.slice(8)));
      for (const f of await s.folders.all()) if (!fkeys.has(f.id)) count++;
      return count + ((await s.kv.get('tombstones')) || []).length;
    }).catch(() => 0);
    if (n !== this.pending) { this.pending = n; this.#emit(); }
    return n;
  }

  /** Runs one sync (or queues one more after the running one). interactive: from a tap. */
  async syncNow({ interactive = false } = {}) {
    if (!drive.connected) { this.#set('off'); return; }
    if (!drive.token) {
      if (!interactive) { this.#set('auth', 'Tocca per ricollegare Google Drive.'); return; }
      try { await drive.signIn(); } catch (e) { this.#set('auth', e.message); throw e; }
    }
    if (this.#running) { this.#again = true; return this.#running; }
    this.#running = (async () => {
      do {
        this.#again = false;
        this.#set('syncing');
        try {
          await this.#syncOnce();
          this.lastSync = now();
          prefs.set('driveLastSync', this.lastSync);
          this.#set('idle');
        } catch (e) {
          console.warn('Drive sync:', e);
          const kind = e instanceof DriveError ? e.kind : 'error';
          this.#set(kind === 'offline' ? 'offline' : kind === 'auth' ? 'auth' : 'error', e.message || String(e));
          if (kind === 'rate') this.#schedule(30000);
          break;
        } finally {
          this.progress = null;
          await this.countPending();
        }
      } while (this.#again);
    })().finally(() => { this.#running = null; });
    return this.#running;
  }

  /** Forgets what was uploaded (another Google account, or the Drive folder was deleted). */
  async resetState() {
    await disk.write(['kv'], async (s) => {
      for (const k of [...await s.kv.keys(range('drive/n/')), ...await s.kv.keys(range('drive/f/'))]) await s.kv.del(k);
      await s.kv.del('drive/root');
    });
    this.#root = null;
    this.#schedule(500);
  }

  // ---------------------------------------------------------------- one round

  async #syncOnce() {
    const root = await this.#ensureRoot();
    await this.#tombstones(root);
    const remoteFolders = await drive.list(`appProperties has { key='qk' and value='folder' } and trashed=false`);
    const folderMap = await this.#pullFolders(root, remoteFolders);
    await this.#pushFolders(root, folderMap);
    const remoteNotes = await drive.list(`appProperties has { key='qk' and value='note' } and trashed=false`, 'id,name,parents,appProperties');
    await this.#pullNotes(root, remoteNotes, folderMap);
    await this.#pushNotes(root);
    // A fresh list: folders created by this round's push are on Drive now.
    await this.#dropDeletedFolders(await drive.list(`appProperties has { key='qk' and value='folder' } and trashed=false`));
  }

  async #ensureRoot() {
    if (this.#root) return this.#root;
    let saved = await disk.read(['kv'], (s) => s.kv.get('drive/root'));
    if (saved) {
      try {
        const r = await drive.get(saved.rootId);
        if (r.trashed) throw new DriveError('notfound', 'trashed');
      } catch (e) {
        if (e.kind !== 'notfound') throw e;
        // The Quadernone folder was deleted on Drive: upload everything again into a new one.
        await this.resetState();
        saved = null;
      }
    }
    if (!saved) {
      const roots = await drive.list(`appProperties has { key='qk' and value='root' } and trashed=false`, 'id,createdTime');
      roots.sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)));
      const rootId = roots[0]?.id || (await drive.createFolder('Quadernone', null, { qk: 'root' })).id;
      const trashes = await drive.list(`appProperties has { key='qk' and value='trash' } and trashed=false and '${rootId}' in parents`, 'id,createdTime');
      trashes.sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)));
      const trashId = trashes[0]?.id || (await drive.createFolder('_cestino', rootId, { qk: 'trash' })).id;
      saved = { rootId, trashId, account: drive.account?.email || '' };
      await disk.write(['kv'], (s) => s.kv.put(saved, 'drive/root'));
    }
    this.#root = saved;
    return saved;
  }

  async #tombstones(root) {
    const { tomb, states } = await disk.read(['kv'], async (s) => {
      const tomb = (await s.kv.get('tombstones')) || [];
      const states = {};
      for (const t of tomb) states[t.kind + t.id] = await s.kv.get(t.kind === 'note' ? NK(t.id) : FK(t.id));
      return { tomb, states };
    });
    if (!tomb.length) return;
    for (const t of tomb) {
      const st = states[t.kind + t.id];
      try {
        if (t.kind === 'note' && st?.folderId) await drive.trash(st.folderId);
        if (t.kind === 'folder' && st?.driveId) {
          // Anything another device put in this folder meanwhile is moved to the top, never lost.
          const kids = await drive.list(`'${st.driveId}' in parents and trashed=false and (appProperties has { key='qk' and value='note' } or appProperties has { key='qk' and value='folder' })`, 'id');
          for (const k of kids) await drive.update(k.id, {}, { addParents: root.rootId, removeParents: st.driveId });
          await drive.trash(st.driveId);
        }
      } catch (e) {
        if (e.kind !== 'notfound') throw e;
      }
    }
    await disk.write(['kv'], async (s) => {
      const cur = (await s.kv.get('tombstones')) || [];
      const done = new Set(tomb.map((t) => t.kind + t.id + t.time));
      await s.kv.put(cur.filter((t) => !done.has(t.kind + t.id + t.time)), 'tombstones');
      for (const t of tomb) await s.kv.del(t.kind === 'note' ? NK(t.id) : FK(t.id));
    });
  }

  // ---------------------------------------------------------------- folders

  /** Applies folder changes made on other devices. Returns driveId <-> folderId maps. */
  async #pullFolders(root, remote) {
    const byQid = new Map(remote.filter((r) => r.appProperties?.qid).map((r) => [r.appProperties.qid, r]));
    const qidOf = new Map(remote.map((r) => [r.id, r.appProperties?.qid]));
    await disk.write(NOTE_STORES, async (s) => {
      const tomb = new Set(((await s.kv.get('tombstones')) || []).filter((t) => t.kind === 'folder').map((t) => t.id));
      const local = new Map((await s.folders.all()).map((f) => [f.id, f]));
      const parentOf = (r) => {
        const p = (r.parents || []).map((id) => qidOf.get(id)).find(Boolean);
        return p && (local.has(p) || byQid.has(p)) ? p : null;
      };
      // Parents before children.
      const order = [];
      const seen = new Set();
      const visit = (qid, depth = 0) => {
        if (seen.has(qid) || depth > 100) return;
        seen.add(qid);
        const p = parentOf(byQid.get(qid));
        if (p && byQid.has(p)) visit(p, depth + 1);
        order.push(qid);
      };
      for (const qid of byQid.keys()) visit(qid);
      for (const qid of order) {
        if (tomb.has(qid)) continue;
        const r = byQid.get(qid);
        const st = await s.kv.get(FK(qid));
        const f = local.get(qid);
        const want = { name: r.name, parentId: parentOf(r), color: r.appProperties.c || null };
        if (!f) {
          const nf = { id: qid, ...want, created: r.appProperties.cr || now(), chg: 1 };
          await s.folders.put(nf);
          local.set(qid, nf);
          await s.kv.put({ driveId: r.id, chg: 1 }, FK(qid));
          await appendFeed(s, { type: 'folder.created', kind: 'folder', id: qid, parentId: nf.parentId }, DEVICE_DRIVE);
        } else if (!st || st.chg === f.chg) {
          if (f.name !== want.name || f.parentId !== want.parentId || (f.color ?? null) !== want.color) {
            Object.assign(f, want);
            f.chg = (f.chg || 0) + 1;
            await s.folders.put(f);
            await appendFeed(s, { type: 'folder.renamed', kind: 'folder', id: qid, parentId: f.parentId }, DEVICE_DRIVE);
          }
          await s.kv.put({ driveId: r.id, chg: f.chg }, FK(qid));
        }
        // else: changed here too: this device's version is pushed next.
      }
    });
    return this.#folderMap(root);
  }

  async #folderMap(root) {
    return disk.read(['kv', 'folders'], async (s) => {
      const keys = await s.kv.keys(range('drive/f/'));
      const vals = await s.kv.all(range('drive/f/'));
      const toDrive = new Map(keys.map((k, i) => [k.slice(8), vals[i].driveId]));
      const toLocal = new Map([...toDrive].map(([a, b]) => [b, a]));
      return { toDrive, toLocal, root };
    });
  }

  async #pushFolders(root, map) {
    const { folders, states } = await disk.read(['folders', 'kv'], async (s) => {
      const folders = await s.folders.all();
      const states = new Map();
      for (const f of folders) states.set(f.id, await s.kv.get(FK(f.id)));
      return { folders, states };
    });
    const depth = (f) => { let d = 0; for (let p = f; p?.parentId && d < 100; p = folders.find((x) => x.id === p.parentId)) d++; return d; };
    for (const f of [...folders].sort((a, b) => depth(a) - depth(b))) {
      const st = states.get(f.id);
      if (st && st.chg === f.chg) continue;
      const parent = f.parentId ? map.toDrive.get(f.parentId) : root.rootId;
      if (!parent) continue;   // its parent could not be created: next round
      const props = { qk: 'folder', qid: f.id, c: f.color || '', cr: f.created || '' };
      let driveId = st?.driveId;
      if (!driveId) {
        driveId = (await drive.createFolder(f.name, parent, props)).id;
      } else {
        let cur;
        try { cur = await drive.get(driveId, 'id,parents,trashed'); } catch (e) { if (e.kind !== 'notfound') throw e; }
        if (!cur || cur.trashed) driveId = (await drive.createFolder(f.name, parent, props)).id;
        else {
          const move = !(cur.parents || []).includes(parent);
          await drive.update(driveId, { name: f.name, appProperties: props }, move ? { addParents: parent, removeParents: (cur.parents || []).join(',') } : {});
        }
      }
      map.toDrive.set(f.id, driveId);
      map.toLocal.set(driveId, f.id);
      await disk.write(['kv'], (s) => s.kv.put({ driveId, chg: f.chg }, FK(f.id)));
    }
  }

  /** Folders deleted on another device: removed here once nothing of this device is in them. */
  async #dropDeletedFolders(remote) {
    const alive = new Set(remote.map((r) => r.appProperties?.qid).filter(Boolean));
    await disk.write(NOTE_STORES, async (s) => {
      const folders = await s.folders.all();
      const notes = (await s.notes.all()).filter((n) => !n.trash);
      for (const f of folders) {
        const st = await s.kv.get(FK(f.id));
        if (!st || alive.has(f.id) || st.chg !== f.chg) continue;
        const sub = [f.id];
        for (let i = 0; i < sub.length; i++) for (const x of folders) if (x.parentId === sub[i]) sub.push(x.id);
        if (notes.some((n) => sub.includes(n.folderId)) || folders.some((x) => x.parentId === f.id)) {
          await s.kv.del(FK(f.id));   // still used here: uploaded again next round
          continue;
        }
        await s.folders.del(f.id);
        await s.kv.del(FK(f.id));
        await appendFeed(s, { type: 'folder.deleted', kind: 'folder', id: f.id, parentId: f.parentId }, DEVICE_DRIVE);
      }
    });
  }

  // ---------------------------------------------------------------- notes: pull

  async #pullNotes(root, remote, map) {
    const { local, states, tomb } = await disk.read(['notes', 'kv'], async (s) => {
      const keys = await s.kv.keys(range('drive/n/'));
      const vals = await s.kv.all(range('drive/n/'));
      return { local: new Map((await s.notes.all()).map((n) => [n.id, n])), states: new Map(keys.map((k, i) => [k.slice(8), vals[i]])),
        tomb: new Set(((await s.kv.get('tombstones')) || []).filter((t) => t.kind === 'note').map((t) => t.id)) };
    });
    const openId = this.#store?.openNoteId;
    const todo = [];
    const seen = new Set();
    for (const r of remote) {
      const qid = r.appProperties?.qid;
      const v = Number(r.appProperties?.v || 0);
      if (!qid || !v || seen.has(qid)) continue;   // v=0: another device is still uploading it
      seen.add(qid);
      if (tomb.has(qid)) continue;
      const st = states.get(qid);
      const n = local.get(qid);
      if (st && st.v === v && st.folderId === r.id && n) continue;
      if (qid === openId) continue;   // open in the editor: after it is closed
      todo.push({ r, v, n, st });
    }
    let done = 0;
    if (todo.length > 3) { this.progress = { done, total: todo.length, what: 'down' }; this.#emit(); }
    for (const it of todo) {
      // Changed here too since the last sync (or never synced): this device's version is kept as a copy.
      const dirty = it.n && (!it.st || it.st.chg !== it.n.chg);
      if (dirty) await this.#keepLocalAsCopy(it.n);
      await this.#importNote(it.r, it.v, it.st, map, root);
      done++;
      if (this.progress) { this.progress = { ...this.progress, done }; this.#emit(); }
    }
    // Notes gone from Drive (deleted for good on another device).
    for (const [id, st] of states) {
      if (seen.has(id) || tomb.has(id) || !st.folderId) continue;
      await disk.write(NOTE_STORES, async (s) => {
        await s.kv.del(NK(id));
        const cur = await s.notes.get(id);
        if (!cur || cur.chg !== st.chg) return;   // changed here: uploaded again as a new note
        if (cur.trash) {
          for (const k of await s.ink.keysByNote(id)) await s.ink.del(k);
          for (const k of await s.files.keysByNote(id)) await s.files.del(k);
          await s.notes.del(id);
          await appendFeed(s, { type: 'note.purged', kind: 'note', id }, DEVICE_DRIVE);
        } else {
          // Never delete a live note because it is missing on Drive: it goes to the trash here.
          cur.trash = { deleted: now(), device: DEVICE_DRIVE, originalTitle: cur.meta.title, originalFolders: [] };
          cur.chg = (cur.chg || 0) + 1;
          await s.notes.put(cur);
          // Kept on this device only; uploaded again only if it is restored or changed here.
          await s.kv.put({ folderId: null, sub: {}, files: {}, v: 0, chg: cur.chg, dchg: cur.dchg, localOnly: true }, NK(id));
          await appendFeed(s, { type: 'note.trashed', kind: 'note', id, parentId: cur.folderId }, DEVICE_DRIVE);
        }
      });
    }
  }

  /** This device's version of a note changed on Drive too: it becomes a conflict copy. */
  async #keepLocalAsCopy(n) {
    await disk.write(NOTE_STORES, async (s) => {
      const cur = await s.notes.get(n.id);
      if (!cur) return;
      const copy = await conflictCopy(s, cur, cur.meta, cur.pages, cur.meta.revision | 0, deviceName());
      if (cur.trash) { copy.trash = null; await s.notes.put(copy); }
    });
  }

  /** Downloads a note from Drive into this device (new note, or replacing the local one). */
  async #importNote(r, v, st, map, root) {
    const kids = await drive.list(`'${r.id}' in parents and trashed=false`, 'id,name,mimeType,md5Checksum,size');
    const remote = new Map();   // path -> file
    const sub = {};
    for (const k of kids) {
      if (k.mimeType === FOLDER_MIME && SUBS.includes(k.name)) {
        sub[k.name] = k.id;
        for (const g of await drive.list(`'${k.id}' in parents and trashed=false`, 'id,name,md5Checksum,size')) remote.set(`${k.name}/${g.name}`, g);
      } else if (k.mimeType !== FOLDER_MIME) remote.set(k.name, k);
    }
    if (!remote.has('meta.json') || !remote.has('pages.json')) return;   // incomplete: next round
    const text = async (path) => (remote.has(path) ? (await drive.download(remote.get(path).id)).text() : null);
    const meta = JSON.parse(await text('meta.json'));
    const pages = JSON.parse(await text('pages.json'));
    const trashInfo = remote.has('trash.json') ? JSON.parse(await text('trash.json')) : null;
    const inks = {};
    for (const p of pages.pages || []) {
      const path = `ink/${p.id}.json`;
      if (remote.has(path)) inks[p.id] = JSON.parse(await text(path)).strokes || [];
    }
    // Binary files: only what changed (same md5 as last time = already on this device).
    const blobs = new Map();
    for (const [path, f] of remote) {
      if (!/^(attachments|previews)\//.test(path) && path !== 'cover.png' && path !== 'pdftext.json') continue;
      if (st?.files?.[path]?.md5 && st.files[path].md5 === f.md5Checksum) continue;
      blobs.set(path, await drive.download(f.id));
    }
    const qid = r.appProperties.qid;
    const parent = (r.parents || [])[0];
    const inTrash = parent === root.trashId;
    const folderId = inTrash ? (trashInfo?.originalFolders?.slice(-1)[0]?.id ?? null) : (map.toLocal.get(parent) ?? null);

    const result = await disk.write(NOTE_STORES, async (s) => {
      const n = await s.notes.get(qid);
      const localInk = new Map((await s.ink.byNote(qid)).map((x) => [x.pageId, x]));
      const folderOk = folderId === null || !!(await s.folders.get(folderId));
      for (const p of pages.pages) {
        const li = localInk.get(p.id);
        const rs = inks[p.id] || [];
        const same = li ? JSON.stringify(li.strokes) === JSON.stringify(rs) : !rs.length;
        p.inkRevision = same ? (li?.revision ?? 0) : Math.max(li?.revision | 0, p.inkRevision | 0) + 1;
        if (!same) await s.ink.put({ key: disk.inkKey(qid, p.id), noteId: qid, pageId: p.id, revision: p.inkRevision, strokes: rs });
      }
      const ids = new Set(pages.pages.map((p) => p.id));
      for (const k of localInk.keys()) if (!ids.has(k)) await s.ink.del(disk.inkKey(qid, k));
      const existing = new Map((await s.files.byNote(qid)).map((f) => [f.path, f]));
      for (const [path, f] of existing) {
        if (!remote.has(path)) await s.files.del(f.key);
      }
      let coverChanged = false;
      for (const [path, blob] of blobs) {
        await s.files.put({ key: disk.fileKey(qid, path), noteId: qid, path, blob, mtime: Date.now() });
        if (path === 'cover.png') coverChanged = true;
      }
      const m = { ...meta, id: qid, revision: n ? (n.meta.revision | 0) + 1 : Math.max(1, meta.revision | 0) };
      const rec = {
        id: qid, folderId: folderOk ? folderId : null, meta: m, pages, markdown: buildMarkdown(m.title, pages), snippet: '',
        coverStamp: remote.has('cover.png') ? (coverChanged || !n?.coverStamp ? Date.now().toString(36) : n.coverStamp) : null,
        trash: inTrash ? { deleted: trashInfo?.deleted || now(), device: trashInfo?.device || DEVICE_DRIVE,
          originalTitle: trashInfo?.originalTitle || m.title, originalFolders: trashInfo?.originalFolders || [] } : null,
        chg: (n?.chg || 0) + 1, dchg: (n?.dchg || 0) + 1,
      };
      rec.snippet = snippetOf(rec.markdown);
      await s.notes.put(rec);
      const type = !n ? (rec.trash ? 'note.trashed' : 'note.created') : rec.trash && !n.trash ? 'note.trashed' : !rec.trash && n.trash ? 'note.restored' : 'note.updated';
      await appendFeed(s, { type, kind: 'note', id: qid, parentId: rec.folderId, revision: m.revision }, DEVICE_DRIVE);
      // What is on Drive now matches this device: remember the stamps, so nothing goes back up.
      const local = noteFiles(rec, await s.ink.byNote(qid), await s.files.byNote(qid));
      const filesState = {};
      for (const [path, lf] of local) {
        const rf = remote.get(path);
        if (rf) filesState[path] = { id: rf.id, s: lf.stamp, md5: rf.md5Checksum || null };
      }
      await s.kv.put({ folderId: r.id, sub, files: filesState, v, chg: rec.chg, dchg: rec.dchg }, NK(qid));
      return rec;
    });
    files.forgetNote(qid);
    disk.changed({ fromDrive: true, id: result.id });
  }

  // ---------------------------------------------------------------- notes: push

  async #pushNotes(root) {
    const ids = await disk.read(['notes', 'kv'], async (s) => {
      const out = [];
      for (const n of await s.notes.all()) {
        const st = await s.kv.get(NK(n.id));
        if (!st || st.chg !== n.chg || st.dchg !== n.dchg || (!st.folderId && !st.localOnly)) out.push(n.id);
      }
      return out;
    });
    const openId = this.#store?.openNoteId;
    // The open note goes last: it is the one most likely to change again in a moment.
    ids.sort((a, b) => (a === openId) - (b === openId));
    if (ids.length > 3) { this.progress = { done: 0, total: ids.length, what: 'up' }; this.#emit(); }
    let done = 0;
    for (const id of ids) {
      await this.#pushNote(id, root);
      done++;
      if (this.progress) { this.progress = { ...this.progress, done }; this.#emit(); }
    }
  }

  async #pushNote(id, root) {
    const snap = await disk.read(NOTE_STORES, async (s) => {
      const n = await s.notes.get(id);
      if (!n) return null;
      const fst = n.folderId ? await s.kv.get(FK(n.folderId)) : null;
      return { n, inkRows: await s.ink.byNote(id), fileRows: await s.files.byNote(id), st: await s.kv.get(NK(id)), folderDrive: fst?.driveId || null };
    });
    if (!snap) return;
    const { n, inkRows, fileRows } = snap;
    let st = snap.st ? structuredClone(snap.st) : null;
    const parent = n.trash ? root.trashId : n.folderId ? snap.folderDrive : root.rootId;
    if (!parent) return;   // its folder is not on Drive yet
    const name = segment(n.meta.title, UNTITLED);
    let cur = null;
    if (st?.folderId) {
      try { cur = await drive.get(st.folderId, 'id,parents,appProperties,trashed'); } catch (e) { if (e.kind !== 'notfound') throw e; }
      if (!cur || cur.trashed) { st = null; cur = null; }   // deleted on Drive: uploaded again as it is here
      else if (Number(cur.appProperties?.v || 0) !== st.v) return;   // changed on Drive: the pull handles it next round
    }
    if (!st?.folderId) {
      const created = await drive.createFolder(name, parent, { qk: 'note', qid: id, v: '0' });
      st = { folderId: created.id, sub: {}, files: {}, v: 0 };
      cur = { id: created.id, parents: [parent] };
    }
    const local = noteFiles(n, inkRows, fileRows);
    const subId = async (dir) => {
      if (!st.sub[dir]) st.sub[dir] = (await drive.createFolder(dir, st.folderId, {})).id;
      return st.sub[dir];
    };
    for (const [path, lf] of local) {
      const known = st.files[path];
      if (known && known.s === lf.stamp) continue;
      const slash = path.indexOf('/');
      const dir = slash > 0 ? path.slice(0, slash) : null;
      const fileName = slash > 0 ? path.slice(slash + 1) : path;
      const blob = lf.blob();
      let res;
      try {
        res = await drive.upload({ id: known?.id || null, name: fileName, parentId: dir ? await subId(dir) : st.folderId, blob });
      } catch (e) {
        if (e.kind !== 'notfound' || !known) throw e;
        res = await drive.upload({ name: fileName, parentId: dir ? await subId(dir) : st.folderId, blob });
      }
      st.files[path] = { id: res.id, s: lf.stamp, md5: res.md5Checksum || null };
    }
    for (const [path, known] of Object.entries(st.files)) {
      if (local.has(path)) continue;
      try { await drive.trash(known.id); } catch (e) { if (e.kind !== 'notfound') throw e; }
      delete st.files[path];
    }
    // Commit point: name, place and the new version, once every file is up.
    const v = (st.v || 0) + 1;
    const parents = cur?.parents || [];
    const move = !parents.includes(parent);
    await drive.update(st.folderId, { name, appProperties: { qk: 'note', qid: id, v: String(v) } },
      move ? { addParents: parent, removeParents: parents.join(',') } : {});
    st.v = v;
    st.chg = n.chg;
    st.dchg = n.dchg;
    await disk.write(['kv'], (s) => s.kv.put(st, NK(id)));
  }

  // ---------------------------------------------------------------- slides

  async #convertPptx(blob, name) {
    if (!drive.connected) throw new ServerError(503, 'no_converter', 'Per trasformare le slide in pagine serve Google Drive: collegalo in Impostazioni, oppure salva la presentazione come PDF e inserisci il PDF.');
    if (!drive.token) throw new ServerError(401, 'drive_auth', 'Accesso a Google Drive scaduto: ricollegati (indicatore in basso nella Libreria) e riprova.');
    try {
      const root = await this.#ensureRoot();
      return await drive.pptxToPdf(blob, name, root.rootId);
    } catch (e) {
      throw new ServerError(e.status === 401 ? 401 : 502, 'convert_failed', e.message || 'Conversione delle slide non riuscita.');
    }
  }
}

export const driveSync = new DriveSync();
