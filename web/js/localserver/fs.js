// File access of the local server. All paths are relative to the data folder (the folder
// the user chose, e.g. Documenti/Quadernone), use "/" and never start with "/".
//
// The storage itself is an adapter with this async interface (see adapters/):
//   stat(p)          -> { dir: bool, size: number, mtime: number(ms) } | null
//   list(p)          -> [{ name, dir, size, mtime }]   ([] if p does not exist)
//   read(p)          -> Uint8Array | null
//   write(p, bytes)  atomic replace (never leaves a partial file); creates parent folders
//   append(p, bytes) appends, creating the file if needed
//   mkdir(p)         recursive, no error if it exists
//   move(from, to)   rename a file or folder; for folders `to` must not exist
//   remove(p)        file or whole folder; no error if missing
// Optional, faster when the adapter has it: copyTree(src, dst), treeSize(p).
import { ApiError, toBytes, toText, prettyJson } from './util.js';

export class Fs {
  constructor(adapter) {
    this.a = adapter;
  }

  static join(...parts) {
    const segs = [];
    for (const p of parts) {
      for (const s of String(p ?? '').split('/')) {
        if (s === '' || s === '.') continue;
        if (s === '..') throw new ApiError(400, 'bad_path', 'Percorso non valido.');
        segs.push(s);
      }
    }
    return segs.join('/');
  }

  static dirname(p) {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }

  static basename(p) {
    return p.slice(p.lastIndexOf('/') + 1);
  }

  stat(p) { return this.a.stat(p); }

  async isFile(p) { const s = await this.a.stat(p); return !!s && !s.dir; }

  async isDir(p) { const s = await this.a.stat(p); return !!s && s.dir; }

  async exists(p) { return !!(await this.a.stat(p)); }

  /** Entries of a folder: [{ name, dir, size, mtime }]. */
  entries(p) { return this.a.list(p); }

  /** Names of the entries of a folder. */
  async list(p) { return (await this.a.list(p)).map((e) => e.name); }

  read(p) { return this.a.read(p); }

  async readText(p) {
    const b = await this.a.read(p);
    return b === null ? null : toText(b);
  }

  /** Decoded JSON (object or list), or null when missing / unreadable. Strips a UTF-8 BOM. */
  async readJson(p) {
    let raw = await this.readText(p);
    if (raw === null || raw === '') return null;
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    try {
      const v = JSON.parse(raw);
      return v !== null && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  }

  async writeJson(p, data) {
    await this.writeAtomic(p, prettyJson(data));
  }

  async writeAtomic(p, content) {
    try {
      await this.a.write(p, typeof content === 'string' ? toBytes(content) : content);
    } catch (e) {
      throw wrap(e, 'write_failed', 'Impossibile scrivere il file sul dispositivo. Riprova tra poco.');
    }
  }

  async append(p, text) {
    await this.a.append(p, toBytes(text));
  }

  async mkdir(p) {
    try {
      await this.a.mkdir(p);
    } catch (e) {
      throw wrap(e, 'mkdir_failed', 'Impossibile creare una cartella sul dispositivo.');
    }
  }

  async rename(from, to) {
    try {
      await this.a.move(from, to);
    } catch (e) {
      throw wrap(e, 'file_busy', 'Impossibile spostare o rinominare un file. Riprova tra qualche secondo.');
    }
  }

  async removeTree(p) {
    try {
      await this.a.remove(p);
    } catch (e) {
      throw wrap(e, 'delete_failed', 'Impossibile eliminare un file. Riprova tra qualche secondo.');
    }
  }

  async unlink(p) {
    try { await this.a.remove(p); } catch { /* like @unlink */ }
  }

  /** Copies a folder tree (skipping our own temp files). dst must not exist. */
  async copyTree(src, dst) {
    if (this.a.copyTree) {
      try { await this.a.copyTree(src, dst); return; } catch (e) {
        throw wrap(e, 'copy_failed', 'Impossibile copiare un file della nota. Riprova tra poco.');
      }
    }
    await this.mkdir(dst);
    for (const e of await this.a.list(src)) {
      if (e.name.startsWith('.~')) continue;
      const s = `${src}/${e.name}`;
      const d = `${dst}/${e.name}`;
      if (e.dir) await this.copyTree(s, d);
      else {
        const b = await this.a.read(s);
        if (b === null) throw new ApiError(503, 'copy_failed', 'Impossibile copiare un file della nota. Riprova tra poco.');
        await this.writeAtomic(d, b);
      }
    }
  }

  async treeSize(p) {
    if (this.a.treeSize) return this.a.treeSize(p);
    let size = 0;
    for (const e of await this.a.list(p)) size += e.dir ? await this.treeSize(`${p}/${e.name}`) : e.size;
    return size;
  }
}

function wrap(e, code, message) {
  if (e instanceof ApiError) return e;
  const err = new ApiError(503, code, message);
  err.cause = e;
  return err;
}
