// Note operations: create, read, save (with revision check), move (port of Notes.php).
import { ApiError, assertId, uuid, now, hex, isoLocal, isArr, isInt, stampMinute, cpLen, shortHash as shortHashOf } from './util.js';
import * as Names from './names.js';
import * as Pages from './pages.js';
import * as Ink from './ink.js';
import * as markdown from './markdown.js';
import { validColor } from './folders.js';
import { Fs } from './fs.js';

export const UNTITLED = 'Senza titolo';

const childRel = (parentRel, seg) => (parentRel === '' ? seg : `${parentRel}/${seg}`);
const parentOf = (rel) => Fs.dirname(rel);

/** Summary used by /api/tree. */
export function summary(id, e) {
  const m = e.meta || {};
  return {
    id,
    folderId: e.parentId,
    title: String(m.title ?? Fs.basename(e.path)),
    created: m.created ?? null,
    modified: m.modified ?? null,
    favorite: !!(m.favorite ?? false),
    cover: m.cover ?? { mode: 'auto', color: null, icon: null, image: null },
    hasCoverImage: e.coverStamp !== null,
    // Changes whenever cover.png changes: clients use it to refresh their cached copy.
    coverVersion: e.coverStamp === null ? null : shortHashOf(e.coverStamp),
    revision: Number(m.revision ?? 0) | 0,
    lastDevice: m.lastDevice ?? null,
    conflictOf: m.conflictOf ?? null,
    snippet: e.snippet,
  };
}

function cleanTitle(t) {
  t = typeof t === 'string' ? Names.cleanTitle(t) : '';
  return t === '' ? UNTITLED : t;
}

function cover(c) {
  if (!isArr(c) || !['auto', 'image', 'preset'].includes(c.mode)) throw new ApiError(400, 'bad_cover', 'Copertina non valida.');
  const color = validColor(c.color ?? null);
  const icon = c.icon ?? null;
  if (icon !== null && (typeof icon !== 'string' || !/^[a-z0-9-]{1,24}$/.test(icon))) {
    throw new ApiError(400, 'bad_cover', 'Icona della copertina non valida.');
  }
  const image = c.image ?? null;
  if (image !== null && (typeof image !== 'string' || /[/\\]|^\./.test(image) || cpLen(image) > 120)) {
    throw new ApiError(400, 'bad_cover', 'Immagine della copertina non valida.');
  }
  if (c.mode === 'image' && image === null) throw new ApiError(400, 'bad_cover', "Manca l'immagine della copertina.");
  return { mode: c.mode, color, icon, image };
}

/** Writes pages.json, note.md and meta.json of a note folder (meta.json last: it is the commit point). */
async function writeFiles(fs, rel, meta, pages) {
  if (pages !== null) await fs.writeJson(`${rel}/pages.json`, pages);
  else pages = (await fs.readJson(`${rel}/pages.json`)) ?? { pages: [] };
  await fs.writeAtomic(`${rel}/note.md`, markdown.build(meta.title, pages));
  await fs.writeJson(`${rel}/meta.json`, meta);
}

/** ISO date from an importer, or null. */
function isoDate(v) {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  if (Number.isNaN(t) || t < 0 || t > Date.now() + 86400000) throw new ApiError(400, 'bad_date', 'Data non valida.');
  return isoLocal(new Date(t));
}

/**
 * Creates a note. id may be supplied by a client that created the note offline;
 * repeating the same request returns the existing note.
 */
