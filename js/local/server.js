// The local server: the /api of the home-server version (lib/*.php), running inside the app
// on this device over local/disk.js. Same routes, same JSON, same rules:
//   - every save carries baseRevision; a stale one never overwrites: it makes a conflict copy (409);
//   - handwriting is saved per page with its own revision;
//   - deleted notes go to the trash and are purged after the retention period;
//   - every change is appended to a feed (/changes) that the Library polls.
// The client modules talk to it through api.js exactly as they talked to PHP.
import * as disk from './disk.js';
import { ServerError, notFound } from './errors.js';
import { cleanTitle, segment, unique, attachmentName, now, uuid, isUuid, fold, key as nameKey, UNTITLED } from './names.js';
import { newDocument, validateDocument, buildMarkdown, snippetOf } from './notefiles.js';
import { APP_VERSION } from '../version.js';

const NOTE_STORES = ['folders', 'notes', 'ink', 'files', 'feed', 'kv'];
const DEFAULT_SETTINGS = { trashRetentionDays: 30 };
const TOOLS = ['ballpoint', 'fountain', 'pencil', 'marker', 'highlighter'];

// Hooks set by other modules (Drive: .pptx conversion).
export const hooks = { convertPptx: null };

// ------------------------------------------------------------------ helpers

const assertId = (id) => { if (!isUuid(id)) throw new ServerError(400, 'bad_id', 'Identificativo non valido.'); };
const assertPage = (pid) => { if (!/^pg-[0-9a-f]{8}$/.test(pid)) throw new ServerError(400, 'bad_page', 'Pagina non valida.'); };
const optId = (v) => {
  if (v === null || v === undefined || v === '' || v === 'root') return null;
  if (typeof v !== 'string') throw new ServerError(400, 'bad_id', 'Identificativo non valido.');
  assertId(v);
  return v;
};
const validColor = (c) => {
  if (c === null || c === undefined) return null;
  if (typeof c !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(c)) throw new ServerError(400, 'bad_color', 'Colore non valido (usa il formato #RRGGBB).');
  return c.toUpperCase();
};

export async function appendFeed(s, c, device) {
  const seq = ((await s.kv.get('seq')) || 0) + 1;
  await s.kv.put(seq, 'seq');
  await s.feed.put({ seq, time: now(), type: c.type, kind: c.kind, id: c.id ?? null, parentId: c.parentId ?? null,
    revision: c.revision ?? null, pageId: c.pageId ?? null, device, ...(c.extra || {}) });
  // Keep the last 5000 changes; older clients get {reset:true} and reload the tree.
  if (seq % 500 === 0) s.feed.raw.delete(IDBKeyRange.upperBound(seq - 5000));
  return seq;
}

async function settingsOf(s) {
  return { ...DEFAULT_SETTINGS, ...((await s.kv.get('settings')) || {}) };
}

async function liveNote(s, id) {
  const n = await s.notes.get(id);
  if (!n || n.trash) throw notFound('note');
  return n;
}

async function folderOf(s, id) {
  if (id === null) return null;
  const f = await s.folders.get(id);
  if (!f) throw notFound('folder');
  return f;
}

export function summary(n) {
  const m = n.meta;
  return {
    id: n.id, folderId: n.folderId, title: m.title, created: m.created ?? null, modified: m.modified ?? null,
    favorite: !!m.favorite, cover: m.cover ?? { mode: 'auto', color: null, icon: null, image: null },
    hasCoverImage: !!n.coverStamp, coverVersion: n.coverStamp || null,
    revision: m.revision | 0, lastDevice: m.lastDevice ?? null, conflictOf: m.conflictOf ?? null, snippet: n.snippet || '',
  };
}

const folderPublic = (f) => ({ id: f.id, parentId: f.parentId, name: f.name, color: f.color ?? null, created: f.created });

/** Folder ids of id and every folder below it. */
function subtree(folders, id) {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const f of folders) if (f.parentId === out[i]) out.push(f.id);
  return out;
}

function chainOf(folders, id) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = [];
  for (let f = byId.get(id), guard = 0; f && guard < 200; f = byId.get(f.parentId), guard++) out.unshift(f);
  return out;
}

/** Name for a new or renamed folder, unique among its siblings (as folder names on disk). */
function folderName(folders, parentId, wanted, selfId = null) {
  const seg = segment(wanted, 'Nuova cartella');
  return unique(seg, folders.filter((f) => f.parentId === parentId && f.id !== selfId).map((f) => f.name));
}

function touch(n, { derived = false } = {}) {
  if (derived) n.dchg = (n.dchg || 0) + 1; else n.chg = (n.chg || 0) + 1;
}

function writeText(n, title, pages) {
  n.markdown = buildMarkdown(title, pages);
  n.snippet = snippetOf(n.markdown);
}

function isoDate(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t) || t < 0 || t > Date.now() + 86400000) throw new ServerError(400, 'bad_date', 'Data non valida.');
  return new Date(t).toISOString();
}

function cover(c) {
  if (!c || !['auto', 'image', 'preset'].includes(c.mode)) throw new ServerError(400, 'bad_cover', 'Copertina non valida.');
  const icon = c.icon ?? null;
  if (icon !== null && (typeof icon !== 'string' || !/^[a-z0-9-]{1,24}$/.test(icon))) throw new ServerError(400, 'bad_cover', 'Icona della copertina non valida.');
  const image = c.image ?? null;
  if (image !== null && (typeof image !== 'string' || /[/\\]|^\./.test(image) || image.length > 120)) throw new ServerError(400, 'bad_cover', 'Immagine della copertina non valida.');
  if (c.mode === 'image' && image === null) throw new ServerError(400, 'bad_cover', "Manca l'immagine della copertina.");
  return { mode: c.mode, color: validColor(c.color ?? null), icon, image };
}

function validateStrokes(strokes) {
  const bad = (w) => { throw new ServerError(400, 'bad_ink', `Dati della scrittura non validi (${w}).`); };
  if (!Array.isArray(strokes) || strokes.length > 50000) bad('strokes');
  return strokes.map((st, i) => {
    if (!st || typeof st.id !== 'string' || !/^st-[0-9a-f]{8}$/.test(st.id) || !TOOLS.includes(st.tool)
      || typeof st.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(st.color)
      || !(st.width > 0 && st.width <= 60) || !Array.isArray(st.points) || st.points.length < 1 || st.points.length > 20000) bad(`strokes[${i}]`);
    const clean = { id: st.id, tool: st.tool, color: st.color.toUpperCase(), width: +st.width,
      opacity: Math.max(0.05, Math.min(1, +(st.opacity ?? 1))), points: st.points };
    if (st.tip === 'round' || st.tip === 'chisel') clean.tip = st.tip;
    if (typeof st.pressure === 'boolean') clean.pressure = st.pressure;
    return clean;
  });
}

