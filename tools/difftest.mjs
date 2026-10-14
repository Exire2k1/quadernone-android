// Differential test: the same sequence of requests to the old PHP server and to the new
// JavaScript local server; answers and files on disk must match (after replacing ids,
// times and other values that are random by design).
//
//   TZ=Europe/Rome node tools/difftest.mjs <php-root> <js-data-dir> <php-base-url>
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createLocalServer } from '../web/js/localserver/server.js';
import { nodeAdapter } from './node-adapter.mjs';

const [phpRoot, jsData, phpBase] = process.argv.slice(2);
const phpData = path.join(phpRoot, 'data');
const TOKEN = 'testtoken';
const DEVICE = 'Test';

const js = createLocalServer({ adapter: nodeAdapter(jsData), alwaysScan: true });

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

async function callPhp(method, p, { json, raw, type, form } = {}) {
  const headers = { 'X-Quadernone-Token': TOKEN, 'X-Quadernone-Device': DEVICE };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (raw) { headers['Content-Type'] = type; body = raw; }
  if (form) {
    body = new FormData();
    body.append('file', new Blob([form.bytes]), form.filename);
    if (form.name) body.append('name', form.name);
  }
  const res = await fetch(phpBase + '/api' + p, { method, headers, body });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) return { status: res.status, json: await res.json() };
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), type: ct.split(';')[0] };
}

async function callJs(method, p, { json, raw, form } = {}) {
  const r = await js.handle({
    method, path: p, device: DEVICE,
    body: json !== undefined ? JSON.stringify(json) : raw || null,
    form: form ? { file: { name: form.filename, bytes: form.bytes }, name: form.name } : null,
  });
  return r;
}

// ---- normalisation of values that are random by design
function normalizer() {
  const ids = new Map();
  const map = (prefix, v) => {
    if (!ids.has(v)) ids.set(v, `<${prefix}${ids.size + 1}>`);
    return ids.get(v);
  };
  const str = (s) => s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-\d{14})?/g, (m) => map('id', m.slice(0, 36)) + (m.length > 36 ? '<-stamp>' : ''))
    .replace(/\bpg-[0-9a-f]{8}\b/g, (m) => map('pg', m))
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)/g, '<time>')
    .replace(/\d{4}-\d{2}-\d{2} \d{2}-\d{2}/g, '<minute>')
    .replace(/\d{4}-\d{2}-\d{2} \d{6}/g, '<stamp>');
  const walk = (v, key) => {
    if (typeof v === 'string') return str(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        if (['coverVersion', 'sizeBytes', 'size'].includes(k) && x !== null) { o[k] = '<v>'; continue; }
        if (k === 'mime') { o[k] = x; continue; }
        o[str(k)] = walk(x, k);
      }
      return o;
    }
    return v;
  };
  return walk;
}

const normPhp = normalizer();
const normJs = normalizer();
let failures = 0;
let steps = 0;

