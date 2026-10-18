// Archive of all notes (.zip) in the readable layout of the home server's data folder:
//
//   <Cartella>/.folder.json                 { version, id, name, color, created }
//   <Cartella>/<Titolo>/meta.json pages.json note.md cover.png pdftext.json
//   <Cartella>/<Titolo>/ink/<pageId>.json previews/<pageId>.svg attachments/<file>
//   _trash/<note id>/… + trash.json         notes in the trash
//
// Export: a backup, or a way to move notes to another device without Drive.
// Import: adds the notes of an archive (also a zip of D:\Quaderno\data from the server
// version); notes already on this device (same id) are left as they are.
import * as disk from './disk.js';
import { appendFeed } from './server.js';
import { segment, unique, UNTITLED, now, isUuid } from './names.js';
import { buildMarkdown, snippetOf, validateDocument } from './notefiles.js';

const STORES = ['folders', 'notes', 'ink', 'files', 'feed', 'kv'];

async function zipLib() {
  await import('../../vendor/jszip/jszip.min.js');
  return window.JSZip;
}

/** Builds the archive. onProgress(n) per note. Resolves to { blob, notes }. */
export async function exportArchive(onProgress) {
  const JSZip = await zipLib();
  const zip = new JSZip();
  const { folders, notes } = await disk.read(['folders', 'notes'], async (s) => ({ folders: await s.folders.all(), notes: await s.notes.all() }));
  // Folder paths, names unique among siblings (as on disk).
  const pathOf = new Map();
  const taken = new Map();   // parent path -> names used
  const take = (parentPath, name) => {
    const used = taken.get(parentPath) || new Set();
    const n = unique(name, used);
    used.add(n);
    taken.set(parentPath, used);
    return n;
  };
  const resolve = (f, guard = 0) => {
    if (pathOf.has(f.id)) return pathOf.get(f.id);
    const parent = f.parentId && guard < 100 ? folders.find((x) => x.id === f.parentId) : null;
    const base = parent ? resolve(parent, guard + 1) + '/' : '';
    const p = base + take(base, segment(f.name, 'Cartella'));
    pathOf.set(f.id, p);
    zip.file(`${p}/.folder.json`, JSON.stringify({ version: 1, id: f.id, name: f.name, color: f.color ?? null, created: f.created }, null, 2));
    return p;
  };
  folders.forEach((f) => resolve(f));
  let count = 0;
  for (const n of notes) {
    const dir = n.trash ? `_trash/${n.id}` : (() => {
      const base = n.folderId && pathOf.has(n.folderId) ? pathOf.get(n.folderId) + '/' : '';
      return base + take(base, segment(n.meta.title, UNTITLED));
    })();
    const { ink, rows } = await disk.read(['ink', 'files'], async (s) => ({ ink: await s.ink.byNote(n.id), rows: await s.files.byNote(n.id) }));
    zip.file(`${dir}/meta.json`, JSON.stringify(n.meta, null, 2));
    zip.file(`${dir}/pages.json`, JSON.stringify(n.pages, null, 1));
    zip.file(`${dir}/note.md`, n.markdown || buildMarkdown(n.meta.title, n.pages));
    if (n.trash) zip.file(`${dir}/trash.json`, JSON.stringify({ version: 1, id: n.id, ...n.trash }, null, 2));
    for (const r of ink) {
      if (r.strokes?.length) zip.file(`${dir}/ink/${r.pageId}.json`, JSON.stringify({ version: 1, pageId: r.pageId, revision: r.revision, strokes: r.strokes }));
    }
    for (const f of rows) {
      // PDFs and images are already compressed: stored as they are (much faster).
      zip.file(`${dir}/${f.path}`, f.blob, { compression: /\.(json|svg|md|txt)$/i.test(f.path) ? 'DEFLATE' : 'STORE' });
    }
    onProgress?.(++count);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { blob, notes: count };
}

/** True if the zip holds Quadernone notes (some <dir>/meta.json with pages.json next to it). */
export async function isArchive(file) {
  try {
    const zip = await (await zipLib()).loadAsync(file);
    return Object.keys(zip.files).some((p) => /(^|\/)meta\.json$/.test(p) && zip.files[p.replace(/meta\.json$/, 'pages.json')]);
  } catch { return false; }
}

/**
 * Adds the notes of an archive. targetFolderId: where the archive's top level goes (null = root).
 * Resolves to { imported, skipped, failed: [{ path, reason }] }.
 */
export async function importArchive(file, { targetFolderId = null, onProgress, device = 'Importazione' } = {}) {
  const JSZip = await zipLib();
  const zip = await JSZip.loadAsync(file);
  const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  const noteDirs = paths.filter((p) => /(^|\/)meta\.json$/.test(p)).map((p) => p.slice(0, -'meta.json'.length).replace(/\/$/, ''))
    .filter((d) => zip.files[(d ? d + '/' : '') + 'pages.json'] && !/(^|\/)(_app|backup)(\/|$)/.test(d));
  const folderInfo = new Map();   // dir path -> .folder.json
  for (const p of paths) {
    if (!/(^|\/)\.folder\.json$/.test(p)) continue;
    try { folderInfo.set(p.slice(0, -'/.folder.json'.length), JSON.parse(await zip.files[p].async('string'))); } catch { /* broken: treated as a plain folder */ }
  }
  const out = { imported: 0, skipped: 0, failed: [] };
  const folderIds = new Map();   // dir path -> local folder id
  let done = 0;
  for (const dir of noteDirs) {
    try {
      const read = async (name) => zip.files[`${dir}/${name}`] ? zip.files[`${dir}/${name}`].async('string') : null;
      const meta = JSON.parse(await read('meta.json'));
      // Validated like a save; inkRevision is kept as stored (validateDocument takes it from "current").
      const rawPages = JSON.parse(await read('pages.json'));
      const pages = validateDocument(rawPages, rawPages);
      const trashJson = await read('trash.json');
      const trash = trashJson ? JSON.parse(trashJson) : null;
      const inTrash = /(^|\/)_trash\//.test(dir + '/') || !!trash;
      const segs = dir.split('/');
      segs.pop();
      // Leading folders without .folder.json are wrappers (e.g. "data/" of the server zip).
      let start = 0;
      while (start < segs.length && !folderInfo.has(segs.slice(0, start + 1).join('/')) && !inTrash) start++;
      const chain = inTrash ? [] : segs.slice(start).map((_, i) => segs.slice(0, start + i + 1).join('/'));
      const id = isUuid(meta.id) ? meta.id : crypto.randomUUID();
      const inks = [];
      for (const p of pages.pages) {
        const raw = await read(`ink/${p.id}.json`);
        if (raw) { try { inks.push({ pageId: p.id, revision: p.inkRevision | 0, strokes: JSON.parse(raw).strokes || [] }); } catch { /* broken page ink */ } }
      }
      const blobs = [];
      for (const p of paths) {
        if (!p.startsWith(dir + '/')) continue;
        const rel = p.slice(dir.length + 1);
        if (/^(attachments|previews)\/[^/]+$/.test(rel) || rel === 'cover.png' || rel === 'pdftext.json') {
          blobs.push({ path: rel, blob: await zip.files[p].async('blob') });
        }
      }
      const res = await disk.write(STORES, async (s) => {
        if (await s.notes.get(id)) return 'skip';
        // Folders: same id if known, else same name under the same parent, else created.
        let parentId = inTrash ? null : targetFolderId;
        for (const fdir of chain) {
          if (folderIds.has(fdir)) { parentId = folderIds.get(fdir); continue; }
          const info = folderInfo.get(fdir) || {};
          const name = info.name || fdir.split('/').pop();
          const all = await s.folders.all();
          let f = (isUuid(info.id) && all.find((x) => x.id === info.id)) || all.find((x) => x.parentId === parentId && x.name.toLowerCase() === name.toLowerCase());
          if (!f) {
            f = { id: isUuid(info.id) && !all.some((x) => x.id === info.id) ? info.id : crypto.randomUUID(), parentId,
              name: unique(segment(name, 'Cartella'), all.filter((x) => x.parentId === parentId).map((x) => x.name)),
              color: /^#[0-9A-F]{6}$/i.test(info.color || '') ? info.color.toUpperCase() : null, created: info.created || now(), chg: 1 };
            await s.folders.put(f);
            await appendFeed(s, { type: 'folder.created', kind: 'folder', id: f.id, parentId }, device);
          }
          folderIds.set(fdir, f.id);
          parentId = f.id;
        }
        const m = { version: 1, favorite: false, cover: { mode: 'auto', color: null, icon: null, image: null }, conflictOf: null, ...meta, id,
          title: meta.title || dir.split('/').pop() || UNTITLED, revision: Math.max(1, meta.revision | 0) };
        const md = buildMarkdown(m.title, pages);
        const rec = { id, folderId: inTrash ? (trash?.originalFolders?.slice(-1)[0]?.id ?? null) : parentId, meta: m, pages, markdown: md, snippet: snippetOf(md),
          coverStamp: blobs.some((b) => b.path === 'cover.png') ? Date.now().toString(36) : null,
          trash: inTrash ? { deleted: trash?.deleted || now(), device: trash?.device || device, originalTitle: m.title,
            originalFolders: Array.isArray(trash?.originalFolders) ? trash.originalFolders : [] } : null, chg: 1, dchg: 1 };
        if (rec.folderId && !(await s.folders.get(rec.folderId))) rec.folderId = null;
        await s.notes.put(rec);
        for (const r of inks) await s.ink.put({ key: disk.inkKey(id, r.pageId), noteId: id, pageId: r.pageId, revision: r.revision, strokes: r.strokes });
        for (const b of blobs) await s.files.put({ key: disk.fileKey(id, b.path), noteId: id, path: b.path, blob: b.blob, mtime: Date.now() });
        await appendFeed(s, { type: inTrash ? 'note.trashed' : 'note.created', kind: 'note', id, parentId: rec.folderId, revision: m.revision }, device);
        return 'ok';
      });
      if (res === 'skip') out.skipped++; else out.imported++;
    } catch (e) {
      out.failed.push({ path: dir, reason: e?.message || String(e) });
    }
    onProgress?.(++done, noteDirs.length);
  }
  disk.changed({ import: true });
  return out;
}