const mimeOf = (name, blob) => {
  if (blob?.type) return blob.type;
  const ext = name.split('.').pop().toLowerCase();
  return { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    avif: 'image/avif', svg: 'image/svg+xml', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain', json: 'application/json' }[ext] || 'application/octet-stream';
};

const typed = (blob, type) => (blob.type === type ? blob : new Blob([blob], { type }));

// ------------------------------------------------------------------ notes

async function createNote(b, device) {
  const title = cleanTitle(b.title ?? '') || UNTITLED;
  const pages = newDocument(b.pageDefaults ?? null);
  let folderId = optId(b.folderId ?? null);
  const id = b.id != null ? optId(b.id) : null;
  return disk.write(NOTE_STORES, async (s) => {
    if (id) {
      const existing = await s.notes.get(id);
      if (existing && !existing.trash) return { note: summary(existing), warnings: [], seq: await s.kv.get('seq') };
    }
    await folderOf(s, folderId);
    const t = now();
    const created = isoDate(b.created) ?? t;
    const modified = isoDate(b.modified) ?? created;
    const meta = { version: 1, id: id ?? uuid(), title, created, modified, favorite: false,
      cover: { mode: 'auto', color: null, icon: null, image: null }, revision: 1, lastDevice: device, conflictOf: null };
    const n = { id: meta.id, folderId, meta, pages, markdown: '', snippet: '', coverStamp: null, trash: null, chg: 1, dchg: 0 };
    writeText(n, title, pages);
    await s.notes.put(n);
    const seq = await appendFeed(s, { type: 'note.created', kind: 'note', id: meta.id, parentId: folderId, revision: 1 }, device);
    return { note: summary(n), warnings: [], seq };
  });
}

async function noteInk(s, n) {
  const out = {};
  const rows = new Map((await s.ink.byNote(n.id)).map((r) => [r.pageId, r]));
  for (const p of n.pages.pages) out[p.id] = { version: 1, pageId: p.id, revision: p.inkRevision | 0, strokes: rows.get(p.id)?.strokes || [] };
  return out;
}

async function getNote(id, withInk) {
  assertId(id);
  const { n, folders, ink, fileRows } = await disk.read(NOTE_STORES, async (s) => {
    const n = await liveNote(s, id);
    return { n, folders: await s.folders.all(), ink: withInk ? await noteInk(s, n) : null, fileRows: await s.files.byNote(id) };
  });
  const chain = chainOf(folders, n.folderId).map((f) => f.name);
  let size = JSON.stringify(n.pages).length + (n.markdown || '').length;
  for (const f of fileRows) size += f.blob?.size || 0;
  if (ink) for (const v of Object.values(ink)) size += v.strokes.length ? JSON.stringify(v.strokes).length : 0;
  const out = { meta: n.meta, pages: n.pages, markdown: n.markdown, folderId: n.folderId,
    path: [...chain, segment(n.meta.title, UNTITLED)].join('/'), sizeBytes: size };
  if (ink) out.ink = ink;
  return out;
}

/** Copy of the current note with the rejected change on top, as a sibling note (inside a write tx). */
export async function conflictCopy(s, orig, rejectedMeta, rejectedPages, baseRevision, device, rejectedInk = {}, { title: fixedTitle = null } = {}) {
  const t = now();
  const stamp = new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16).replace(':', '-');
  const title = fixedTitle ? cleanTitle(fixedTitle) : cleanTitle(`${rejectedMeta.title} (conflitto ${device} ${stamp})`);
  const meta = { ...structuredClone(rejectedMeta), id: uuid(), title, modified: t, revision: 1, lastDevice: device,
    conflictOf: { id: orig.id, baseRevision, device, time: t } };
  const pages = structuredClone(rejectedPages);
  const copy = { id: meta.id, folderId: orig.folderId, meta, pages, markdown: '', snippet: '', coverStamp: orig.coverStamp, trash: null, chg: 1, dchg: 1 };
  for (const r of await s.ink.byNote(orig.id)) {
    await s.ink.put({ ...r, key: disk.inkKey(copy.id, r.pageId), noteId: copy.id });
  }
  for (const [pid, strokes] of Object.entries(rejectedInk)) {
    const page = pages.pages.find((p) => p.id === pid);
    if (!page) continue;
    page.inkRevision = (page.inkRevision | 0) + 1;
    await s.ink.put({ key: disk.inkKey(copy.id, pid), noteId: copy.id, pageId: pid, revision: page.inkRevision, strokes });
  }
  for (const f of await s.files.byNote(orig.id)) {
    await s.files.put({ ...f, key: disk.fileKey(copy.id, f.path), noteId: copy.id });
  }
  writeText(copy, title, pages);
  await s.notes.put(copy);
  await appendFeed(s, { type: 'note.conflict', kind: 'note', id: copy.id, parentId: copy.folderId, revision: 1, extra: { originalId: orig.id } }, device);
  return copy;
}

async function saveNote(id, inp, device) {
  assertId(id);
  if (!Number.isInteger(inp?.baseRevision)) throw new ServerError(400, 'bad_revision', 'Manca baseRevision.');
  if (!inp.meta && !inp.pages) throw new ServerError(400, 'nothing_to_save', 'Niente da salvare.');
  return unwrapConflict(await disk.write(NOTE_STORES, async (s) => {
    const n = await liveNote(s, id);
    const meta = n.meta;
    const newMeta = { ...meta };
    const mi = inp.meta || {};
    if ('title' in mi) newMeta.title = cleanTitle(mi.title ?? '') || UNTITLED;
    if ('favorite' in mi) {
      if (typeof mi.favorite !== 'boolean') throw new ServerError(400, 'bad_meta', 'favorite deve essere vero o falso.');
      newMeta.favorite = mi.favorite;
    }
    if ('cover' in mi) newMeta.cover = cover(mi.cover);
    const newPages = inp.pages ? validateDocument(inp.pages, n.pages) : null;
    const current = meta.revision | 0;
    if (inp.baseRevision !== current) {
      // The copy is committed with the transaction; the 409 is thrown after it (see below).
      const copy = await conflictCopy(s, n, newMeta, newPages ?? n.pages, inp.baseRevision, device);
      return { conflict: new ServerError(409, 'conflict', 'La nota è stata modificata da un altro dispositivo. Le tue modifiche sono salve in una copia di conflitto.',
        { copyId: copy.id, revision: current, copyRevision: 1 }) };
    }
    const type = newMeta.title !== meta.title ? 'note.renamed' : 'note.updated';
    newMeta.revision = current + 1;
    newMeta.modified = ('modified' in mi ? isoDate(mi.modified) : null) ?? now();
    newMeta.lastDevice = device;
    n.meta = newMeta;
    if (newPages) n.pages = newPages;
    writeText(n, newMeta.title, n.pages);
    touch(n);
    if (newPages) {
      // Ink of pages that no longer exist leaves the note (as their files on the server).
      const ids = new Set(newPages.pages.map((p) => p.id));
      for (const k of await s.ink.keysByNote(id)) if (!ids.has(k.slice(id.length + 1))) await s.ink.del(k);
    }
    await s.notes.put(n);
    const seq = await appendFeed(s, { type, kind: 'note', id, parentId: n.folderId, revision: newMeta.revision }, device);
    return { revision: newMeta.revision, note: summary(n), warnings: [], seq };
  }));
}

