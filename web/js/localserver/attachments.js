// Files attached to a note (images, PDFs, slides), in <note>/attachments/ (port of Attachments.php).
// Names are sanitised and de-duplicated like folder names; originals are never changed.
import { ApiError, assertId, nfc, cpLen, cpSlice } from './util.js';
import * as Names from './names.js';

export const MAX_BYTES = 200 * 1024 * 1024;

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', zip: 'application/zip',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** MIME type from the content (common formats) or the extension. */
export function mime(name, bytes) {
  if (bytes && bytes.length >= 4) {
    const b = bytes;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  }
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME[ext] || 'application/octet-stream';
}

const dirOf = async (ctx, noteId) => `${await ctx.index.notePath(noteId)}/attachments`;

/** A stored attachment name: one safe path segment. */
export function assertName(name) {
  if (typeof name !== 'string' || name === '' || cpLen(name) > 120 || /[/\\<>:"|?*\x00-\x1F]|^\.|\.\./u.test(name)) {
    throw new ApiError(400, 'bad_name', 'Nome del file allegato non valido.');
  }
}

/** Safe, de-duplicated name in dir for a wanted file name (keeps the extension). */
export async function uniqueName(fs, dir, wanted) {
  wanted = nfc(String(wanted).replace(/\\/g, '/').split('/').pop());
  const dot = wanted.lastIndexOf('.');
  let ext = dot > 0 ? wanted.slice(dot + 1).toLowerCase() : '';
  ext = /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
  let stem = dot > 0 ? wanted.slice(0, dot) : wanted;
  stem = cpSlice(Names.segment(stem, 'file'), 0, 100);
  const name = ext === '' ? stem : `${stem}.${ext}`;
  if (!(await fs.isDir(dir))) return name;
  // Same rule as folders: case-insensitive collisions get " (2)", " (3)" ...
  const taken = new Set((await fs.list(dir)).map(Names.key));
  let i = 1;
  let candidate = name;
  while (taken.has(Names.key(candidate))) {
    i++;
    candidate = ext === '' ? `${stem} (${i})` : `${stem} (${i}).${ext}`;
  }
  return candidate;
}

/** POST /api/notes/{id}/attachments: { file: {name, bytes}, name? }. Returns the stored name. */
export async function saveUpload(ctx, noteId, file, wantedName) {
  assertId(noteId);
  if (!file || !(file.bytes instanceof Uint8Array)) throw new ApiError(400, 'no_file', 'Nessun file ricevuto.');
  if (file.bytes.length > MAX_BYTES) throw new ApiError(413, 'too_large', 'File troppo grande (massimo 200 MB).');
  const wanted = typeof wantedName === 'string' && wantedName !== '' ? wantedName : String(file.name || 'file');
  return store(ctx, noteId, file.bytes, wanted);
}

export async function store(ctx, noteId, bytes, wanted) {
  const { fs } = ctx;
  const dir = await dirOf(ctx, noteId);
  await fs.mkdir(dir);
  const name = await uniqueName(fs, dir, wanted);
  await fs.writeAtomic(`${dir}/${name}`, bytes);
  return { name, size: bytes.length, mime: mime(name, bytes) };
}

/** The file's bytes and type (GET /api/notes/{id}/attachments/{name}). */
export async function read(ctx, noteId, name) {
  assertId(noteId);
  assertName(name);
  const bytes = await ctx.fs.read(`${await dirOf(ctx, noteId)}/${name}`);
  if (bytes === null) throw new ApiError(404, 'attachment_not_found', 'Allegato non trovato.');
  return { bytes, type: mime(name, bytes) };
}

/** Names of the attachments of a note. */
export async function list(ctx, noteId) {
  const dir = await dirOf(ctx, noteId);
  return (await ctx.fs.entries(dir)).filter((e) => !e.dir && !e.name.startsWith('.')).map((e) => e.name);
}
