// The disk is the source of truth; _app/index.json is only a cache of it (port of Index.php).
//
// Cache layout:
//   folders: { id: { path, parentId, name, color, created } }
//   notes:   { id: { path, parentId, meta, metaStamp, snippet, mdStamp, coverStamp } }
// "path" is relative to the data folder, with "/" separators. The root folder has id null
// and path "".
//
// scan() walks the data folder, re-reads only the meta.json / note.md files whose size or
// time changed, repairs what it can (missing .folder.json, duplicate ids from copied
// folders, folders renamed with a file manager) and reports whether the structure changed
// behind the app's back.
import { ApiError, assertId, uuid, now, LOOSE_ID_RE } from './util.js';
import { RESERVED_ROOT } from './names.js';
import * as markdown from './markdown.js';

const FILE = '_app/index.json';

const empty = () => ({ version: 1, folders: {}, notes: {} });

export class Index {
  constructor(ctx) {
    this.ctx = ctx;
    this.fs = ctx.fs;
    this.cache = null;
  }

  async ensureDirs() {
    await this.fs.mkdir('_app');
    await this.fs.mkdir('_trash');
  }

  async load() {
    if (this.cache === null) {
      const c = await this.fs.readJson(FILE);
      this.cache = c && c.version === 1 && c.folders && c.notes && !Array.isArray(c.folders) && !Array.isArray(c.notes)
        ? c : empty();
    }
    return this.cache;
  }

  async save() {
    if (this.cache !== null) await this.fs.writeJson(FILE, this.cache);
  }

  // ---------------------------------------------------------------- lookups

