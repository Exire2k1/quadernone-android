// GET /api/search?q=&folder=&type=&from=&to= (port of Search.php).
//
// Searches note titles, the text of text boxes (note.md) and PDF text (pdftext.json).
// Matching ignores case and accents ("perche" finds "perché"); every word of the query
// must appear in the note. Results carry up to 3 snippets each, with the page to open.
import { ApiError, assertId, nfc, cpLen } from './util.js';
import { Fs } from './fs.js';

const MAX_RESULTS = 100;
const SNIPPETS = 3;
const CONTEXT = 60;   // characters around a match

/** Lower case without accents. */
export const fold = (s) => s.normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase();

export async function run(ctx, query) {
  const q = nfc(String(query.q ?? '')).trim();
  if (cpLen(q) < 1 || cpLen(q) > 200) throw new ApiError(400, 'bad_query', 'Scrivi cosa cercare.');
  const terms = q.split(/\s+/u).map(fold).filter((t) => t !== '');
  const folder = query.folder ?? '';
  const onlyPdf = (query.type ?? '') === 'pdf';
  const from = date(query.from ?? '', false);
  const to = date(query.to ?? '', true);

  const { fs, index } = ctx;
  await index.scan();
  const c = await index.load();
  let allowed = null;
  if (typeof folder === 'string' && folder !== '' && folder !== 'all') {
    assertId(folder);
    allowed = new Set([folder, ...(await index.subtreeFolderIds(folder))]);
  }

  const results = [];
  for (const [id, e] of Object.entries(c.notes)) {
    if (allowed !== null && !allowed.has(e.parentId ?? '')) continue;
    const meta = e.meta || {};
    const modified = String(meta.modified ?? '');
    if ((from !== null && modified < from) || (to !== null && modified > to)) continue;
    const pages = (await fs.readJson(`${e.path}/pages.json`))?.pages ?? [];
    const hasPdf = pages.some((p) => p?.pdf);
    if (onlyPdf && !hasPdf) continue;
    const sources = await collect(fs, e.path, String(meta.title ?? ''), pages);
    // Every term somewhere in the note.
    const all = sources.map((s) => s.fold).join('\n');
    if (!terms.every((t) => all.includes(t))) continue;
    const snippets = [];
    let score = 0;
    for (const s of sources) {
      for (const t of terms) score += (s.fold.split(t).length - 1) * (s.where === 'title' ? 20 : 1);
      if (snippets.length < SNIPPETS) snippets.push(...snippetsOf(s, terms, SNIPPETS - snippets.length));
    }
    results.push({
      id, title: String(meta.title ?? Fs.basename(e.path)), folderId: e.parentId, modified, hasPdf, score, snippets,
    });
  }
  results.sort((a, b) => b.score - a.score || (b.modified < a.modified ? -1 : b.modified > a.modified ? 1 : 0));
  return { query: q, total: results.length, results: results.slice(0, MAX_RESULTS) };
}

/** Searchable texts of a note, each with where it comes from and the page to open. */
async function collect(fs, rel, title, pages) {
  const out = [source('title', title, null, null)];
  const pageIds = pages.map((p) => p.id);
  // note.md: "## Pagina N" headings say which page the text belongs to.
  const md = await fs.readText(`${rel}/note.md`);
  if (typeof md === 'string') {
    let pageIndex = null;
    let buf = [];
    const flush = () => {
      const text = buf.join('\n').trim();
      if (text !== '') out.push(source('text', text, pageIndex !== null ? (pageIds[pageIndex] ?? null) : null, pageIndex));
      buf = [];
    };
    for (const line of md.split(/\r\n|\r|\n/u)) {
      const m = line.match(/^## Pagina (\d+)\s*$/u);
      if (m) { flush(); pageIndex = Number(m[1]) - 1; continue; }
      if (/^# |^!\[Pagina/u.test(line)) continue;   // title (already searched) and preview links
      buf.push(line.replace(/^\s*(?:[-*]\s+(?:\[[ x]\]\s+)?|\d+\.\s+|#{1,6}\s+)/u, ''));
    }
    flush();
  }
  // pdftext.json: map each PDF page to the note page that shows it.
  const pdf = await fs.readJson(`${rel}/pdftext.json`);
  if (Array.isArray(pdf?.pages)) {
    const where = new Map();
    pages.forEach((p, i) => { if (p?.pdf) where.set(`${p.pdf.file}#${p.pdf.pageIndex}`, i); });
    for (const pp of pdf.pages) {
      const file = String(pp?.file ?? pdf.file ?? '');
      const key = `${file}#${Number.isFinite(Number(pp?.pageIndex)) ? Math.trunc(Number(pp.pageIndex)) : -1}`;
      if (!where.has(key) || typeof pp.text !== 'string') continue;   // page removed from the note
      const i = where.get(key);
      out.push(source('pdf', pp.text, pageIds[i], i));
    }
  }
  return out;
}

/**
 * A searchable text. chars/foldChars are arrays of code points; map[i] is the index in
 * chars of fold position i (null when folding kept one character per character).
 */
function source(where, text, pageId, pageIndex) {
  const chars = [...text];
  let f = fold(text);
  let map = null;
  if ([...f].length !== chars.length) {
    map = [];
    f = '';
    chars.forEach((ch, i) => {
      const fc = [...fold(ch)];
      f += fc.join('');
      for (let k = 0; k < fc.length; k++) map.push(i);
    });
  }
  return { where, text, chars, fold: f, foldChars: [...f], map, pageId, pageIndex };
}

function indexOfCp(hay, needle, from) {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

function snippetsOf(s, terms, max) {
  const out = [];
  const used = new Set();
  const len = s.chars.length;
  const orig = (i) => (s.map === null ? i : (s.map[i] ?? len));
  const clean = (c) => c.replace(/\s+/gu, ' ');
  const sub = (a, n) => s.chars.slice(a, a + n).join('');
  for (const t of terms) {
    const tc = [...t];
    let pos = 0;
    let at;
    while (out.length < max && (at = indexOfCp(s.foldChars, tc, pos)) !== -1) {
      pos = at + tc.length;
      const a = orig(at);
      const b = orig(at + tc.length - 1) + 1;
      const bucket = Math.floor(a / (CONTEXT * 2));
      if (used.has(bucket)) continue;   // one snippet per stretch of text
      used.add(bucket);
      const start = Math.max(0, a - CONTEXT);
      const end = Math.min(len, b + CONTEXT);
      out.push({
        where: s.where, pageId: s.pageId, pageIndex: s.pageIndex,
        before: (start > 0 ? '…' : '') + clean(sub(start, a - start)).trimStart(),
        match: clean(sub(a, b - a)),
        after: clean(sub(b, end - b)).trimEnd() + (end < len ? '…' : ''),
      });
    }
  }
  return out;
}

function date(v, end) {
  if (typeof v !== 'string' || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ApiError(400, 'bad_date', 'Data non valida (usa AAAA-MM-GG).');
  return end ? v + 'T23:59:59+99:99' : v;
}
