// Auto covers (cover.png) are fetched with the token header and shown as blob URLs,
// because <img src> cannot send headers. Loaded lazily when the card scrolls into view.
import * as prefs from '../prefs.js';

const cache = new Map();   // noteId -> { version, url, promise }
let observer = null;

function load(noteId, version) {
  const hit = cache.get(noteId);
  if (hit && hit.version === version) return hit.promise;
  if (hit?.url) URL.revokeObjectURL(hit.url);
  const entry = { version, url: null };
  entry.promise = fetch(`${prefs.serverBase()}/api/notes/${noteId}/cover?v=${version}`, {
    headers: { 'X-Quadernone-Token': prefs.get('token') },
  }).then((r) => (r.ok ? r.blob() : null)).then((b) => {
    entry.url = b ? URL.createObjectURL(b) : null;
    return entry.url;
  }).catch(() => null);
  cache.set(noteId, entry);
  return entry.promise;
}

/** Fills img with the note's cover once the image is near the viewport. */
export function lazyCover(img, noteId, version) {
  const hit = cache.get(noteId);
  if (hit?.url && hit.version === version) { img.src = hit.url; img.classList.add('loaded'); return; }
  observer ||= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      observer.unobserve(e.target);
      const { noteId: id, version: v } = e.target.dataset;
      load(id, v).then((url) => { if (url) { e.target.src = url; e.target.classList.add('loaded'); } });
    }
  }, { rootMargin: '300px' });
  img.dataset.noteId = noteId;
  img.dataset.version = version;
  observer.observe(img);
}
