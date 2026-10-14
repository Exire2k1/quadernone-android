// Storage adapter on the browser's private file system (OPFS). Used when the app runs in a
// normal browser (development and tests); on Android the notes go to the folder the user
// chose (adapters/saf.js). Same interface as described in ../fs.js.

const segs = (p) => (p ? p.split('/') : []);

export async function opfsAdapter(rootName = 'quadernone-data') {
  const top = await navigator.storage.getDirectory();
  const root = await top.getDirectoryHandle(rootName, { create: true });

  async function dir(p, create = false) {
    let d = root;
    for (const s of segs(p)) d = await d.getDirectoryHandle(s, { create });
    return d;
  }
  async function parentAndName(p, create = false) {
    const parts = segs(p);
    const name = parts.pop();
    return [await dir(parts.join('/'), create), name];
  }
  async function handle(p) {
    if (!p) return root;
    try {
      const [d, name] = await parentAndName(p);
      try { return await d.getFileHandle(name); } catch { return await d.getDirectoryHandle(name); }
    } catch {
      return null;
    }
  }
  async function infoOf(h) {
    if (h.kind === 'directory') return { dir: true, size: 0, mtime: 0 };
    const f = await h.getFile();
    return { dir: false, size: f.size, mtime: f.lastModified };
  }
  async function copyDir(src, dst) {
    for await (const [name, h] of src.entries()) {
      if (h.kind === 'directory') await copyDir(h, await dst.getDirectoryHandle(name, { create: true }));
      else {
        const w = await (await dst.getFileHandle(name, { create: true })).createWritable();
        await w.write(await h.getFile());
        await w.close();
      }
    }
  }

  return {
    async stat(p) {
      const h = await handle(p);
      return h ? infoOf(h) : null;
    },
    async list(p) {
      let d;
      try { d = await dir(p); } catch { return []; }
      const out = [];
      for await (const [name, h] of d.entries()) out.push({ name, ...(await infoOf(h)) });
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async read(p) {
      const h = await handle(p);
      if (!h || h.kind !== 'file') return null;
      return new Uint8Array(await (await h.getFile()).arrayBuffer());
    },
    async write(p, bytes) {
      // createWritable() writes to a swap file and replaces the target on close(): atomic.
      const [d, name] = await parentAndName(p, true);
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();
      await w.write(bytes);
      await w.close();
    },
    async append(p, bytes) {
      const [d, name] = await parentAndName(p, true);
      const fh = await d.getFileHandle(name, { create: true });
      const size = (await fh.getFile()).size;
      const w = await fh.createWritable({ keepExistingData: true });
      await w.write({ type: 'write', position: size, data: bytes });
      await w.close();
    },
    async mkdir(p) { await dir(p, true); },
    async move(from, to) {
      const h = await handle(from);
      if (!h) throw new Error('not found: ' + from);
      const existing = await handle(to);
      if (existing && existing.kind === 'directory') throw new Error('target exists: ' + to);
      const [toDir, toName] = await parentAndName(to, true);
      if (h.kind === 'file' && typeof h.move === 'function') {
        if (existing) await toDir.removeEntry(toName);
        await h.move(toDir, toName);
        return;
      }
      // Folders (and browsers without move()): copy, then remove the original.
      if (h.kind === 'directory') await copyDir(h, await toDir.getDirectoryHandle(toName, { create: true }));
      else {
        const w = await (await toDir.getFileHandle(toName, { create: true })).createWritable();
        await w.write(await h.getFile());
        await w.close();
      }
      const [fromDir, fromName] = await parentAndName(from);
      await fromDir.removeEntry(fromName, { recursive: true });
    },
    async remove(p) {
      try {
        const [d, name] = await parentAndName(p);
        await d.removeEntry(name, { recursive: true });
      } catch { /* missing: nothing to do */ }
    },
  };
}
