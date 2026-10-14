// Handwriting, stored per page in ink/<pageId>.json with its own revision counter
// (pages.json keeps the same number as inkRevision). Port of Ink.php.
import { ApiError, assertId, now, isNum, isInt, isPlainObject } from './util.js';
import * as Notes from './notes.js';

export const TOOLS = ['ballpoint', 'fountain', 'pencil', 'marker', 'highlighter'];
const MAX_STROKES = 50000;
const MAX_POINTS = 20000;

export const file = (noteRel, pageId) => `${noteRel}/ink/${pageId}.json`;

export function assertPageId(pageId) {
  if (typeof pageId !== 'string' || !/^pg-[0-9a-f]{8}$/.test(pageId)) throw new ApiError(400, 'bad_page', 'Pagina non valida.');
}

/** Current revision of a page's ink: pages.json is the reference. */
function pageRevision(pages, pageId) {
  for (const p of pages?.pages || []) if (p?.id === pageId) return Number(p.inkRevision ?? 0) | 0;
  return null;
}

/** { version, pageId, revision, strokes } (empty if the page has no ink yet). */
export async function readFile(fs, noteRel, pageId, revision) {
  const ink = await fs.readJson(file(noteRel, pageId));
  return { version: 1, pageId, revision, strokes: Array.isArray(ink?.strokes) ? ink.strokes : [] };
}

export async function get(ctx, noteId, pageId) {
  assertId(noteId);
  assertPageId(pageId);
  const rel = await ctx.index.notePath(noteId);
  const rev = pageRevision((await ctx.fs.readJson(`${rel}/pages.json`)) ?? {}, pageId);
  if (rev === null) throw new ApiError(404, 'page_not_found', 'Pagina non trovata.');
  return readFile(ctx.fs, rel, pageId, rev);
}

/** All pages' ink of a note folder, keyed by page id (for GET /api/notes/{id}?ink=1). */
export async function all(fs, noteRel, pages) {
  const out = {};
  for (const p of pages?.pages || []) out[p.id] = await readFile(fs, noteRel, p.id, Number(p.inkRevision ?? 0) | 0);
  return out;
}

function bad(what) {
  throw new ApiError(400, 'bad_ink', `Dati della scrittura non validi (${what}).`);
}

export function validateStrokes(strokes) {
  if (!Array.isArray(strokes) || strokes.length > MAX_STROKES) bad('strokes');
  return strokes.map((s, i) => {
    if (!isPlainObject(s) || typeof s.id !== 'string' || !/^st-[0-9a-f]{8}$/.test(s.id)
      || !TOOLS.includes(s.tool)
      || typeof s.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(s.color)
      || !isNumeric(s.width) || Number(s.width) <= 0 || Number(s.width) > 60
      || !Array.isArray(s.points) || s.points.length < 1 || s.points.length > MAX_POINTS) bad(`strokes[${i}]`);
    for (const pt of s.points) {
      if (!Array.isArray(pt) || pt.length < 2 || pt.length > 4) bad(`strokes[${i}].points`);
      for (const v of pt) if (!isNum(v)) bad(`strokes[${i}].points`);
    }
    const clean = {
      id: s.id, tool: s.tool, color: s.color.toUpperCase(),
      width: Number(s.width), opacity: Math.max(0.05, Math.min(1, Number(s.opacity ?? 1) || 0)),
      points: s.points,
    };
    if (s.tip === 'round' || s.tip === 'chisel') clean.tip = s.tip;
    if (typeof s.pressure === 'boolean') clean.pressure = s.pressure;
    return clean;
  });
}

const isNumeric = (v) => isNum(v) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

/**
 * PUT /api/notes/{id}/ink/{pageId}: { baseInkRevision, strokes }.
 * Returns { inkRevision }; a stale base answers 409 with a conflict copy.
 */
export async function save(ctx, noteId, pageId, input, device) {
  const { fs, index } = ctx;
  assertId(noteId);
  assertPageId(pageId);
  if (!isInt(input.baseInkRevision)) throw new ApiError(400, 'bad_revision', 'Manca baseInkRevision.');
  const strokes = validateStrokes(input.strokes ?? null);
  const rel = await index.notePath(noteId);
  const pages = await fs.readJson(`${rel}/pages.json`);
  const meta = await fs.readJson(`${rel}/meta.json`);
  if (pages === null || meta === null) throw new ApiError(503, 'unreadable', 'Impossibile leggere la nota.');
  const current = pageRevision(pages, pageId);
  if (current === null) throw new ApiError(404, 'page_not_found', 'Pagina non trovata (forse è stata eliminata).');
  if (input.baseInkRevision !== current) {
    const copy = await Notes.conflictCopy(ctx, noteId, rel, meta, pages, Number(meta.revision ?? 0) | 0, device, { [pageId]: strokes });
    throw new ApiError(409, 'conflict',
      'Questa pagina è stata modificata da un altro dispositivo. La tua scrittura è salva in una copia di conflitto.',
      { copyId: copy.id, inkRevision: current, copyRevision: copy.revision });
  }
  const next = current + 1;
  await write(fs, rel, pages, pageId, strokes, next);
  // Ink does not bump meta.revision (that counter is for meta/pages/text), but the note
  // did change: keep "modified" and the last device up to date for the Library.
  meta.modified = now();
  meta.lastDevice = device;
  await fs.writeJson(`${rel}/meta.json`, meta);
  const parentId = (await index.noteEntry(noteId)).parentId;
  await index.putNote(noteId, rel, parentId);
  await index.save();
  ctx.feed.append({ type: 'note.ink', kind: 'note', id: noteId, parentId, revision: next, pageId }, device);
  return { inkRevision: next };
}

/** Writes ink/<pageId>.json, then the matching inkRevision into pages.json. */
export async function write(fs, rel, pages, pageId, strokes, revision) {
  // Compact JSON: points would make a pretty-printed file many times larger.
  await fs.writeAtomic(file(rel, pageId), JSON.stringify({ version: 1, pageId, revision, strokes }) + '\n');
  for (const p of pages.pages) if (p.id === pageId) p.inkRevision = revision;
  await fs.writeJson(`${rel}/pages.json`, pages);
}