/** A conflict copy must be committed before the 409 reaches the client. */
function unwrapConflict(res) {
  if (res?.conflict) throw res.conflict;
  return res;
}

async function getInk(id, pid) {
  assertId(id); assertPage(pid);
  return disk.read(NOTE_STORES, async (s) => {
    const n = await liveNote(s, id);
    const page = n.pages.pages.find((p) => p.id === pid);
    if (!page) throw notFound('page');
    const r = await s.ink.get(disk.inkKey(id, pid));
    return { version: 1, pageId: pid, revision: page.inkRevision | 0, strokes: r?.strokes || [] };
  });
}

async function saveInk(id, pid, inp, device) {
  assertId(id); assertPage(pid);
  if (!Number.isInteger(inp?.baseInkRevision)) throw new ServerError(400, 'bad_revision', 'Manca baseInkRevision.');
  const strokes = validateStrokes(inp.strokes);
  return unwrapConflict(await disk.write(NOTE_STORES, async (s) => {
    const n = await liveNote(s, id);
    const page = n.pages.pages.find((p) => p.id === pid);
    if (!page) throw notFound('page');
    const current = page.inkRevision | 0;
    if (inp.baseInkRevision !== current) {
      const copy = await conflictCopy(s, n, n.meta, n.pages, n.meta.revision | 0, device, { [pid]: strokes });
      return { conflict: new ServerError(409, 'conflict', 'Questa pagina è stata modificata da un altro dispositivo. La tua scrittura è salva in una copia di conflitto.',
        { copyId: copy.id, inkRevision: current, copyRevision: 1 }) };
    }
    page.inkRevision = current + 1;
    await s.ink.put({ key: disk.inkKey(id, pid), noteId: id, pageId: pid, revision: page.inkRevision, strokes });
    n.meta = { ...n.meta, modified: now(), lastDevice: device };
    touch(n);
    await s.notes.put(n);
    const seq = await appendFeed(s, { type: 'note.ink', kind: 'note', id, parentId: n.folderId, revision: page.inkRevision, pageId: pid }, device);
    return { inkRevision: page.inkRevision, seq };
  }));
}

async function moveNote(id, b, device) {
  assertId(id);
  if (!b || !('folderId' in b)) throw new ServerError(400, 'bad_request', 'Manca la cartella di destinazione.');
  const target = optId(b.folderId);
  return disk.write(NOTE_STORES, async (s) => {
    const n = await liveNote(s, id);
    if (n.folderId !== target) {
      await folderOf(s, target);
      n.folderId = target;
      touch(n);
      await s.notes.put(n);
      await appendFeed(s, { type: 'note.moved', kind: 'note', id, parentId: target, revision: n.meta.revision }, device);
    }
    return { note: summary(n), warnings: [], seq: await s.kv.get('seq') };
  });
}

// ------------------------------------------------------------------ derived files, attachments

async function putFile(id, path, blob, { derived = false, check } = {}) {
  return disk.write(NOTE_STORES, async (s) => {
    const n = await liveNote(s, id);
    check?.(n);
    await s.files.put({ key: disk.fileKey(id, path), noteId: id, path, blob, mtime: Date.now() });
    if (path === 'cover.png') n.coverStamp = Date.now().toString(36);
    touch(n, { derived });
    await s.notes.put(n);
    return n;
  });
}

