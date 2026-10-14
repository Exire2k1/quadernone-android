// _trash/<note-id>/ holds a deleted note folder plus trash.json (port of Trash.php).
// Nothing is removed for good except by an explicit delete/empty or by the retention
// purge (done lazily on tree and trash requests).
import { ApiError, assertId, uuid, now, stampCompact, LOOSE_ID_RE } from './util.js';
import * as Names from './names.js';
import * as Notes from './notes.js';
import * as Config from './config.js';
import { Fs } from './fs.js';

const DIR = '_trash';

/** Moves a note to the trash. */
export async function trashNote(ctx, id, device) {
  const { fs, index } = ctx;
  assertId(id);
  const rel = await index.notePath(id);
  const entry = await index.noteEntry(id);
  await fs.mkdir(DIR);
  let name = id;
  if (await fs.exists(`${DIR}/${name}`)) name = `${id}-${stampCompact()}`;
  const dest = `${DIR}/${name}`;
  await fs.rename(rel, dest);
  const info = {
    version: 1, id, originalPath: rel, originalFolders: await index.folderChain(entry.parentId),
    deleted: now(), device,
  };
  try {
    await fs.writeJson(`${dest}/trash.json`, info);
  } catch (e) {
    // Without trash.json the note could not be restored: put it back.
    await fs.rename(dest, rel);
    throw e;
  }
  await index.removeNote(id);
  await index.save();
  ctx.feed.append({ type: 'note.trashed', kind: 'note', id, parentId: entry.parentId, revision: Number(entry.meta?.revision ?? 0) | 0 }, device);
}

export async function list(ctx) {
  const { fs } = ctx;
  const days = (await Config.settings(ctx)).trashRetentionDays;
  const out = [];
  for (const e of await fs.entries(DIR)) {
    const name = e.name;
    if (name[0] === '.' || name[0] === '_' || !e.dir) continue;
    const abs = `${DIR}/${name}`;
    const t = await fs.readJson(`${abs}/trash.json`);
    const m = await fs.readJson(`${abs}/meta.json`);
    if (!t || !m) continue;
    const deleted = Date.parse(String(t.deleted ?? '')) || e.mtime;
    const age = (Date.now() - deleted) / 86400000;
    out.push({
      trashId: name,
      id: t.id ?? m.id ?? name,
      title: m.title ?? name,
      originalPath: t.originalPath ?? '',
      deleted: t.deleted ?? null,
      device: t.device ?? null,
      daysLeft: Math.max(0, Math.ceil(days - age)),
      cover: m.cover ?? null,
      expired: age >= days,
    });
  }
  out.sort((a, b) => String(b.deleted ?? '').localeCompare(String(a.deleted ?? '')));
  return out;
}

/** Deletes items older than the retention period. Returns how many were purged. */
export async function purge(ctx) {
  let n = 0;
  for (const item of await list(ctx)) {
    if (!item.expired) continue;
    try {
      await ctx.fs.removeTree(`${DIR}/${item.trashId}`);
      ctx.feed.append({ type: 'note.purged', kind: 'note', id: item.id }, 'Server');
      n++;
    } catch (e) {
      ctx.log('ERROR', 'trash purge failed', { item: item.trashId, error: e.message });
    }
  }
  return n;
}

async function itemDir(ctx, trashId) {
  if (typeof trashId !== 'string' || !/^[0-9a-f-]{36}(-\d{14})?$/.test(trashId)) {
    throw new ApiError(400, 'bad_id', 'Identificativo non valido.');
  }
  const abs = `${DIR}/${trashId}`;
  if (!(await ctx.fs.isFile(`${abs}/trash.json`))) throw new ApiError(404, 'trash_not_found', 'Nota non trovata nel cestino.');
  return abs;
}

export async function deleteForever(ctx, trashId, device) {
  const abs = await itemDir(ctx, trashId);
  const t = (await ctx.fs.readJson(`${abs}/trash.json`)) ?? {};
  await ctx.fs.removeTree(abs);
  ctx.feed.append({ type: 'note.purged', kind: 'note', id: t.id ?? trashId }, device);
}

export async function emptyAll(ctx, device) {
  let n = 0;
  for (const item of await list(ctx)) {
    await deleteForever(ctx, item.trashId, device);
    n++;
  }
  return n;
}

const childRel = (parentRel, seg) => (parentRel === '' ? seg : `${parentRel}/${seg}`);

/**
 * Restores a note to its original path. Missing folders on that path are recreated with
 * the same names and colours (and the old ids if still free).
 */
export async function restore(ctx, trashId, device) {
  const { fs, index } = ctx;
  const abs = await itemDir(ctx, trashId);
  const t = await fs.readJson(`${abs}/trash.json`);
  const meta = await fs.readJson(`${abs}/meta.json`);
  if (!t || !meta) throw new ApiError(500, 'trash_broken', 'Questa nota nel cestino è danneggiata e non si può ripristinare.');
  await index.scan();
  let cache = await index.load();

  // Walk (and rebuild) the folder chain.
  let parentId = null;
  let parentRel = '';
  for (const f of t.originalFolders || []) {
    let match = null;
    for (const [fid, cf] of Object.entries(cache.folders)) {
      if (cf.parentId === parentId && fid === (f.id ?? null)) { match = fid; break; }
    }
    if (match === null) {
      for (const [fid, cf] of Object.entries(cache.folders)) {
        if (cf.parentId === parentId && Names.key(cf.name) === Names.key(String(f.name ?? ''))) { match = fid; break; }
      }
    }
    if (match === null) {
      match = await recreateFolder(ctx, parentRel, parentId, f, device);
      cache = await index.load();
    }
    parentId = match;
    parentRel = cache.folders[match].path;
  }

  const wanted = Fs.basename(String(t.originalPath ?? '')) || Names.segment(String(meta.title ?? ''), Notes.UNTITLED);
  const seg = await Names.unique(fs, parentRel, Names.segment(wanted, Notes.UNTITLED), null, parentRel === '');
  const rel = childRel(parentRel, seg);

  // Very unlikely: a live note already uses this id (e.g. a manual copy). Give the restored one a new id.
  let id = String(meta.id);
  if (cache.notes[id]) {
    id = uuid();
    meta.id = id;
    await fs.writeJson(`${abs}/meta.json`, meta);
  }
  await fs.rename(abs, rel);
  await fs.unlink(`${rel}/trash.json`);
  await index.putNote(id, rel, parentId);
  await index.save();
  ctx.feed.append({ type: 'note.restored', kind: 'note', id, parentId, revision: Number(meta.revision ?? 0) | 0 }, device);
  return Notes.summary(id, await index.noteEntry(id));
}

async function recreateFolder(ctx, parentRel, parentId, f, device) {
  const { fs, index } = ctx;
  const seg = await Names.unique(fs, parentRel, Names.segment(String(f.name ?? ''), 'Cartella ripristinata'), null, parentRel === '');
  const rel = childRel(parentRel, seg);
  const oldId = f.id ?? null;
  const id = typeof oldId === 'string' && LOOSE_ID_RE.test(oldId) && !(await index.load()).folders[oldId] ? oldId : uuid();
  const color = typeof f.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(f.color) ? f.color.toUpperCase() : null;
  const info = { version: 1, id, name: seg, color, created: now() };
  await fs.mkdir(rel);
  await fs.writeJson(`${rel}/.folder.json`, info);
  await index.putFolder(id, rel, parentId, info);
  await index.save();
  ctx.feed.append({ type: 'folder.created', kind: 'folder', id, parentId }, device);
  return id;
}
