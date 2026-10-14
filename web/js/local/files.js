// Note attachments (images, PDFs, slides) on this device.
//
// Every attachment is kept in IndexedDB once seen, so notes with images and PDFs open
// without the server. A file added while the server is unreachable is stored as
// "pending" under the name the app chose; local/sync.js uploads it before the pages
// that use it, and renames the references if the server had to pick another name.
import * as prefs from '../prefs.js';
import * as db from './db.js';
import { ApiFailure } from '../api.js';
import { t } from '../i18n.js';

const keyOf = (noteId, name) => `${noteId}/${name}`;
const inflight = new Map();   // key -> Promise<Blob>
const urls = new Map();       // key -> object URL

const authHeaders = () => ({ 'X-Quadernone-Token': prefs.get('token'), 'X-Quadernone-Device': prefs.get('deviceName') || 'Sconosciuto' });
const fileUrl = (noteId, name) => `${prefs.serverBase()}/api/notes/${noteId}/attachments/${encodeURIComponent(name)}`;

/** The attachment as a Blob: from the device, or downloaded once and kept. */
export function getFile(noteId, name) {
  const key = keyOf(noteId, name);
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const rec = await db.getFile(key);
    if (rec?.blob) return rec.blob;
    let res;
    try {
      res = await fetch(fileUrl(noteId, name), { headers: authHeaders(), cache: 'no-store' });
    } catch {
      throw new ApiFailure(0, 'offline', t('files.offline'));
    }
    if (!res.ok) throw new ApiFailure(res.status, 'attachment', t('files.missing', { name }));
    const blob = await res.blob();
    await db.putFile({ key, noteId, name, blob, pending: false }).catch(() => {});
    return blob;
  })();
  inflight.set(key, p);
  p.finally(() => inflight.delete(key));
  return p;
}

/** Object URL for <img> (kept for the session). */
export async function objectUrl(noteId, name) {
  const key = keyOf(noteId, name);
  if (urls.has(key)) return urls.get(key);
  const url = URL.createObjectURL(await getFile(noteId, name));
  urls.set(key, url);
  return url;
}

/**
 * Uploads a file to a note (multipart, with progress). wanted: the preferred name.
 * Resolves to the name stored on the server. Throws ApiFailure (status 0 = offline).
 */
export async function upload(noteId, blob, wanted, onProgress) {
  // The local server stores the file directly in the note folder (no network, no real progress).
  onProgress?.(0);
  const fd = new FormData();
  fd.append('file', blob, wanted);
  fd.append('name', wanted);
  const res = await fetch(`${prefs.serverBase()}/api/notes/${noteId}/attachments`, { method: 'POST', headers: authHeaders(), body: fd });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.status === 201 && data?.name) { onProgress?.(1); return data.name; }
  throw new ApiFailure(res.status, data?.error?.code || 'upload', data?.error?.message || t('files.uploadFailed'));
}

/**
 * Adds a file to a note: uploaded now if possible, otherwise kept on the device and
 * uploaded later. Resolves to { name, pending }.
 */
export async function addFile(noteId, blob, wanted, { onProgress, localOnly = false } = {}) {
  if (!localOnly) {
    try {
      const name = await upload(noteId, blob, wanted, onProgress);
      await db.putFile({ key: keyOf(noteId, name), noteId, name, blob, pending: false }).catch(() => {});
      return { name, pending: false };
    } catch (e) {
      if (e.status !== 0 && e.status !== 404) throw e;   // 404: the note is not on the server yet
    }
  }
  await db.putFile({ key: keyOf(noteId, wanted), noteId, name: wanted, blob, pending: true });
  return { name: wanted, pending: true };
}

/** Uploads the files of a note still pending. Returns { oldName: newName } for renamed ones. */
export async function flushPending(noteId) {
  const renamed = {};
  for (const f of await db.noteFiles(noteId)) {
    if (!f.pending) continue;
    const name = await upload(noteId, f.blob, f.name);
    await db.putFile({ key: keyOf(noteId, name), noteId, name, blob: f.blob, pending: false });
    if (name !== f.name) {
      await db.deleteFile(f.key);
      renamed[f.name] = name;
    }
  }
  return renamed;
}

export const hasPending = async (noteId) => (await db.noteFiles(noteId)).some((f) => f.pending);

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