async function savePreview(id, pid, body) {
  assertId(id); assertPage(pid);
  const text = typeof body === 'string' ? body : await body.text();
  if (!text || text.length > 8 * 1024 * 1024) throw new ServerError(413, 'too_large', 'Anteprima vuota o troppo grande.');
  if (!/^\s*(<svg|<\?xml)/.test(text.slice(0, 200))) throw new ServerError(400, 'bad_svg', "L'anteprima non è un SVG.");
  if (/<script|<foreignObject|<[^>]*\son[a-z]+\s*=|<[^>]*href\s*=\s*["']\s*javascript:/i.test(text)) throw new ServerError(400, 'bad_svg', "L'anteprima contiene elementi non ammessi.");
  await putFile(id, `previews/${pid}.svg`, new Blob([text], { type: 'image/svg+xml' }), {
    derived: true, check: (n) => { if (!n.pages.pages.some((p) => p.id === pid)) throw notFound('page'); },
  });
  // Previews of pages that no longer exist are derived files: safe to remove.
  await disk.write(['notes', 'files'], async (s) => {
    const n = await s.notes.get(id);
    const ids = new Set(n.pages.pages.map((p) => p.id));
    for (const f of await s.files.byNote(id)) {
      const m = f.path.match(/^previews\/(pg-[0-9a-f]{8})\.svg$/);
      if (m && !ids.has(m[1])) await s.files.del(f.key);
    }
  });
  return { ok: true };
}

async function saveCover(id, body) {
  assertId(id);
  const blob = body instanceof Blob ? body : new Blob([body]);
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (blob.size < 8 || blob.size > 4 * 1024 * 1024 || head[0] !== 0x89 || head[1] !== 0x50) throw new ServerError(400, 'bad_png', 'La copertina deve essere un PNG (massimo 4 MB).');
  const n = await putFile(id, 'cover.png', typed(blob, 'image/png'), { derived: true });
  return { ok: true, note: summary(n) };
}

async function getCover(id) {
  assertId(id);
  const f = await disk.read(['files'], (s) => s.files.get(disk.fileKey(id, 'cover.png')));
  if (!f) throw new ServerError(404, 'no_cover', 'Nessuna copertina.');
  return { __blob: f.blob };
}

async function savePdfText(id, file, inp) {
  assertId(id);
  if (!file || file.length > 120 || /[/\\<>:"|?*\x00-\x1F]|^\.|\.\./.test(file)) throw new ServerError(400, 'bad_name', 'Nome del file allegato non valido.');
  if (!Array.isArray(inp?.pages) || inp.pages.length > 5000) throw new ServerError(400, 'bad_pdftext', 'Testo del PDF non valido.');
  const fresh = inp.pages.map((p) => {
    if (!Number.isInteger(p?.pageIndex) || p.pageIndex < 0 || typeof p.text !== 'string') throw new ServerError(400, 'bad_pdftext', 'Testo del PDF non valido.');
    return { file, pageIndex: p.pageIndex, text: p.text.normalize('NFC').slice(0, 100000) };
  });
  const cur = await readPdfText(id);
  const pages = (cur?.pages || []).filter((p) => (p.file ?? cur.file) !== file).map((p) => ({ ...p, file: p.file ?? cur.file ?? null })).concat(fresh);
  const json = JSON.stringify({ version: 1, file: pages[0]?.file ?? file, pages });
  await putFile(id, 'pdftext.json', new Blob([json], { type: 'application/json' }));
  return { ok: true, pages: fresh.length };
}

async function readPdfText(id) {
  const f = await disk.read(['files'], (s) => s.files.get(disk.fileKey(id, 'pdftext.json')));
  if (!f) return null;
  try { return JSON.parse(await f.blob.text()); } catch { return null; }
}

async function addAttachment(id, body) {
  assertId(id);
  const blob = body?.blob;
  if (!(blob instanceof Blob)) throw new ServerError(400, 'no_file', 'Nessun file ricevuto.');
  if (blob.size > 400 * 1024 * 1024) throw new ServerError(413, 'too_large', 'File troppo grande (massimo 400 MB).');
  const wanted = attachmentName(body.name || blob.name || 'file');
  return disk.write(NOTE_STORES, async (s) => {
    const n = await liveNote(s, id);
    const taken = (await s.files.byNote(id)).filter((f) => f.path.startsWith('attachments/')).map((f) => f.path.slice(12));
    const name = unique(wanted, taken);
    const path = 'attachments/' + name;
    await s.files.put({ key: disk.fileKey(id, path), noteId: id, path, blob: typed(blob, mimeOf(name, blob)), mtime: Date.now() });
    touch(n);
    await s.notes.put(n);
    return { name, size: blob.size, mime: mimeOf(name, blob) };
  });
}

async function listAttachments(id) {
  assertId(id);
  const rows = await disk.read(['files'], (s) => s.files.byNote(id));
  return { items: rows.filter((f) => f.path.startsWith('attachments/')).map((f) => f.path.slice(12)) };
}

async function getAttachment(id, name) {
  assertId(id);
  const f = await disk.read(['files'], (s) => s.files.get(disk.fileKey(id, 'attachments/' + name)));
  if (!f) throw notFound('attachment');
  return { __blob: f.blob };
}

async function convertPptx(b) {
  const id = optId(b?.noteId);
  if (!id) throw new ServerError(400, 'bad_id', 'Identificativo non valido.');
  const { __blob: src } = await getAttachment(id, String(b.name || ''));
  if (!hooks.convertPptx) throw new ServerError(503, 'no_converter', 'Per trasformare le slide in pagine serve Google Drive: collegalo in Impostazioni, oppure salva la presentazione come PDF e inserisci il PDF.');
  const pdf = await hooks.convertPptx(src, b.name);
  return addAttachment(id, { blob: new Blob([pdf], { type: 'application/pdf' }), name: String(b.name).replace(/\.pptx?$/i, '') + '.pdf' });
}

// ------------------------------------------------------------------ folders

async function createFolder(b, device) {
  const parentId = optId(b?.parentId ?? null);
  if (typeof (b?.name ?? '') !== 'string') throw new ServerError(400, 'bad_request', 'Il campo name deve essere testo.');
  return disk.write(NOTE_STORES, async (s) => {
    await folderOf(s, parentId);
    const folders = await s.folders.all();
    const f = { id: uuid(), parentId, name: folderName(folders, parentId, b.name || ''), color: validColor(b.color ?? null), created: now(), chg: 1 };
    await s.folders.put(f);
    const seq = await appendFeed(s, { type: 'folder.created', kind: 'folder', id: f.id, parentId }, device);
    return { folder: folderPublic(f), warnings: [], seq };
  });
}

async function updateFolder(id, inp, device) {
  assertId(id);
  return disk.write(NOTE_STORES, async (s) => {
    const f = await folderOf(s, id);
    const folders = await s.folders.all();
    const events = new Set();
    let parentId = f.parentId;
    if ('parentId' in inp) {
      parentId = optId(inp.parentId);
      if (parentId !== null) {
        await folderOf(s, parentId);
        if (subtree(folders, id).includes(parentId)) throw new ServerError(400, 'bad_move', 'Non puoi spostare una cartella dentro sé stessa.');
      }
    }
    const moving = parentId !== f.parentId;
    const renaming = typeof inp.name === 'string' && segment(inp.name, 'Nuova cartella') !== f.name;
    if (moving || renaming) {
      f.name = folderName(folders, parentId, renaming ? inp.name : f.name, id);
      f.parentId = parentId;
      if (renaming) events.add('folder.renamed');
      if (moving) events.add('folder.moved');
    }
    if ('color' in inp) {
      const c = validColor(inp.color);
      if (c !== (f.color ?? null)) { f.color = c; events.add('folder.renamed'); }
    }
    if (events.size) {
      f.chg = (f.chg || 0) + 1;
      await s.folders.put(f);
      for (const type of events) await appendFeed(s, { type, kind: 'folder', id, parentId: f.parentId }, device);
    }
    return { folder: folderPublic(f), warnings: [], seq: await s.kv.get('seq') };
  });
}

async function countFolder(id) {
  assertId(id);
  return disk.read(['folders', 'notes'], async (s) => {
    await folderOf(s, id);
    const ids = new Set(subtree(await s.folders.all(), id));
    return { notes: (await s.notes.all()).filter((n) => !n.trash && ids.has(n.folderId)).length };
  });
}

async function trashInTx(s, n, folders, device) {
  n.trash = { deleted: now(), device, originalTitle: n.meta.title,
    originalFolders: chainOf(folders, n.folderId).map((f) => ({ id: f.id, name: f.name, color: f.color ?? null })) };
  touch(n);
  await s.notes.put(n);
  await appendFeed(s, { type: 'note.trashed', kind: 'note', id: n.id, parentId: n.folderId, revision: n.meta.revision }, device);
}

async function deleteFolder(id, device) {
  assertId(id);
  return disk.write(NOTE_STORES, async (s) => {
    await folderOf(s, id);
    const folders = await s.folders.all();
    const ids = subtree(folders, id);
    const set = new Set(ids);
    let trashed = 0;
    for (const n of await s.notes.all()) {
      if (!n.trash && set.has(n.folderId)) { await trashInTx(s, n, folders, device); trashed++; }
    }
    const tomb = (await s.kv.get('tombstones')) || [];
    for (const fid of ids.reverse()) {   // children first, so clients never see an orphan
      const f = folders.find((x) => x.id === fid);
      await s.folders.del(fid);
      tomb.push({ kind: 'folder', id: fid, time: now() });
      await appendFeed(s, { type: 'folder.deleted', kind: 'folder', id: fid, parentId: f?.parentId ?? null }, device);
    }
    await s.kv.put(tomb, 'tombstones');
    return { trashedNotes: trashed, leftovers: false, seq: await s.kv.get('seq') };
  });
}

// ------------------------------------------------------------------ trash

async function trashNote(id, device) {
  assertId(id);
  return disk.write(NOTE_STORES, async (s) => {
    const n = await liveNote(s, id);
    await trashInTx(s, n, await s.folders.all(), device);
    return { ok: true, seq: await s.kv.get('seq') };
  });
}

function trashItem(n, days) {
  const deleted = Date.parse(n.trash.deleted) || Date.now();
  const age = (Date.now() - deleted) / 86400000;
  const path = [...n.trash.originalFolders.map((f) => f.name), segment(n.trash.originalTitle || n.meta.title, UNTITLED)].join('/');
  return { trashId: n.id, id: n.id, title: n.meta.title, originalPath: path, deleted: n.trash.deleted, device: n.trash.device ?? null,
    daysLeft: Math.max(0, Math.ceil(days - age)), cover: n.meta.cover ?? null, expired: age >= days };
}

async function purgeInTx(s, n, device) {
  for (const k of await s.ink.keysByNote(n.id)) await s.ink.del(k);
  for (const k of await s.files.keysByNote(n.id)) await s.files.del(k);
  await s.notes.del(n.id);
  const tomb = (await s.kv.get('tombstones')) || [];
  tomb.push({ kind: 'note', id: n.id, time: now() });
  await s.kv.put(tomb, 'tombstones');
  await appendFeed(s, { type: 'note.purged', kind: 'note', id: n.id }, device);
}

/** Deletes trashed notes older than the retention period (lazily, on tree and trash requests). */
async function purgeExpired() {
  return disk.write(NOTE_STORES, async (s) => {
    const { trashRetentionDays: days } = await settingsOf(s);
    let n = 0;
    for (const note of await s.notes.all()) {
      if (note.trash && trashItem(note, days).expired) { await purgeInTx(s, note, 'Quadernone'); n++; }
    }
    return n;
  });
}

async function listTrash() {
  await purgeExpired();
  return disk.read(NOTE_STORES, async (s) => {
    const { trashRetentionDays: days } = await settingsOf(s);
    const items = (await s.notes.all()).filter((n) => n.trash).map((n) => trashItem(n, days))
      .sort((a, b) => String(b.deleted).localeCompare(String(a.deleted)));
    return { items, retentionDays: days };
  });
}

async function restore(id, device) {
  assertId(id);
  return disk.write(NOTE_STORES, async (s) => {
    const n = await s.notes.get(id);
    if (!n?.trash) throw notFound('trash');
    let folders = await s.folders.all();
    // Walk (and rebuild) the original folder chain: same id, else same name, else recreate.
    let parentId = null;
    for (const f of n.trash.originalFolders || []) {
      let match = folders.find((c) => c.parentId === parentId && c.id === f.id)
        || folders.find((c) => c.parentId === parentId && nameKey(c.name) === nameKey(f.name || ''));
      if (!match) {
        const fid = isUuid(f.id) && !folders.some((c) => c.id === f.id) ? f.id : uuid();
        match = { id: fid, parentId, name: folderName(folders, parentId, f.name || 'Cartella ripristinata'), color: f.color ?? null, created: now(), chg: 1 };
        await s.folders.put(match);
        folders = [...folders, match];
        await appendFeed(s, { type: 'folder.created', kind: 'folder', id: match.id, parentId }, device);
      }
      parentId = match.id;
    }
    n.folderId = parentId;
    n.trash = null;
    touch(n);
    await s.notes.put(n);
    await appendFeed(s, { type: 'note.restored', kind: 'note', id, parentId, revision: n.meta.revision }, device);
    return { note: summary(n), seq: await s.kv.get('seq') };
  });
}

async function deleteForever(id, device) {
  assertId(id);
  return disk.write(NOTE_STORES, async (s) => {
    const n = await s.notes.get(id);
    if (!n?.trash) throw notFound('trash');
    await purgeInTx(s, n, device);
    return { ok: true };
  });
}

async function emptyTrash(device) {
  return disk.write(NOTE_STORES, async (s) => {
    let deleted = 0;
    for (const n of await s.notes.all()) if (n.trash) { await purgeInTx(s, n, device); deleted++; }
    return { deleted };
  });
}

// ------------------------------------------------------------------ tree, changes, settings

async function tree() {
  await purgeExpired();
  return disk.read(NOTE_STORES, async (s) => {
    const notes = await s.notes.all();
    return {
      seq: (await s.kv.get('seq')) || 0,
      folders: (await s.folders.all()).map(folderPublic),
      notes: notes.filter((n) => !n.trash).map(summary),
      trashCount: notes.filter((n) => n.trash).length,
      settings: await settingsOf(s),
    };
  });
}

async function changes(query) {
  const since = query.get('since');
  if (!/^\d{1,12}$/.test(since || '')) throw new ServerError(400, 'bad_since', 'Parametro since non valido.');
  const n = Number(since);
  return disk.read(['feed', 'kv'], async (s) => {
    const cur = (await s.kv.get('seq')) || 0;
    if (n === cur) return { changes: [], seq: cur };
    if (n > cur) return { reset: true, seq: cur };
    const list = await s.feed.all(IDBKeyRange.lowerBound(n, true));
    if (list.length > 2000 || !list.length || list[0].seq > n + 1) return { reset: true, seq: cur };
    return { changes: list, seq: cur };
  });
}

async function saveSettings(b) {
  const days = b?.trashRetentionDays;
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new ServerError(400, 'bad_settings', 'Giorni del cestino non validi (1–3650).');
  return disk.write(['kv'], async (s) => {
    const cur = await settingsOf(s);
    const next = { ...cur, trashRetentionDays: days };
    await s.kv.put(next, 'settings');
    return next;
  });
}

// ------------------------------------------------------------------ search

async function search(query) {
  const q = (query.get('q') || '').trim().normalize('NFC');
  if (q.length < 1 || q.length > 200) throw new ServerError(400, 'bad_query', 'Scrivi cosa cercare.');
  const terms = q.split(/\s+/).map(fold).filter(Boolean);
  const folder = query.get('folder') || '';
  const onlyPdf = query.get('type') === 'pdf';
  const from = query.get('from') || null;
  const to = query.get('to') ? query.get('to') + 'T23:59:59.999Z' : null;
  const { notes, folders, texts } = await disk.read(['notes', 'folders', 'files'], async (s) => {
    const notes = (await s.notes.all()).filter((n) => !n.trash);
    const texts = new Map();
    for (const n of notes) {
      if (n.pages.pages.some((p) => p.pdf)) {
        const f = await s.files.get(disk.fileKey(n.id, 'pdftext.json'));
        if (f) texts.set(n.id, f.blob);
      }
    }
    return { notes, folders: await s.folders.all(), texts };
  });
  const allowed = folder && folder !== 'all' ? new Set(subtree(folders, folder)) : null;
  const results = [];
  for (const n of notes) {
    if (allowed && !allowed.has(n.folderId)) continue;
    const modified = n.meta.modified || '';
    if ((from && modified < from) || (to && modified > to)) continue;
    const pages = n.pages.pages;
    const hasPdf = pages.some((p) => p.pdf);
    if (onlyPdf && !hasPdf) continue;
    let pdf = null;
    if (texts.has(n.id)) { try { pdf = JSON.parse(await texts.get(n.id).text()); } catch { pdf = null; } }
    const sources = searchSources(n, pages, pdf);
    const all = sources.map((x) => x.fold).join('\n');
    if (!terms.every((t) => all.includes(t))) continue;
    let score = 0;
    const snippets = [];
    for (const src of sources) {
      for (const t of terms) score += countOf(src.fold, t) * (src.where === 'title' ? 20 : 1);
      if (snippets.length < 3) snippets.push(...snippetsOf(src, terms, 3 - snippets.length));
    }
    results.push({ id: n.id, title: n.meta.title, folderId: n.folderId, modified, hasPdf, score, snippets });
  }
  results.sort((a, b) => b.score - a.score || b.modified.localeCompare(a.modified));
  return { query: q, total: results.length, results: results.slice(0, 100) };
}

const countOf = (hay, t) => { let c = 0; for (let i = hay.indexOf(t); i !== -1; i = hay.indexOf(t, i + t.length)) c++; return c; };

function source(where, text, pageId, pageIndex) {
  // Folding can change lengths (rare): keep a map from folded to original positions.
  const chars = [...text];
  let f = '';
  const map = [];
  chars.forEach((ch, i) => { const fc = fold(ch); f += fc; for (let k = 0; k < fc.length; k++) map.push(i); });
  return { where, text: chars, fold: f, map, pageId, pageIndex };
}

function searchSources(n, pages, pdf) {
  const out = [source('title', n.meta.title, null, null)];
  const ids = pages.map((p) => p.id);
  let pageIndex = null;
  let buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) out.push(source('text', text, pageIndex !== null ? ids[pageIndex] ?? null : null, pageIndex));
    buf = [];
  };
  for (const line of String(n.markdown || '').split(/\r?\n/)) {
    const m = line.match(/^## Pagina (\d+)\s*$/);
    if (m) { flush(); pageIndex = Number(m[1]) - 1; continue; }
    if (/^# |^!\[Pagina/.test(line)) continue;
    buf.push(line.replace(/^\s*(?:[-*]\s+(?:\[[ x]\]\s+)?|\d+\.\s+|#{1,6}\s+)/, ''));
  }
  flush();
  if (Array.isArray(pdf?.pages)) {
    const where = new Map();
    pages.forEach((p, i) => { if (p.pdf) where.set(`${p.pdf.file}#${p.pdf.pageIndex}`, i); });
    for (const pp of pdf.pages) {
      const i = where.get(`${pp.file ?? pdf.file ?? ''}#${pp.pageIndex | 0}`);
      if (i === undefined || typeof pp.text !== 'string') continue;
      out.push(source('pdf', pp.text, ids[i], i));
    }
  }
  return out;
}

function snippetsOf(src, terms, max) {
  const out = [];
  const used = new Set();
  const len = src.text.length;
  const orig = (i) => src.map[i] ?? len;
  const clean = (arr) => arr.join('').replace(/\s+/g, ' ');
  for (const t of terms) {
    let pos = 0;
    for (let at = src.fold.indexOf(t, pos); out.length < max && at !== -1; at = src.fold.indexOf(t, pos)) {
      pos = at + t.length;
      const a = orig(at);
      const b = orig(at + t.length - 1) + 1;
      const bucket = Math.floor(a / 120);
      if (used.has(bucket)) continue;
      used.add(bucket);
      const start = Math.max(0, a - 60);
      const end = Math.min(len, b + 60);
      out.push({ where: src.where, pageId: src.pageId, pageIndex: src.pageIndex,
        before: (start > 0 ? '…' : '') + clean(src.text.slice(start, a)).trimStart(),
        match: clean(src.text.slice(a, b)),
        after: clean(src.text.slice(b, end)).trimEnd() + (end < len ? '…' : '') });
    }
  }
  return out;
}

// ------------------------------------------------------------------ conflicts

async function loadFull(s, id) {
  const n = await s.notes.get(id);
  if (!n || n.trash) return null;
  const ink = {};
  const rows = new Map((await s.ink.byNote(id)).map((r) => [r.pageId, r.strokes]));
  for (const p of n.pages.pages) ink[p.id] = rows.get(p.id) || [];
  return { n, meta: n.meta, pages: n.pages, ink };
}

function analyse(copy, orig) {
  const count = (x) => ({ pages: x.pages.pages.length, strokes: Object.values(x.ink).reduce((a, v) => a + v.length, 0) });
  const stats = { copy: count(copy), original: orig ? count(orig) : null };
  if (!orig) return [{ ...stats, onlyCopy: null, onlyOriginal: null }, 'both'];
  const strokeIds = (x) => new Set(Object.values(x.ink).flat().map((st) => st.id));
  const objHash = (x) => new Map(x.pages.pages.flatMap((p) => (p.objects || []).map((o) => [o.id, JSON.stringify(o)])));
  const sc = strokeIds(copy), so = strokeIds(orig);
  const pc = new Set(copy.pages.pages.map((p) => p.id)), po = new Set(orig.pages.pages.map((p) => p.id));
  const oc = objHash(copy), oo = objHash(orig);
  const minus = (a, b) => [...a].filter((x) => !b.has(x)).length;
  const diffObj = (a, b) => [...a].filter(([id, h]) => b.get(id) !== h).length;
  const onlyCopy = { strokes: minus(sc, so), pages: minus(pc, po), objects: diffObj(oc, oo) };
  const onlyOriginal = { strokes: minus(so, sc), pages: minus(po, pc), objects: diffObj(oo, oc) };
  const sum = (d) => d.strokes + d.pages + d.objects;
  const action = !sum(onlyCopy) ? 'original' : !sum(onlyOriginal) ? 'copy' : 'merge';
  return [{ ...stats, onlyCopy, onlyOriginal }, action];
}

function reasonOf(action, st) {
  const what = (d) => {
    if (!d) return '';
    const parts = [];
    if (d.strokes) parts.push(d.strokes + (d.strokes === 1 ? ' tratto' : ' tratti'));
    if (d.pages) parts.push(d.pages + (d.pages === 1 ? ' pagina' : ' pagine'));
    if (d.objects) parts.push(d.objects + (d.objects === 1 ? ' elemento (testo/immagine/forma)' : ' elementi (testo/immagini/forme)'));
    return parts.join(', ');
  };
  const o = st.onlyOriginal, c = st.onlyCopy;
  if (action === 'both') return "La nota originale non esiste più: la copia è l'unica versione rimasta.";
  if (action === 'original') return o && (o.strokes + o.pages + o.objects) ? `La copia non aggiunge niente: l'originale ha in più ${what(o)}.` : 'Le due versioni sono identiche: la copia non serve.';
  if (action === 'copy') return `La copia contiene tutto l'originale e in più ${what(c)}.`;
  return `Ognuna ha qualcosa che l'altra non ha: solo nella copia ${what(c)}, solo nell'originale ${what(o)}. Unendole tieni tutto (se su un dispositivo avevi cancellato qualcosa, potrebbe ricomparire).`;
}

async function listConflicts() {
  return disk.read(NOTE_STORES, async (s) => {
    const out = [];
    for (const n of await s.notes.all()) {
      const of = n.meta.conflictOf;
      if (n.trash || !of) continue;
      const copy = await loadFull(s, n.id);
      const orig = isUuid(of.id) ? await loadFull(s, of.id) : null;
      const [stats, action] = analyse(copy, orig);
      out.push({ copyId: n.id, copyTitle: n.meta.title, originalId: orig ? of.id : null, originalTitle: orig ? orig.meta.title : null,
        folderId: n.folderId, device: of.device ?? null, time: of.time ?? null, stats, suggestion: action, reason: reasonOf(action, stats), reasonByAi: false });
    }
    return { conflicts: out };
  });
}

async function resolveConflict(copyId, action, device) {
  assertId(copyId);
  if (!['original', 'copy', 'merge', 'both'].includes(action)) throw new ServerError(400, 'bad_action', 'Azione non valida.');
  return disk.write(NOTE_STORES, async (s) => {
    const copy = await loadFull(s, copyId);
    const of = copy?.meta.conflictOf;
    if (!copy || !of) throw new ServerError(404, 'conflict_not_found', 'Questo conflitto è già stato risolto.');
    const orig = isUuid(of.id) ? await loadFull(s, of.id) : null;
    if (!orig && (action === 'copy' || action === 'merge')) throw new ServerError(409, 'original_missing', 'La nota originale non esiste più: puoi solo tenere la copia o eliminarla.');
    const folders = await s.folders.all();
    let resultId = orig ? of.id : null;
    let changedPages = [];
    if (action === 'original') {
      await trashInTx(s, copy.n, folders, device);
    } else if (action === 'both') {
      copy.n.meta = { ...copy.meta, conflictOf: null, revision: (copy.meta.revision | 0) + 1, modified: now(), lastDevice: device };
      touch(copy.n);
      await s.notes.put(copy.n);
      await appendFeed(s, { type: 'note.updated', kind: 'note', id: copyId, parentId: copy.n.folderId, revision: copy.n.meta.revision }, device);
      resultId = copyId;
    } else {
      // Before replacing the original, keep it in the trash as a backup.
      const backup = await conflictCopy(s, orig.n, orig.meta, orig.pages, orig.meta.revision | 0, device, {}, { title: orig.meta.title + ' (prima della risoluzione)' });
      backup.meta.conflictOf = null;
      await trashInTx(s, backup, folders, device);
      changedPages = action === 'copy' ? await takeCopy(s, orig, copy, device) : await merge(s, orig, copy, device);
      await trashInTx(s, copy.n, folders, device);
    }
    const res = resultId ? await s.notes.get(resultId) : null;
    return { note: res ? summary(res) : null, changedPages, seq: await s.kv.get('seq') };
  });
}

async function writeResolved(s, orig, pages, ink, metaFrom, device) {
  const n = orig.n;
  for (const k of await s.ink.keysByNote(n.id)) await s.ink.del(k);
  for (const p of pages.pages) await s.ink.put({ key: disk.inkKey(n.id, p.id), noteId: n.id, pageId: p.id, revision: p.inkRevision, strokes: ink[p.id] || [] });
  n.pages = pages;
  n.meta = { ...n.meta, ...(metaFrom ? { favorite: metaFrom.favorite, cover: metaFrom.cover } : {}),
    revision: Math.max(n.meta.revision | 0, 0) + 1, modified: now(), lastDevice: device };
  writeText(n, n.meta.title, pages);
  touch(n);
  touch(n, { derived: true });
  await s.notes.put(n);
  await appendFeed(s, { type: 'note.updated', kind: 'note', id: n.id, parentId: n.folderId, revision: n.meta.revision }, device);
}

async function copyMissingFiles(s, fromId, toId, filter) {
  const have = new Set((await s.files.byNote(toId)).map((f) => f.path));
  for (const f of await s.files.byNote(fromId)) {
    if (filter(f.path) && (!have.has(f.path) || !f.path.startsWith('attachments/'))) {
      await s.files.put({ ...f, key: disk.fileKey(toId, f.path), noteId: toId });
    }
  }
}

async function takeCopy(s, orig, copy, device) {
  const pages = structuredClone(copy.pages);
  const oldRev = new Map(orig.pages.pages.map((p) => [p.id, p.inkRevision | 0]));
  for (const p of pages.pages) p.inkRevision = Math.max(oldRev.get(p.id) ?? 0, p.inkRevision | 0) + 1;
  await copyMissingFiles(s, copy.n.id, orig.n.id, (path) => path.startsWith('attachments/') || path.startsWith('previews/') || path === 'cover.png' || path === 'pdftext.json');
  orig.n.coverStamp = copy.n.coverStamp || orig.n.coverStamp;
  await writeResolved(s, orig, pages, copy.ink, copy.meta, device);
  return [];
}

async function merge(s, orig, copy, device) {
  const copyNewer = String(copy.meta.modified || '') > String(orig.meta.modified || '');
  const op = new Map(orig.pages.pages.map((p) => [p.id, p]));
  const cp = new Map(copy.pages.pages.map((p) => [p.id, p]));
  const order = [...op.keys()];
  let prev = null;
  for (const pid of cp.keys()) {
    if (!op.has(pid)) order.splice(prev === null ? 0 : order.indexOf(prev) + 1, 0, pid);
    prev = pid;
  }
  const result = { ...structuredClone(orig.pages), pages: [] };
  const ink = {};
  const changed = [];
  for (const pid of order) {
    const o = op.get(pid), c = cp.get(pid);
    let page;
    if (!o) { page = structuredClone(c); ink[pid] = copy.ink[pid] || []; changed.push(pid); }
    else if (!c) { page = structuredClone(o); ink[pid] = orig.ink[pid] || []; }
    else {
      page = structuredClone(copyNewer ? { ...o, ...c, id: o.id, objects: o.objects, inkRevision: o.inkRevision } : o);
      const objs = new Map((o.objects || []).map((ob) => [ob.id, ob]));
      let pageChanged = false;
      for (const ob of c.objects || []) {
        if (!objs.has(ob.id) || (copyNewer && JSON.stringify(objs.get(ob.id)) !== JSON.stringify(ob))) { objs.set(ob.id, ob); pageChanged = true; }
      }
      page.objects = structuredClone([...objs.values()]);
      const strokes = [...(orig.ink[pid] || [])];
      const have = new Set(strokes.map((st) => st.id));
      for (const st of copy.ink[pid] || []) if (!have.has(st.id)) { strokes.push(st); pageChanged = true; }
      ink[pid] = strokes;
      if (pageChanged) changed.push(pid);
    }
    page.inkRevision = Math.max(o?.inkRevision | 0, c?.inkRevision | 0) + 1;
    result.pages.push(page);
  }
  await copyMissingFiles(s, copy.n.id, orig.n.id, (path) => path.startsWith('attachments/') || (path.startsWith('previews/') && !op.has(path.slice(9, -4))));
  await writeResolved(s, orig, result, ink, null, device);
  return changed.filter((pid) => op.has(pid));
}

// ------------------------------------------------------------------ diagnostics

async function diag(b) {
  return disk.write(['kv'], async (s) => {
    const list = (await s.kv.get('diag')) || [];
    list.push({ time: now(), ...b });
    await s.kv.put(list.slice(-200), 'diag');
    return { ok: true, stored: true };
  });
}

// ------------------------------------------------------------------ routing

const ID = '([0-9a-f-]{36})';
const PG = '(pg-[0-9a-f]{8})';
const routes = [
  ['GET', '/health', () => ({ ok: true, local: true, version: APP_VERSION })],
  ['GET', '/tree', () => tree()],
  ['POST', '/folders', (m, b, d) => createFolder(b, d)],
  ['PATCH', `/folders/${ID}`, (m, b, d) => updateFolder(m[1], b || {}, d)],
  ['GET', `/folders/${ID}/count`, (m) => countFolder(m[1])],
  ['DELETE', `/folders/${ID}`, (m, b, d) => deleteFolder(m[1], d)],
  ['POST', '/notes', (m, b, d) => createNote(b || {}, d)],
  ['GET', `/notes/${ID}`, (m, b, d, q) => getNote(m[1], q.get('ink') === '1')],
  ['PUT', `/notes/${ID}`, (m, b, d) => saveNote(m[1], b, d)],
  ['PUT', `/notes/${ID}/previews/${PG}`, (m, b) => savePreview(m[1], m[2], b)],
  ['PUT', `/notes/${ID}/cover`, (m, b) => saveCover(m[1], b)],
  ['GET', `/notes/${ID}/cover`, (m) => getCover(m[1])],
  ['PUT', `/notes/${ID}/pdftext/([^/]+)`, (m, b) => savePdfText(m[1], decodeURIComponent(m[2]), b)],
  ['POST', `/notes/${ID}/attachments`, (m, b) => addAttachment(m[1], b)],
  ['GET', `/notes/${ID}/attachments`, (m) => listAttachments(m[1])],
  ['GET', `/notes/${ID}/attachments/([^/]+)`, (m) => getAttachment(m[1], decodeURIComponent(m[2]))],
  ['POST', '/convert/pptx', (m, b) => convertPptx(b)],
  ['GET', '/search', (m, b, d, q) => search(q)],
  ['GET', `/notes/${ID}/ink/${PG}`, (m) => getInk(m[1], m[2])],
  ['PUT', `/notes/${ID}/ink/${PG}`, (m, b, d) => saveInk(m[1], m[2], b, d)],
  ['POST', '/diag', (m, b) => diag(b)],
  ['PATCH', `/notes/${ID}/move`, (m, b, d) => moveNote(m[1], b, d)],
  ['DELETE', `/notes/${ID}`, (m, b, d) => trashNote(m[1], d)],
  ['GET', '/trash', () => listTrash()],
  ['POST', `/trash/${ID}/restore`, (m, b, d) => restore(m[1], d)],
  ['DELETE', `/trash/${ID}`, (m, b, d) => deleteForever(m[1], d)],
  ['DELETE', '/trash', (m, b, d) => emptyTrash(d)],
  ['GET', '/suggestions', () => ({ suggestions: [] })],
  ['GET', '/conflicts', () => listConflicts()],
  ['POST', `/conflicts/${ID}/resolve`, (m, b, d) => resolveConflict(m[1], b?.action, d)],
  ['GET', '/changes', (m, b, d, q) => changes(q)],
  ['GET', '/settings', () => disk.read(['kv'], settingsOf)],
  ['PUT', '/settings', (m, b) => saveSettings(b)],
].map(([method, pattern, fn]) => [method, new RegExp(`^${pattern}$`), fn]);

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Answers one API request. path: '/notes/<id>?ink=1' (without '/api').
 * Resolves to the JSON-like result, or { __blob } for files; throws ServerError.
 */
export async function handle(method, path, body, { device = 'Questo dispositivo' } = {}) {
  const [pathname, qs = ''] = path.split('?');
  const query = new URLSearchParams(qs);
  let allowed = false;
  for (const [m, re, fn] of routes) {
    const match = pathname.match(re);
    if (!match) continue;
    if (m !== method) { allowed = true; continue; }
    try {
      return await fn(match, body, device, query);
    } finally {
      // Also after a 409: the conflict copy is a change other tabs and the Drive sync must see.
      if (WRITES.has(method) && pathname !== '/diag') disk.changed({ method, path: pathname });
    }
  }
  throw allowed ? new ServerError(405, 'method_not_allowed', 'Metodo non permesso.') : new ServerError(404, 'not_found', 'Indirizzo non trovato.');
}
