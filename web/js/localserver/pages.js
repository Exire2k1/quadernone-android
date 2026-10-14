// pages.json: defaults, validation and page creation (port of Pages.php).
// Every new allowed value (e.g. a paper colour) must be added here AND in js/page/paper.js.
import { ApiError, hex, isArr, isNum, isInt, isPlainObject } from './util.js';

const PRESETS = { A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4] };
const BG_TYPES = ['blank', 'lined', 'grid', 'dotted'];
const PAPER = ['white', 'ivory', 'sand', 'grey', 'dark'];
const MAX_PAGES = 5000;

function bad(what) {
  throw new ApiError(400, 'bad_pages', `Dati delle pagine non validi (${what}).`);
}

export function defaultSettings() {
  return {
    size: { preset: 'A4', widthMm: 210, heightMm: 297 },
    orientation: 'portrait',
    background: { type: 'lined', spacingMm: 8, lineColor: '#A9BCD6', paperColor: 'white' },
  };
}

export const newPageId = () => 'pg-' + hex(4);

export function newPage(defaults) {
  return {
    id: newPageId(),
    size: structuredClone(defaults.size),
    orientation: defaults.orientation,
    background: structuredClone(defaults.background),
    pdf: null,
    inkRevision: 0,
    objects: [],
  };
}

/** pages.json for a new note with one empty page. */
export function newDocument(defaultsIn) {
  const defaults = defaultsIn === null || defaultsIn === undefined ? defaultSettings() : settings(defaultsIn, 'pageDefaults');
  return { version: 1, defaults, pages: [newPage(defaults)] };
}

/** Validates size + orientation + background and resolves widthMm/heightMm. */
export function settings(input, where) {
  if (!isArr(input)) bad(`${where} mancante`);
  const orientation = input.orientation ?? 'portrait';
  if (!['portrait', 'landscape'].includes(orientation)) bad(`${where}.orientation`);
  return {
    size: size(input.size ?? null, orientation, where),
    orientation,
    background: background(input.background ?? null, where),
  };
}

const round2 = (v) => Math.round(v * 100) / 100;

function size(s, orientation, where) {
  if (!isArr(s) || s.preset === undefined || s.preset === null) bad(`${where}.size`);
  const p = s.preset;
  if (typeof p === 'string' && Object.hasOwn(PRESETS, p)) {
    let [w, h] = PRESETS[p];
    if (orientation === 'landscape') [w, h] = [h, w];
    return { preset: p, widthMm: w, heightMm: h };
  }
  if (!['custom', 'infinite', 'pdf'].includes(p)) bad(`${where}.size.preset`);
  const w = s.widthMm ?? (p === 'infinite' ? 210 : null);
  const h = s.heightMm ?? (p === 'infinite' ? 297 : null);
  if (!isNum(w) || !isNum(h) || w < 20 || w > 5000 || h < 20 || h > (p === 'infinite' ? 100000 : 5000)) {
    bad(`${where}.size (misure in mm)`);
  }
  return { preset: p, widthMm: round2(w), heightMm: round2(h) };
}

function background(b, where) {
  if (!isArr(b) || !BG_TYPES.includes(b.type)) bad(`${where}.background.type`);
  const spacing = b.spacingMm ?? 8;
  if (!isNum(spacing) || spacing < 2 || spacing > 50) bad(`${where}.background.spacingMm`);
  const line = b.lineColor ?? '#A9BCD6';
  if (typeof line !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(line)) bad(`${where}.background.lineColor`);
  const paper = b.paperColor ?? 'white';
  if (!PAPER.includes(paper)) bad(`${where}.background.paperColor`);
  return { type: b.type, spacingMm: spacing, lineColor: line.toUpperCase(), paperColor: paper };
}

/**
 * Validates a full pages.json sent by the client. inkRevision is owned by the server:
 * it is copied from current (0 for new pages), never taken from the client.
 */
export function validateDocument(input, current) {
  if (!isArr(input) || !Array.isArray(input.pages)) bad('pages');
  const n = input.pages.length;
  if (n < 1 || n > MAX_PAGES) bad('pages (numero di pagine)');
  const inkRev = new Map();
  for (const p of current?.pages || []) inkRev.set(p.id, Number(p.inkRevision ?? 0) | 0);
  const seen = new Set();
  const pages = input.pages.map((p, i) => {
    const where = `pages[${i}]`;
    if (!isPlainObject(p) || typeof p.id !== 'string' || !/^pg-[0-9a-f]{8}$/.test(p.id)) bad(`${where}.id`);
    if (seen.has(p.id)) bad(`${where}.id duplicato`);
    seen.add(p.id);
    const page = { id: p.id, ...settings(p, where) };
    page.pdf = pdfRef(p.pdf ?? null, where);
    page.inkRevision = inkRev.get(p.id) ?? 0;
    page.objects = objects(p.objects ?? [], where);
    return page;
  });
  return { version: 1, defaults: settings(input.defaults ?? null, 'defaults'), pages };
}

function pdfRef(pdf, where) {
  if (pdf === null) return null;
  if (!isArr(pdf) || typeof pdf.file !== 'string' || !isInt(pdf.pageIndex) || pdf.pageIndex < 0 || /[/\\]|^\./.test(pdf.file)) {
    bad(`${where}.pdf`);
  }
  return { file: pdf.file, pageIndex: pdf.pageIndex };
}

/** Checks the fields every page object shares; type-specific fields pass through. */
function objects(objs, where) {
  if (!Array.isArray(objs)) bad(`${where}.objects`);
  objs.forEach((o, j) => {
    const w = `${where}.objects[${j}]`;
    if (!isPlainObject(o) || typeof o.id !== 'string' || !/^ob-[0-9a-f]{8}$/.test(o.id)
      || typeof o.type !== 'string' || !/^[a-z]{1,20}$/.test(o.type)) bad(w);
    for (const k of ['x', 'y', 'w', 'h', 'rotation', 'z']) {
      if (o[k] !== undefined && o[k] !== null && !isNum(o[k])) bad(`${w}.${k}`);
    }
  });
  return objs;
}