  /** Relative path of a folder; "" for the root (id null / "root" / ""). */
  async folderPath(id) {
    if (id === null || id === undefined || id === '' || id === 'root') return '';
    const c = await this.load();
    const f = c.folders[id];
    if (f && (await this.#stillThere(f.path, '.folder.json', id))) return f.path;
    await this.scan();
    const g = this.cache.folders[id];
    if (!g) throw new ApiError(404, 'folder_not_found', 'Cartella non trovata.');
    return g.path;
  }

  async folder(id) {
    await this.folderPath(id);
    return this.cache.folders[id];
  }

  async notePath(id) {
    assertId(id);
    const c = await this.load();
    const n = c.notes[id];
    if (n && (await this.#stillThere(n.path, 'meta.json', id))) return n.path;
    await this.scan();
    const m = this.cache.notes[id];
    if (!m) throw new ApiError(404, 'note_not_found', 'Nota non trovata.');
    return m.path;
  }

  async noteEntry(id) {
    await this.notePath(id);
    return this.cache.notes[id];
  }

  async #stillThere(rel, file, id) {
    if (!this.ctx.verifyLookups) return true;
    const m = await this.fs.readJson(`${rel}/${file}`);
    return m !== null && m.id === id;
  }

  /** Ids of the folder and all its descendants. */
  async subtreeFolderIds(id) {
    const c = await this.load();
    const out = [id];
    for (let i = 0; i < out.length; i++) {
      for (const [fid, f] of Object.entries(c.folders)) if (f.parentId === out[i]) out.push(fid);
    }
    return out;
  }

  /** Chain of folders from the root down to (and including) id, for trash.json. */
  async folderChain(id) {
    const c = await this.load();
    const chain = [];
    let guard = 0;
    while (id !== null && id !== undefined && c.folders[id] && guard++ < 200) {
      const f = c.folders[id];
      chain.unshift({ id, name: f.name, color: f.color });
      id = f.parentId;
    }
    return chain;
  }

  // ------------------------------------------------------- cache updates

  async putFolder(id, rel, parentId, info) {
    await this.load();
    this.cache.folders[id] = {
      path: rel, parentId: parentId ?? null, name: info.name, color: info.color ?? null, created: info.created ?? null,
    };
  }

  /** Re-reads a note's files into the cache. */
  async putNote(id, rel, parentId) {
    await this.load();
    this.cache.notes[id] = await this.#readNote(rel, parentId ?? null, null);
  }

  async removeNote(id) { await this.load(); delete this.cache.notes[id]; }

  async removeFolder(id) { await this.load(); delete this.cache.folders[id]; }

  /** After a folder moved or was renamed: rewrite the paths of everything below it. */
  async rebasePaths(oldRel, newRel) {
    await this.load();
    const prefix = oldRel + '/';
    for (const kind of ['folders', 'notes']) {
      for (const e of Object.values(this.cache[kind])) {
        if (e.path === oldRel) e.path = newRel;
        else if (e.path.startsWith(prefix)) e.path = newRel + '/' + e.path.slice(prefix.length);
      }
    }
  }

  // ------------------------------------------------------------- scanning

  /** Reads a note folder; reuses the cached meta / snippet when the files did not change. */
  async #readNote(rel, parentId, cached, entries = null) {
    entries ||= await this.fs.entries(rel);
    const st = (name) => {
      const e = entries.find((x) => x.name === name && !x.dir);
      return e ? `${e.size}:${e.mtime}` : null;
    };
    const metaStamp = st('meta.json');
    const mdStamp = st('note.md');
    const meta = cached && cached.metaStamp === metaStamp ? cached.meta : ((await this.fs.readJson(`${rel}/meta.json`)) ?? {});
    const snippet = cached && cached.mdStamp === mdStamp ? cached.snippet
      : (mdStamp === null ? '' : markdown.snippet(await this.fs.readText(`${rel}/note.md`)));
    return { path: rel, parentId, meta, metaStamp, snippet, mdStamp, coverStamp: st('cover.png') };
  }

  /** Entries the scanner never treats as user content. */
  static ignoredEntry(name, atRoot) {
    if (name === '' || name[0] === '.' || name[0] === '~' || name === '$RECYCLE.BIN' || name === 'System Volume Information') return true;
    return atRoot && RESERVED_ROOT.includes(name);
  }

  /**
   * Full scan. Rebuilds the cache from disk. Returns true if the structure differed from
   * the cache (something changed outside the app).
   */
  async scan() {
    const old = await this.load();
    const raw = [];   // collected before resolving duplicate ids
    await this.#walk('', raw);

    // Resolve duplicate ids (a note or folder copied with a file manager keeps the same id).
    const byId = new Map();
    raw.forEach((e, i) => { if (!byId.has(e.id)) byId.set(e.id, []); byId.get(e.id).push(i); });
    let repaired = false;
    for (const [id, idx] of byId) {
      if (idx.length < 2) continue;
      const kind = raw[idx[0]].kind;
      const cachedPath = old[kind + 's'][id]?.path ?? null;
      let keep = idx[0];
      for (const i of idx) if (raw[i].path === cachedPath) keep = i;
      for (const i of idx) {
        if (i !== keep) { raw[i].id = await this.#reassignId(raw[i]); repaired = true; }
      }
    }
    // Parent ids may refer to a folder whose id was just reassigned.
    const pathToFolderId = new Map([['', null]]);
    for (const e of raw) if (e.kind === 'folder') pathToFolderId.set(e.path, e.id);
    const found = { folders: {}, notes: {} };
    for (const e of raw) {
      const slash = e.path.lastIndexOf('/');
      const parentRel = slash < 0 ? '' : e.path.slice(0, slash);
      const parentId = pathToFolderId.get(parentRel) ?? null;
      if (e.kind === 'folder') {
        found.folders[e.id] = {
          path: e.path, parentId, name: e.info.name, color: e.info.color ?? null, created: e.info.created ?? null,
        };
      } else {
        const cached = old.notes[e.id];
        found.notes[e.id] = await this.#readNote(e.path, parentId, cached && cached.path === e.path ? cached : null, e.entries);
      }
    }

    const changed = repaired || structureKey(old) !== structureKey(found);
    const notesChanged = JSON.stringify(old.notes) !== JSON.stringify(found.notes);
    this.cache = { version: 1, ...found };
    if (changed || notesChanged || !(await this.fs.isFile(FILE))) await this.save();
    return changed;
  }

  async #walk(rel, raw) {
    for (const ent of await this.fs.entries(rel)) {
      const name = ent.name;
      if (!ent.dir || Index.ignoredEntry(name, rel === '')) continue;
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const children = await this.fs.entries(childRel);
      const has = (n) => children.some((c) => c.name === n && !c.dir);
      if (has('meta.json')) {
        const m = await this.fs.readJson(`${childRel}/meta.json`);
        if (!m || typeof m.id !== 'string' || !LOOSE_ID_RE.test(m.id)) {
          this.ctx.log('ERROR', 'unreadable meta.json, note skipped', { path: childRel });
          continue;
        }
        raw.push({ kind: 'note', id: m.id, path: childRel, entries: children });
        continue;
      }
      if (has('pages.json')) {
        // Looks like a note that lost its meta.json (or is still being written): leave it alone.
        this.ctx.log('ERROR', 'note folder without meta.json skipped', { path: childRel });
        continue;
      }
      let info = await this.fs.readJson(`${childRel}/.folder.json`);
      const valid = info && typeof info.id === 'string' && LOOSE_ID_RE.test(info.id);
      if (!valid) {
        // A folder made with a file manager: give it an identity.
        info = { version: 1, id: uuid(), name, color: null, created: now() };
        await this.fs.writeJson(`${childRel}/.folder.json`, info);
      } else if (info.name !== name) {
        // Renamed outside the app: the name on disk wins.
        info.name = name;
        await this.fs.writeJson(`${childRel}/.folder.json`, info);
      }
      raw.push({ kind: 'folder', id: info.id, path: childRel, info });
      await this.#walk(childRel, raw);
    }
  }

  async #reassignId(e) {
    const id = uuid();
    const file = `${e.path}/${e.kind === 'note' ? 'meta.json' : '.folder.json'}`;
    const data = (await this.fs.readJson(file)) ?? {};
    data.id = id;
    await this.fs.writeJson(file, data);
    if (e.kind === 'note' && e.entries) e.entries = await this.fs.entries(e.path);
    if (e.info) e.info.id = id;
    this.ctx.log('INFO', 'duplicate id reassigned', { path: e.path, new: id });
    return id;
  }
}

function structureKey(c) {
  const k = [];
  for (const [id, f] of Object.entries(c.folders)) k.push(`f|${id}|${f.path}|${f.name}|${f.color ?? ''}`);
  for (const [id, n] of Object.entries(c.notes)) k.push(`n|${id}|${n.path}|${n.metaStamp ?? ''}`);
  k.sort();
  return k.join('\n');
}
