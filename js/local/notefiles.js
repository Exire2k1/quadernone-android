// pages.json validation and note.md, as on the server (lib/Pages.php, lib/NoteMarkdown.php).
import { newPageId } from './names.js';
import { ServerError } from './errors.js';

const PRESETS = { A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4] };
const BG_TYPES = ['blank', 'lined', 'grid', 'dotted'];
const PAPER = ['white', 'ivory', 'sand', 'grey', 'dark'];
const MAX_PAGES = 5000;

const bad = (what) => { throw new ServerError(400, 'bad_pages', `Dati delle pagine non validi (${what}).`); };
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const HEX = /^#[0-9A-Fa-f]{6}$/;

export function defaultSettings() {
  return {
    size: { preset: 'A4', widthMm: 210, heightMm: 297 },
    orientation: 'portrait',
    background: { type: 'lined', spacingMm: 8, lineColor: '#A9BCD6', paperColor: 'white' },
  };
}

export function newPage(defaults) {
  return { id: newPageId(), size: structuredClone(defaults.size), orientation: defaults.orientation,
    background: structuredClone(defaults.background), pdf: null, inkRevision: 0, objects: [] };
}

export function newDocument(defaultsIn) {
  const defaults = defaultsIn == null ? defaultSettings() : settings(defaultsIn, 'pageDefaults');
  return { version: 1, defaults, pages: [newPage(defaults)] };
}

/** Validates size + orientation + background and resolves widthMm/heightMm. */
export function settings(inp, where) {
  if (!inp || typeof inp !== 'object') bad(`${where} mancante`);
  const orientation = inp.orientation ?? 'portrait';
  if (!['portrait', 'landscape'].includes(orientation)) bad(`${where}.orientation`);
  return { size: size(inp.size, orientation, where), orientation, background: background(inp.background, where) };
}

function size(s, orientation, where) {
  if (!s || typeof s !== 'object' || !s.preset) bad(`${where}.size`);
  const pr = s.preset;
  if (PRESETS[pr]) {
    let [w, h] = PRESETS[pr];
    if (orientation === 'landscape') [w, h] = [h, w];
    return { preset: pr, widthMm: w, heightMm: h };
  }
  if (!['custom', 'infinite', 'pdf'].includes(pr)) bad(`${where}.size.preset`);
  const w = s.widthMm ?? (pr === 'infinite' ? 210 : null);
  const h = s.heightMm ?? (pr === 'infinite' ? 297 : null);
  if (!num(w) || !num(h) || w < 20 || w > 5000 || h < 20 || h > (pr === 'infinite' ? 100000 : 5000)) bad(`${where}.size (misure in mm)`);
  return { preset: pr, widthMm: Math.round(w * 100) / 100, heightMm: Math.round(h * 100) / 100 };
}

function background(b, where) {
  if (!b || typeof b !== 'object' || !BG_TYPES.includes(b.type)) bad(`${where}.background.type`);
  const spacing = b.spacingMm ?? 8;
  if (!num(spacing) || spacing < 2 || spacing > 50) bad(`${where}.background.spacingMm`);
  const line = b.lineColor ?? '#A9BCD6';
  if (typeof line !== 'string' || !HEX.test(line)) bad(`${where}.background.lineColor`);
  const paper = b.paperColor ?? 'white';
  if (!PAPER.includes(paper)) bad(`${where}.background.paperColor`);
  return { type: b.type, spacingMm: spacing, lineColor: line.toUpperCase(), paperColor: paper };
}

/** Validates a full pages.json from the client. inkRevision is owned by the server. */
export function validateDocument(inp, current) {
  if (!inp || !Array.isArray(inp.pages)) bad('pages');
  const n = inp.pages.length;
  if (n < 1 || n > MAX_PAGES) bad('pages (numero di pagine)');
  const inkRev = new Map((current?.pages || []).map((p) => [p.id, p.inkRevision | 0]));
  const seen = new Set();
  const pages = inp.pages.map((p, i) => {
    const where = `pages[${i}]`;
    if (!p || typeof p.id !== 'string' || !/^pg-[0-9a-f]{8}$/.test(p.id)) bad(`${where}.id`);
    if (seen.has(p.id)) bad(`${where}.id duplicato`);
    seen.add(p.id);
    return { id: p.id, ...settings(p, where), pdf: pdfRef(p.pdf, where), inkRevision: inkRev.get(p.id) ?? 0, objects: objects(p.objects ?? [], where) };
  });
  return { version: 1, defaults: settings(inp.defaults, 'defaults'), pages };
}

function pdfRef(pdf, where) {
  if (pdf == null) return null;
  if (typeof pdf.file !== 'string' || !Number.isInteger(pdf.pageIndex) || pdf.pageIndex < 0 || /[/\\]|^\./.test(pdf.file)) bad(`${where}.pdf`);
  return { file: pdf.file, pageIndex: pdf.pageIndex };
}

function objects(objs, where) {
  if (!Array.isArray(objs)) bad(`${where}.objects`);
  objs.forEach((o, j) => {
    const w = `${where}.objects[${j}]`;
    if (!o || typeof o.id !== 'string' || !/^ob-[0-9a-f]{8}$/.test(o.id) || typeof o.type !== 'string' || !/^[a-z]{1,20}$/.test(o.type)) bad(w);
    for (const k of ['x', 'y', 'w', 'h', 'rotation', 'z']) if (o[k] !== undefined && !num(o[k])) bad(`${w}.${k}`);
  });
  return objs;
}

// ------------------------------------------------------------------ note.md

const escapeInline = (s) => String(s).replace(/[\r\n]/g, ' ').replace(/([\\`*_~[\]])/g, '\\$1');

function runs(list) {
  let s = '';
  for (const r of list || []) {
    let t = escapeInline(r.text ?? '');
    if (!t) continue;
    if (r.s) t = `~~${t}~~`;
    if (r.i) t = `*${t}*`;
    if (r.b) t = `**${t}**`;
    s += t;
  }
  return s;
}

function blocks(list) {
  const lines = [];
  let olN = 0;
  for (const b of list || []) {
    const text = runs(b.runs);
    const t = b.t ?? 'p';
    olN = t === 'ol' ? olN + 1 : 0;
    lines.push({ h1: `### ${text}`, h2: `#### ${text}`, h3: `##### ${text}`, ul: `- ${text}`, ol: `${olN}. ${text}`,
      check: `- [${b.done ? 'x' : ' '}] ${text}` }[t] ?? text);
  }
  return lines.join('\n').trim();
}

/** note.md: the title, one "## Pagina N" section per page with its preview and text boxes. */
export function buildMarkdown(title, pages) {
  const out = ['# ' + String(title).replace(/[\r\n]/g, ' '), ''];
  (pages?.pages || []).forEach((page, i) => {
    const n = i + 1;
    out.push(`## Pagina ${n}`, '', `![Pagina ${n}](previews/${page.id}.svg)`, '');
    const texts = (page.objects || []).filter((o) => o.type === 'text')
      .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
    for (const o of texts) {
      const md = blocks(o.blocks);
      if (md) out.push(md, '');
    }
  });
  return out.join('\n');
}

/** First line of real text, for the Library list view. */
export function snippetOf(md) {
  for (const raw of String(md || '').split('\n').slice(0, 400)) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line.startsWith('![')) continue;
    return [...line.replace(/^(- \[[ x]\] |- |\d+\. )/, '').replace(/\*\*|~~|\\/g, '')].slice(0, 140).join('');
  }
  return '';
}