export async function create(ctx, folderId, title, pageDefaults, device, id = null, created = null, modified = null) {
  const { fs, index } = ctx;
  title = cleanTitle(title);
  const pages = Pages.newDocument(pageDefaults ?? null);
  if (id !== null) {
    assertId(id);
    try {
      return [summary(id, await index.noteEntry(id)), []];
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  const parentRel = await index.folderPath(folderId);
  folderId = parentRel === '' ? null : folderId;
  const seg = await Names.unique(fs, parentRel, Names.segment(title, UNTITLED), null, parentRel === '');
  const rel = childRel(parentRel, seg);

  const t = now();
  // Imports keep the dates of the original files.
  const c = isoDate(created) ?? t;
  const m = isoDate(modified) ?? c;
  const meta = {
    version: 1, id: id ?? uuid(), title, created: c, modified: m, favorite: false,
    cover: { mode: 'auto', color: null, icon: null, image: null },
    revision: 1, lastDevice: device, conflictOf: null,
  };
  const tmp = Fs.join(parentRel, `.~new-${hex(4)}`);
  await fs.mkdir(`${tmp}/ink`);
  try {
    await writeFiles(fs, tmp, meta, pages);
    await fs.rename(tmp, rel);
  } catch (e) {
    try { await fs.removeTree(tmp); } catch { /* ignore */ }
    throw e;
  }
  await index.putNote(meta.id, rel, folderId);
  await index.save();
  ctx.feed.append({ type: 'note.created', kind: 'note', id: meta.id, parentId: folderId, revision: 1 }, device);
  return [summary(meta.id, await index.noteEntry(meta.id)), []];
}

/** GET /api/notes/{id}; with withInk also every page's ink (one request to open a note). */
export async function get(ctx, id, withInk = false) {
  const { fs, index } = ctx;
  const rel = await index.notePath(id);
  const md = await fs.readText(`${rel}/note.md`);
  const pages = await fs.readJson(`${rel}/pages.json`);
  const out = {
    meta: await fs.readJson(`${rel}/meta.json`),
    pages,
    markdown: md ?? '',
    folderId: (await index.noteEntry(id)).parentId,
    path: rel,
    sizeBytes: await fs.treeSize(rel),
  };
  if (withInk) out.ink = await Ink.all(fs, rel, pages ?? {});
  return out;
}

/**
 * PUT /api/notes/{id}: body { baseRevision, meta?: {title, favorite, cover}, pages? }.
 * A stale baseRevision never overwrites: it creates a conflict copy and answers 409.
 */
export async function save(ctx, id, input, device) {
  const { fs, index } = ctx;
  assertId(id);
  if (!isInt(input.baseRevision)) throw new ApiError(400, 'bad_revision', 'Manca baseRevision.');
  if ((input.meta === undefined || input.meta === null) && (input.pages === undefined || input.pages === null)) {
    throw new ApiError(400, 'nothing_to_save', 'Niente da salvare.');
  }
  if (input.meta !== undefined && input.meta !== null && !isArr(input.meta)) throw new ApiError(400, 'bad_meta', 'meta non valido.');
  let rel = await index.notePath(id);
  const meta = await fs.readJson(`${rel}/meta.json`);
  const currentPages = (await fs.readJson(`${rel}/pages.json`)) ?? { pages: [] };
  if (meta === null) throw new ApiError(503, 'unreadable', 'Impossibile leggere la nota.');

  // Validate everything first: an invalid save is a 400, never a conflict copy.
  const newMeta = structuredClone(meta);
  const metaIn = input.meta ?? {};
  if (Object.hasOwn(metaIn, 'title')) newMeta.title = cleanTitle(metaIn.title);
  if (Object.hasOwn(metaIn, 'favorite')) {
    if (typeof metaIn.favorite !== 'boolean') throw new ApiError(400, 'bad_meta', 'favorite deve essere vero o falso.');
    newMeta.favorite = metaIn.favorite;
  }
  if (Object.hasOwn(metaIn, 'cover')) newMeta.cover = cover(metaIn.cover);
  const newPages = input.pages !== undefined && input.pages !== null ? Pages.validateDocument(input.pages, currentPages) : null;

  const current = Number(meta.revision ?? 0) | 0;
  if (input.baseRevision !== current) {
    const copy = await conflictCopy(ctx, id, rel, newMeta, newPages ?? currentPages, input.baseRevision, device);
    throw new ApiError(409, 'conflict',
      'La nota è stata modificata da un altro dispositivo. Le tue modifiche sono salve in una copia di conflitto.',
      { copyId: copy.id, revision: current, copyRevision: copy.revision });
  }

  let type = 'note.updated';
  const parentId = (await index.noteEntry(id)).parentId;
  if (newMeta.title !== meta.title) {
    // Rename the folder first: if it fails, nothing was written and the save can be retried.
    rel = await renameFolder(fs, rel, newMeta.title);
    await index.putNote(id, rel, parentId);
    type = 'note.renamed';
  }
  newMeta.revision = current + 1;
  // An importer may keep the original date (meta.modified); otherwise "now".
  newMeta.modified = (Object.hasOwn(metaIn, 'modified') ? isoDate(metaIn.modified) : null) ?? now();
  newMeta.lastDevice = device;
  await writeFiles(fs, rel, newMeta, newPages);
  await index.putNote(id, rel, parentId);
  await index.save();
  ctx.feed.append({ type, kind: 'note', id, parentId, revision: newMeta.revision }, device);
  return { revision: newMeta.revision, note: summary(id, await index.noteEntry(id)), warnings: [] };
}

/** Renames a note folder to match its title. Returns the new relative path. */
async function renameFolder(fs, rel, title) {
  const parentRel = parentOf(rel);
  const current = Fs.basename(rel);
  const seg = await Names.unique(fs, parentRel, Names.segment(title, UNTITLED), current, parentRel === '');
  if (seg === current) return rel;
  const newRel = childRel(parentRel, seg);
  if (Names.key(seg) === Names.key(current)) {
    const detour = Fs.join(parentRel, `.~ren-${hex(4)}`);
    await fs.rename(rel, detour);
    await fs.rename(detour, newRel);
  } else {
    await fs.rename(rel, newRel);
  }
  return newRel;
}

/**
 * Full copy of the current note with the rejected save applied on top, as a sibling note:
 * rejected meta/pages, or rejected ink (rejectedInk: { pageId: strokes }).
 */
export async function conflictCopy(ctx, origId, rel, rejectedMeta, rejectedPages, baseRevision, device, rejectedInk = {}) {
  const { fs, index } = ctx;
  const parentRel = parentOf(rel);
  const parentId = (await index.noteEntry(origId)).parentId;
  const t = now();
  const title = Names.cleanTitle(`${rejectedMeta.title} (conflitto ${device} ${stampMinute()})`);
  const seg = await Names.unique(fs, parentRel, Names.segment(title, UNTITLED), null, parentRel === '');
  const copyRel = childRel(parentRel, seg);

  const meta = {
    ...structuredClone(rejectedMeta),
    id: uuid(), title, modified: t, revision: 1, lastDevice: device,
    conflictOf: { id: origId, baseRevision, device, time: t },
  };
  const tmp = Fs.join(parentRel, `.~new-${hex(4)}`);
  try {
    await fs.copyTree(rel, tmp);
    await writeFiles(fs, tmp, meta, rejectedPages);
    for (const [pageId, strokes] of Object.entries(rejectedInk)) {
      const pages = (await fs.readJson(`${tmp}/pages.json`)) ?? { pages: [] };
      let rev = 0;
      for (const p of pages.pages) if (p.id === pageId) rev = Number(p.inkRevision ?? 0) | 0;
      await Ink.write(fs, tmp, pages, pageId, strokes, rev + 1);
    }
    await fs.rename(tmp, copyRel);
  } catch (e) {
    try { await fs.removeTree(tmp); } catch { /* ignore */ }
    throw e;
  }
  await index.putNote(meta.id, copyRel, parentId);
  await index.save();
  ctx.feed.append({ type: 'note.conflict', kind: 'note', id: meta.id, parentId, revision: 1, extra: { originalId: origId } }, device);
  ctx.log('INFO', 'conflict copy created', { original: origId, copy: meta.id, device });
  return { id: meta.id, revision: 1 };
}

export async function move(ctx, id, folderId, device) {
  const { fs, index } = ctx;
  assertId(id);
  const target = folderId === null || folderId === undefined || folderId === '' || folderId === 'root' ? null : String(folderId);
  if (target !== null) assertId(target);
  const rel = await index.notePath(id);
  const entry = await index.noteEntry(id);
  if (entry.parentId === target) return [summary(id, entry), []];
  const parentRel = await index.folderPath(target);
  const seg = await Names.unique(fs, parentRel, Fs.basename(rel), null, parentRel === '');
  const newRel = childRel(parentRel, seg);
  await fs.rename(rel, newRel);
  await index.putNote(id, newRel, target);
  await index.save();
  ctx.feed.append({ type: 'note.moved', kind: 'note', id, parentId: target, revision: Number(entry.meta?.revision ?? 0) | 0 }, device);
  return [summary(id, await index.noteEntry(id)), []];
}
