// Folder operations (port of Folders.php).
import { ApiError, assertId, uuid, now, hex, stampSpaced } from './util.js';
import * as Names from './names.js';
import { Fs } from './fs.js';
import * as Trash from './trash.js';

export function validColor(c) {
  if (c === null || c === undefined) return null;
  if (typeof c !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(c)) {
    throw new ApiError(400, 'bad_color', 'Colore non valido (usa il formato #RRGGBB).');
  }
  return c.toUpperCase();
}

export const toPublic = (id, f) => ({ id, parentId: f.parentId, name: f.name, color: f.color, created: f.created });

const childRel = (parentRel, seg) => (parentRel === '' ? seg : `${parentRel}/${seg}`);

/** Creates a folder; returns [folder, warnings]. */
export async function create(ctx, parentId, name, color, device) {
  const { fs, index } = ctx;
  const parentRel = await index.folderPath(parentId);
  parentId = parentRel === '' ? null : parentId;
  const seg = await Names.unique(fs, parentRel, Names.segment(name, 'Nuova cartella'), null, parentRel === '');
  const rel = childRel(parentRel, seg);
  const info = { version: 1, id: uuid(), name: seg, color: validColor(color), created: now() };
  // Build in a hidden temp folder, then rename: no half-made folder is ever visible.
  const tmp = Fs.join(parentRel, `.~new-${hex(4)}`);
  await fs.mkdir(tmp);
  try {
    await fs.writeJson(`${tmp}/.folder.json`, info);
    await fs.rename(tmp, rel);
  } catch (e) {
    await fs.unlink(tmp);
    throw e;
  }
  await index.putFolder(info.id, rel, parentId, info);
  await index.save();
  ctx.feed.append({ type: 'folder.created', kind: 'folder', id: info.id, parentId }, device);
  return [toPublic(info.id, await index.folder(info.id)), []];
}

/** Rename / move / colour. input may hold name, parentId, color. */
export async function update(ctx, id, input, device) {
  const { fs, index } = ctx;
  assertId(id);
  const f = { ...(await index.folder(id)) };
  let rel = f.path;
  const events = [];

  let newParentId = f.parentId;
  if (Object.hasOwn(input, 'parentId')) {
    const p = input.parentId;
    newParentId = p === null || p === '' || p === 'root' ? null : String(p);
    if (newParentId !== null) {
      assertId(newParentId);
      if ((await index.subtreeFolderIds(id)).includes(newParentId)) {
        throw new ApiError(400, 'bad_move', 'Non puoi spostare una cartella dentro sé stessa.');
      }
    }
  }
  const moving = newParentId !== f.parentId;
  const renaming = Object.hasOwn(input, 'name') && typeof input.name === 'string'
    && Names.segment(input.name, 'Nuova cartella') !== f.name;

  if (moving || renaming) {
    const parentRel = await index.folderPath(newParentId);
    const wanted = Names.segment(renaming ? String(input.name) : f.name, 'Nuova cartella');
    const currentName = Fs.basename(rel);
    const seg = await Names.unique(fs, parentRel, wanted, moving ? null : currentName, parentRel === '');
    const newRel = childRel(parentRel, seg);
    if (newRel !== rel) {
      if (!moving && Names.key(seg) === Names.key(currentName)) {
        // Case-only rename: case-insensitive storage needs a detour through a temp name.
        const detour = Fs.join(parentRel, `.~ren-${hex(4)}`);
        await fs.rename(rel, detour);
        await fs.rename(detour, newRel);
      } else {
        await fs.rename(rel, newRel);
      }
    }
    const info = (await fs.readJson(`${newRel}/.folder.json`)) ?? { version: 1, id, created: f.created };
    info.name = seg;
    await fs.writeJson(`${newRel}/.folder.json`, info);
    await index.rebasePaths(rel, newRel);
    f.path = newRel;
    f.name = seg;
    f.parentId = newParentId;
    rel = newRel;
    if (renaming) events.push('folder.renamed');
    if (moving) events.push('folder.moved');
  }

  if (Object.hasOwn(input, 'color')) {
    const color = validColor(input.color);
    if (color !== f.color) {
      const info = (await fs.readJson(`${rel}/.folder.json`)) ?? { version: 1, id, name: f.name, created: f.created };
      info.color = color;
      await fs.writeJson(`${rel}/.folder.json`, info);
      f.color = color;
      events.push('folder.renamed');   // no colour event: "renamed" makes clients refresh it
    }
  }

  await index.putFolder(id, f.path, f.parentId, f);
  await index.save();
  for (const type of new Set(events)) ctx.feed.append({ type, kind: 'folder', id, parentId: f.parentId }, device);
  return [toPublic(id, await index.folder(id)), []];
}

/** How many notes a delete would send to the trash (for the confirmation dialog). */
export async function countNotes(ctx, id) {
  const { index } = ctx;
  await index.folderPath(id);
  const ids = new Set(await index.subtreeFolderIds(id));
  let n = 0;
  for (const note of Object.values((await index.load()).notes)) {
    if (note.parentId !== null && ids.has(note.parentId)) n++;
  }
  return n;
}

/**
 * Moves every note in the folder and its subfolders to the trash, then removes the
 * folders. Files the app does not recognise are never deleted: whatever is left goes
 * to _trash/_residui/.
 */
export async function remove(ctx, id, device) {
  const { fs, index } = ctx;
  assertId(id);
  await index.scan();   // act on the real disk state
  const f = await index.folder(id);
  const folderIds = await index.subtreeFolderIds(id);
  const set = new Set(folderIds);
  let trashed = 0;
  for (const [noteId, note] of Object.entries({ ...(await index.load()).notes })) {
    if (note.parentId !== null && set.has(note.parentId)) {
      await Trash.trashNote(ctx, noteId, device);
      trashed++;
    }
  }
  const leftover = await removeEmptyFolders(fs, f.path);
  if (leftover) {
    const dest = '_trash/_residui';
    await fs.mkdir(dest);
    const name = await Names.unique(fs, dest, Names.segment(`${stampSpaced()} ${f.name}`, 'cartella'));
    await fs.rename(f.path, `${dest}/${name}`);
    ctx.log('INFO', 'folder leftovers kept', { folder: f.path, to: `_trash/_residui/${name}` });
  }
  // Children first, so clients never see an orphan.
  for (const fid of [...folderIds].reverse()) {
    const parent = (await index.load()).folders[fid]?.parentId ?? null;
    await index.removeFolder(fid);
    ctx.feed.append({ type: 'folder.deleted', kind: 'folder', id: fid, parentId: parent }, device);
  }
  await index.save();
  return { trashedNotes: trashed, leftovers: leftover };
}

/** Deletes folders that contain nothing but .folder.json (deepest first). True if anything unrecognised remains. */
async function removeEmptyFolders(fs, rel) {
  let left = false;
  for (const e of await fs.entries(rel)) {
    const p = `${rel}/${e.name}`;
    if (e.dir) {
      if ((await fs.isFile(`${p}/meta.json`)) || (await removeEmptyFolders(fs, p))) left = true;
    } else if (e.name !== '.folder.json' && e.name !== 'desktop.ini') {
      left = true;
    }
  }
  if (left) return true;
  await fs.removeTree(rel);
  return false;
}