function same(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/** Runs one request on both servers and compares. Returns the PHP and JS answers (raw). */
async function step(label, method, p, opts = {}) {
  steps++;
  const pp = typeof p === 'function' ? p('php') : p;
  const jp = typeof p === 'function' ? p('js') : p;
  const po = typeof opts === 'function' ? opts('php') : opts;
  const jo = typeof opts === 'function' ? opts('js') : opts;
  const a = await callPhp(method, pp, po);
  const b = await callJs(method, jp, jo);
  const na = { status: a.status, body: a.json !== undefined ? normPhp(a.json) : { bytes: a.bytes?.length, type: a.type } };
  const nb = { status: b.status, body: b.json !== undefined ? normJs(b.json) : { bytes: b.bytes?.length, type: b.type } };
  if (!same(na, nb)) {
    failures++;
    console.log(`✗ ${label}\n  PHP: ${JSON.stringify(sortKeys(na))}\n  JS : ${JSON.stringify(sortKeys(nb))}`);
  } else {
    console.log(`✓ ${label}`);
  }
  return { php: a, js: b };
}

/** id from each side's answer, for the next requests. */
const pick = (r, f) => ({ php: f(r.php.json), js: f(r.js.json) });
const both = (ids, fmt) => (side) => fmt(ids[side]);

// ---- files on disk
async function tree(root) {
  const out = {};
  async function walk(rel) {
    for (const name of (await fsp.readdir(path.join(root, rel))).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = await fsp.stat(path.join(root, r));
      if (st.isDirectory()) { out[r + '/'] = 'dir'; await walk(r); continue; }
      if (r.startsWith('_app/')) continue;   // caches and the feed (different by design)
      const buf = await fsp.readFile(path.join(root, r));
      if (r.endsWith('.json')) {
        try { out[r] = JSON.parse(buf.toString('utf8')); } catch { out[r] = 'BAD JSON'; }
      } else if (r.endsWith('.md') || r.endsWith('.svg')) out[r] = buf.toString('utf8');
      else out[r] = `<${buf.length} bytes>`;
    }
  }
  await walk('');
  return out;
}

async function compareDisk(label) {
  steps++;
  const a = normPhp(await tree(phpData));
  const b = normJs(await tree(jsData));
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  let ok = JSON.stringify(ka) === JSON.stringify(kb);
  if (!ok) {
    console.log(`✗ disk ${label}: files differ\n  only PHP: ${ka.filter((k) => !kb.includes(k)).join(', ')}\n  only JS : ${kb.filter((k) => !ka.includes(k)).join(', ')}`);
  }
  for (const k of ka) {
    if (!(k in b)) continue;
    if (!same(a[k], b[k])) {
      ok = false;
      console.log(`✗ disk ${label}: ${k}\n  PHP: ${JSON.stringify(sortKeys(a[k])).slice(0, 600)}\n  JS : ${JSON.stringify(sortKeys(b[k])).slice(0, 600)}`);
    }
  }
  if (ok) console.log(`✓ disk ${label} (${ka.length} entries)`);
  else failures++;
}

// ======================================================================= scenario
await step('tree (empty)', 'GET', '/tree');
await step('health is public data, skip compare', 'GET', '/settings');

const uni = pick(await step('create folder Università', 'POST', '/folders', { json: { name: 'Università', color: '#ff8800' } }), (j) => j.folder.id);
const ana = pick(await step('create subfolder', 'POST', '/folders', both(uni, (id) => ({ json: { parentId: id, name: 'Analisi 1' } }))), (j) => j.folder.id);
await step('folder with bad chars', 'POST', '/folders', { json: { name: '  a/b:c?*  ..' } });
await step('duplicate name (case-insensitive)', 'POST', '/folders', { json: { name: 'università' } });
await step('reserved name', 'POST', '/folders', { json: { name: 'con.txt' } });
await step('reserved root name', 'POST', '/folders', { json: { name: '_app' } });
await step('bad colour', 'POST', '/folders', { json: { name: 'x', color: 'red' } });

const n1 = pick(await step('create note in folder', 'POST', '/notes', both(ana, (id) => ({ json: { folderId: id, title: 'Lezione 1' } }))), (j) => j.note.id);
const n2 = pick(await step('create note at root, custom page', 'POST', '/notes', { json: { title: 'Schema', pageDefaults: { size: { preset: 'custom', widthMm: 300.456, heightMm: 120 }, orientation: 'landscape', background: { type: 'grid', spacingMm: 5, lineColor: '#aabbcc', paperColor: 'sand' } } } }), (j) => j.note.id);
await step('create note bad defaults', 'POST', '/notes', { json: { title: 'x', pageDefaults: { size: { preset: 'B9' } } } });
await step('create note with import dates', 'POST', '/notes', { json: { title: 'Vecchia', created: '2024-01-02T10:00:00+01:00', modified: '2024-02-03T11:00:00Z' } });
await step('create note same title', 'POST', '/notes', both(ana, (id) => ({ json: { folderId: id, title: 'lezione 1' } })));

const g1 = await step('get note with ink', 'GET', both(n1, (id) => `/notes/${id}?ink=1`));
const pages = { php: g1.php.json.pages, js: g1.js.json.pages };
const page1 = { php: pages.php.pages[0].id, js: pages.js.pages[0].id };

const textObj = { id: 'ob-0000000a', type: 'text', x: 20, y: 30, w: 100, h: 40, rotation: 0, z: 1,
  blocks: [
    { t: 'h1', runs: [{ text: 'Derivate' }] },
    { t: 'p', runs: [{ text: 'Perché la ' }, { text: 'derivata', b: true }, { text: ' è *lineare*', i: true }] },
    { t: 'ol', runs: [{ text: 'primo' }] }, { t: 'ol', runs: [{ text: 'secondo' }] },
    { t: 'check', done: true, runs: [{ text: 'fatto', s: true }] }, { t: 'ul', runs: [{ text: 'punto [1]' }] },
  ], style: { color: '#ffffff', sizePt: 12, align: 'left' } };
const textObj2 = { id: 'ob-0000000b', type: 'text', x: 10, y: 5, w: 50, h: 10, blocks: [{ t: 'p', runs: [{ text: 'In alto' }] }] };
const newPages = (side) => {
  const p = structuredClone(pages[side]);
  p.pages[0].objects = [textObj, textObj2];
  p.pages.push({ id: 'pg-0000abcd', size: { preset: 'A5' }, orientation: 'landscape', background: { type: 'dotted', spacingMm: 6.5, lineColor: '#123456', paperColor: 'ivory' }, pdf: { file: 'slides.pdf', pageIndex: 2 }, inkRevision: 99, objects: [] });
  return p;
};
await step('save pages + rename', 'PUT', both(n1, (id) => `/notes/${id}`), (side) => ({ json: { baseRevision: 1, meta: { title: 'Lezione 1 – derivate', favorite: true }, pages: newPages(side) } }));
await step('save bad pages', 'PUT', both(n1, (id) => `/notes/${id}`), { json: { baseRevision: 2, pages: { pages: [{ id: 'nope' }] } } });
await step('save missing revision', 'PUT', both(n1, (id) => `/notes/${id}`), { json: { meta: { title: 'x' } } });
await step('save nothing', 'PUT', both(n1, (id) => `/notes/${id}`), { json: { baseRevision: 2 } });
await step('save bad cover', 'PUT', both(n1, (id) => `/notes/${id}`), { json: { baseRevision: 2, meta: { cover: { mode: 'image' } } } });
await step('save cover preset', 'PUT', both(n1, (id) => `/notes/${id}`), { json: { baseRevision: 2, meta: { cover: { mode: 'preset', color: '#00ff00', icon: 'star', image: null } } } });
await step('case-only rename', 'PUT', both(n1, (id) => `/notes/${id}`), { json: { baseRevision: 3, meta: { title: 'LEZIONE 1 – derivate' } } });
await step('stale save -> conflict copy', 'PUT', both(n1, (id) => `/notes/${id}`), (side) => ({ json: { baseRevision: 2, meta: { title: 'Mia versione' }, pages: newPages(side) } }));

const stroke = (id, extra = {}) => ({ id, tool: 'ballpoint', color: '#1a1a1a', width: 0.56, opacity: 1, points: [[10.5, 20.25, 0.5, 0], [11, 21, 0.6, 16]], ...extra });
await step('ink save', 'PUT', (side) => `/notes/${n1[side]}/ink/${page1[side]}`,
  { json: { baseInkRevision: 0, strokes: [stroke('st-00000001'), stroke('st-00000002', { tool: 'highlighter', tip: 'chisel', opacity: 0.01, pressure: false })] } });
await step('ink save again', 'PUT', (side) => `/notes/${n1[side]}/ink/${page1[side]}`, { json: { baseInkRevision: 1, strokes: [stroke('st-00000001')] } });
await step('ink stale -> conflict', 'PUT', (side) => `/notes/${n1[side]}/ink/${page1[side]}`, { json: { baseInkRevision: 0, strokes: [stroke('st-00000009')] } });
await step('ink bad stroke', 'PUT', (side) => `/notes/${n1[side]}/ink/${page1[side]}`, { json: { baseInkRevision: 2, strokes: [stroke('st-1')] } });
await step('ink unknown page', 'PUT', (side) => `/notes/${n1[side]}/ink/pg-ffffffff`, { json: { baseInkRevision: 0, strokes: [] } });
await step('ink get', 'GET', (side) => `/notes/${n1[side]}/ink/${page1[side]}`);
await step('ink get new page', 'GET', (side) => `/notes/${n1[side]}/ink/pg-0000abcd`);

await step('pdftext', 'PUT', (side) => `/notes/${n1[side]}/pdftext/slides.pdf`, { json: { pages: [{ pageIndex: 2, text: 'Teorema di Lagrange: perché funziona' }, { pageIndex: 3, text: 'altro' }] } });
await step('pdftext bad', 'PUT', (side) => `/notes/${n1[side]}/pdftext/slides.pdf`, { json: { pages: [{ pageIndex: -1, text: 'x' }] } });
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
await step('preview', 'PUT', (side) => `/notes/${n1[side]}/previews/${page1[side]}`, { raw: svg, type: 'image/svg+xml' });
await step('preview with script', 'PUT', (side) => `/notes/${n1[side]}/previews/${page1[side]}`, { raw: new TextEncoder().encode('<svg><script>x</script></svg>'), type: 'image/svg+xml' });
await step('cover', 'PUT', (side) => `/notes/${n1[side]}/cover`, { raw: PNG, type: 'image/png' });
await step('cover not png', 'PUT', (side) => `/notes/${n1[side]}/cover`, { raw: JPG, type: 'image/png' });
await step('cover get', 'GET', (side) => `/notes/${n1[side]}/cover`);
await step('cover missing', 'GET', (side) => `/notes/${n2[side]}/cover`);

await step('upload', 'POST', (side) => `/notes/${n1[side]}/attachments`, { form: { bytes: JPG, filename: 'Foto Vacanze.JPG' } });
await step('upload same name', 'POST', (side) => `/notes/${n1[side]}/attachments`, { form: { bytes: JPG, filename: 'x.jpg', name: 'foto vacanze.jpg' } });
await step('upload pdf', 'POST', (side) => `/notes/${n1[side]}/attachments`, { form: { bytes: new TextEncoder().encode('%PDF-1.4 test'), filename: 'slides.pdf' } });
await step('attachments list', 'GET', (side) => `/notes/${n1[side]}/attachments`);
await step('attachment get', 'GET', (side) => `/notes/${n1[side]}/attachments/${encodeURIComponent('Foto Vacanze.jpg')}`);
await step('attachment bad name', 'GET', (side) => `/notes/${n1[side]}/attachments/..%2Fmeta.json`);

await step('tree', 'GET', '/tree');
await compareDisk('after notes');

await step('search derivate', 'GET', '/search?q=derivata');
await step('search accents', 'GET', '/search?q=perche');
await step('search two words', 'GET', '/search?q=lagrange%20teorema');
await step('search pdf only', 'GET', '/search?q=lagrange&type=pdf');
await step('search in folder', 'GET', both(uni, (id) => `/search?q=lezione&folder=${id}`));
await step('search bad', 'GET', '/search?q=');
await step('search dates', 'GET', '/search?q=vecchia&from=2024-01-01&to=2024-12-31');

await step('move note to root', 'PATCH', (side) => `/notes/${n1[side]}/move`, { json: { folderId: null } });
await step('move note back', 'PATCH', (side) => `/notes/${n1[side]}/move`, both(uni, (id) => ({ json: { folderId: id } })));
await step('move without folder', 'PATCH', (side) => `/notes/${n1[side]}/move`, { json: {} });
await step('rename + colour folder', 'PATCH', both(ana, (id) => `/folders/${id}`), { json: { name: 'Analisi Uno', color: '#112233' } });
await step('move folder into itself', 'PATCH', both(uni, (id) => `/folders/${id}`), both(ana, (id) => ({ json: { parentId: id } })));
await step('move folder to root', 'PATCH', both(ana, (id) => `/folders/${id}`), { json: { parentId: null } });
await step('folder count', 'GET', both(uni, (id) => `/folders/${id}/count`));

await step('trash note', 'DELETE', (side) => `/notes/${n2[side]}`);
const tr = await step('trash list', 'GET', '/trash');
await step('restore', 'POST', (side) => `/trash/${(side === 'php' ? tr.php : tr.js).json.items[0].trashId}/restore`);
await step('trash again', 'DELETE', (side) => `/notes/${n2[side]}`);
const tr2 = await step('trash list 2', 'GET', '/trash');
await step('delete forever', 'DELETE', (side) => `/trash/${(side === 'php' ? tr2.php : tr2.js).json.items[0].trashId}`);
await step('delete folder with notes', 'DELETE', both(uni, (id) => `/folders/${id}`));
const tr3 = await step('trash list 3', 'GET', '/trash');
await step('restore into deleted folder', 'POST', (side) => {
  const items = (side === 'php' ? tr3.php : tr3.js).json.items;
  return `/trash/${items.find((i) => i.title.startsWith('LEZIONE')).trashId}/restore`;
});
await step('tree after restore', 'GET', '/tree');
await compareDisk('after trash');
await step('empty trash', 'DELETE', '/trash');

await step('settings bad', 'PUT', '/settings', { json: { trashRetentionDays: 0 } });
await step('settings ok', 'PUT', '/settings', { json: { trashRetentionDays: 10 } });
await step('changes since 0', 'GET', '/changes?since=0');
await step('changes since 3', 'GET', '/changes?since=3');
await step('changes future', 'GET', '/changes?since=99999');
await step('changes bad', 'GET', '/changes?since=abc');
await step('bad id', 'GET', '/notes/xyz');
await step('missing note', 'GET', '/notes/00000000-0000-4000-8000-000000000000');
await step('unknown route', 'GET', '/nothing');
await step('wrong method', 'DELETE', '/settings');
await step('bad json', 'POST', '/folders', { raw: new TextEncoder().encode('{nope'), type: 'application/json' });

// Changes made by another app (file manager): new folder, folder without .folder.json, renamed folder.
for (const root of [phpData, jsData]) {
  await fsp.mkdir(path.join(root, 'Fatta a mano', 'Sotto'), { recursive: true });
  await fsp.mkdir(path.join(root, '.nascosta'), { recursive: true });
}
await step('tree after external changes', 'GET', '/tree');
await compareDisk('final');

console.log(`\n${steps - failures}/${steps} ok`);
process.exit(failures ? 1 : 0);
