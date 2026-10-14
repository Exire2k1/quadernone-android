// Storage adapter on a real folder, for tests in Node (same interface as web/js/localserver/fs.js).
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export function nodeAdapter(root) {
  const abs = (p) => (p ? path.join(root, ...p.split('/')) : root);
  const statOf = async (p) => {
    try { return await fsp.stat(abs(p)); } catch { return null; }
  };
  return {
    async stat(p) {
      const s = await statOf(p);
      return s ? { dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtime: Math.floor(s.mtimeMs) } : null;
    },
    async list(p) {
      let names;
      try { names = (await fsp.readdir(abs(p))).sort(); } catch { return []; }
      const out = [];
      for (const name of names) {
        const s = await statOf(p ? `${p}/${name}` : name);
        if (s) out.push({ name, dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtime: Math.floor(s.mtimeMs) });
      }
      return out;
    },
    async read(p) {
      try {
        const b = await fsp.readFile(abs(p));
        return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      } catch { return null; }
    },
    async write(p, bytes) {
      const target = abs(p);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const tmp = path.join(path.dirname(target), '.~tmp-' + randomBytes(6).toString('hex'));
      await fsp.writeFile(tmp, bytes, { flag: 'wx' });
      await fsp.rename(tmp, target);
    },
    async append(p, bytes) {
      await fsp.mkdir(path.dirname(abs(p)), { recursive: true });
      await fsp.appendFile(abs(p), bytes);
    },
    async mkdir(p) { await fsp.mkdir(abs(p), { recursive: true }); },
    async move(from, to) {
      const s = await statOf(to);
      if (s && s.isDirectory()) throw new Error('target exists');
      await fsp.mkdir(path.dirname(abs(to)), { recursive: true });
      await fsp.rename(abs(from), abs(to));
    },
    async remove(p) { await fsp.rm(abs(p), { recursive: true, force: true }); },
  };
}
