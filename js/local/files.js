// Note attachments (images, PDFs, slides). They live on this device with the note
// (local/server.js); here they are read once per session and kept as Blobs, object URLs
// and decoded images for drawing.
import { request, ApiFailure } from '../api.js';
import { t } from '../i18n.js';

const keyOf = (noteId, name) => `${noteId}/${name}`;
const blobs = new Map();   // key -> Promise<Blob>
const urls = new Map();    // key -> object URL

/** The attachment as a Blob. */
export function getFile(noteId, name) {
  const key = keyOf(noteId, name);
  if (!blobs.has(key)) {
    const p = request('GET', `/notes/${noteId}/attachments/${encodeURIComponent(name)}`).then((r) => r.__blob)
      .catch((e) => { throw e.status === 404 ? new ApiFailure(404, 'attachment', t('files.missing', { name })) : e; });
    p.catch(() => blobs.delete(key));
    blobs.set(key, p);
  }
  return blobs.get(key);
}

/** Object URL for <img> (kept for the session). */
export async function objectUrl(noteId, name) {
  const key = keyOf(noteId, name);
  if (urls.has(key)) return urls.get(key);
  const url = URL.createObjectURL(await getFile(noteId, name));
  urls.set(key, url);
  return url;
}

/** Stores a file in a note. wanted: the preferred name. Resolves to the stored name. */
export async function upload(noteId, blob, wanted, onProgress) {
  onProgress?.(0);
  const res = await request('POST', `/notes/${noteId}/attachments`, { blob, name: wanted });
  blobs.set(keyOf(noteId, res.name), Promise.resolve(blob));
  onProgress?.(1);
  return res.name;
}

/** Adds a file to a note. Resolves to { name, pending: false } (always stored at once). */
export async function addFile(noteId, blob, wanted, { onProgress } = {}) {
  return { name: await upload(noteId, blob, wanted, onProgress), pending: false };
}

/** Nothing is ever left to upload: kept for the modules written for the server version. */
export async function flushPending() { return {}; }
export const hasPending = async () => false;

/** Short random part for generated names (img-1a2b3c4d.jpg). */
export const randomTag = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Decoded image (cached per session) for drawing into canvases. */
const bitmaps = new Map();
export function imageBitmap(noteId, name) {
  const key = keyOf(noteId, name);
  if (!bitmaps.has(key)) {
    const p = getFile(noteId, name).then((b) => createImageBitmap(b));
    p.catch(() => bitmaps.delete(key));
    bitmaps.set(key, p);
  }
  return bitmaps.get(key);
}

/** Forgets cached copies of a note's files (after Drive replaced them). */
export function forgetNote(noteId) {
  for (const m of [blobs, bitmaps]) for (const k of [...m.keys()]) if (k.startsWith(noteId + '/')) m.delete(k);
  for (const [k, url] of [...urls]) if (k.startsWith(noteId + '/')) { URL.revokeObjectURL(url); urls.delete(k); }
}
