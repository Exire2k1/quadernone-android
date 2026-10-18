// Importa: Samsung Notes notes (.sdocx, converted to real handwriting), Samsung exports
// (PDF, .txt), PDF, slides, images, or a .zip of them.
// Every file becomes a new note, in the chosen folder; with "Ricrea le cartelle di origine"
// the folders of a chosen folder or of the .zip are recreated inside it.
// - PDF: pages = the PDF pages as backgrounds (writable); dates = the file's dates.
// - .txt: one A4 lined page with the text in an editable text box.
// - .pptx: converted by Google Drive (when linked), then like a PDF.
// - an archive of Quadernone notes (.zip exported from Impostazioni, or of the server's data
//   folder): every note as it is, with its folders (local/backup.js).
// - images: one page with the image.
// - .sdocx: see import/samsung.js (strokes, PDF pages, images, text, original dates).
import { h, fill } from '../dom.js';
import { t } from '../i18n.js';
import { api, request } from '../api.js';
import { store } from '../store.js';
import { openPanel } from '../ui/panel.js';
import { icon } from '../icons.js';
import * as act from '../library/actions.js';
import * as prefs from '../prefs.js';
import * as files from '../local/files.js';
import { openPdf, pageSizeMm, pageText } from '../page/pdf.js';
import { prepareImage, imageExt, makeImageObject } from '../page/images.js';
import { renderCoverPng } from '../page/thumb.js';
import { isImage, isPdf, isSlides } from '../editor/inserts.js';
import { importSdocx, sdocxTitle } from '../import/samsung.js';
import { isArchive, importArchive } from '../local/backup.js';

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const isTxt = (f) => /\.txt$/i.test(f.name) || f.type === 'text/plain';
const isZip = (f) => /\.zip$/i.test(f.name) || (/zip/.test(f.type) && !isSdocx(f));
const isSdocx = (f) => /\.sdocx$/i.test(f.name);
const MIME = { pdf: 'application/pdf', txt: 'text/plain', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const A4_LINED = {
  size: { preset: 'A4', widthMm: 210, heightMm: 297 }, orientation: 'portrait',
  background: { type: 'lined', spacingMm: 8, lineColor: '#A9BCD6', paperColor: 'white' },
};

/** { file, name, dirs: [..], lastModified } for every file, .zip contents expanded. */
async function expand(list, onStatus) {
  const out = [];
  for (const f of list) {
    const rel = (f.webkitRelativePath || '').split('/').filter(Boolean);
    const dirs = rel.length > 1 ? rel.slice(0, -1) : [];
    if (!isZip(f)) { out.push({ file: f, name: f.name, dirs, lastModified: f.lastModified }); continue; }
    onStatus(t('import.reading'));
    // An archive of Quadernone notes (export, or the server's data folder): imported as it is.
    if (await isArchive(f)) { out.push({ file: f, name: f.name, dirs: [], lastModified: f.lastModified, archive: true }); continue; }
    await import('../../vendor/jszip/jszip.min.js');
    const zip = await window.JSZip.loadAsync(f);
    const entries = [];
    zip.forEach((path, e) => { if (!e.dir && !/(^|\/)(__MACOSX|\.)/.test(path)) entries.push([path, e]); });
    for (const [path, e] of entries) {
      const parts = path.split('/').filter(Boolean);
      const name = parts.pop();
      const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() || '';
      const blob = await e.async('blob');
      const lm = e.date?.getTime?.() || f.lastModified;
      out.push({ file: new File([blob], name, { type: MIME[ext] || '', lastModified: lm }), name, dirs: [...dirs, ...parts], lastModified: lm });   // the folders inside the .zip
    }
  }
  return out;
}

const kindOf = (f) => (isSdocx(f) ? 'samsung' : isPdf(f) ? 'pdf' : isTxt(f) ? 'txt' : isSlides(f) ? 'slides' : isImage(f) ? 'image' : null);
const titleOf = (name) => (/\.sdocx$/i.test(name) ? sdocxTitle(name) : name.replace(/\.[^.]+$/, '').trim() || t('newNote.untitled'));
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

export function openImport({ folderId = null, onDone = () => {} } = {}) {
  let dest = folderId;
  let recreate = true;
  let items = [];   // { file, name, dirs, lastModified, kind, state, reason }
  let running = false;

  const destBtn = h('button.btn', { type: 'button', onclick: async () => {
    const target = await act.pickFolder({ title: t('import.dest') });
    if (target !== undefined) { dest = target; renderDest(); }
  } });
  const renderDest = () => fill(destBtn, icon('folder'), h('span', {}, dest ? store.folders.get(dest)?.name ?? '?' : t('move.root')));
  renderDest();
  const recreateBox = h('input', { type: 'checkbox', checked: true, onchange: (e) => { recreate = e.target.checked; } });
  const status = h('p.hint');
  const list = h('ul.import-list');
  const summary = h('p.import-summary');

  const choose = (opts) => () => {
    const input = h('input', { type: 'file', multiple: true, style: { display: 'none' }, ...opts });
    input.addEventListener('change', async () => {
      const chosen = [...input.files];
      input.remove();
      if (!chosen.length) return;
      try {
        const expanded = await expand(chosen, (s) => { status.textContent = s; });
        items = expanded.map((x) => ({ ...x, kind: x.archive ? 'archive' : kindOf(x.file), state: 'waiting', reason: '' }));
        for (const it of items) if (!it.kind) { it.state = 'skipped'; it.reason = t('import.unsupported'); }
        status.textContent = t('import.count', { n: items.length });
        summary.textContent = '';
        render();
      } catch (e) { status.textContent = e.message; }
    });
    document.body.append(input);
    input.click();
  };

  function render() {
    fill(list, items.map((it) => h(`li.import-item.${it.state}`, {},
      icon(it.kind === 'samsung' ? 'pen' : it.kind === 'pdf' ? 'pdf' : it.kind === 'slides' ? 'slides' : it.kind === 'image' ? 'image' : 'notes'),
      h('span.name', {}, it.kind === 'samsung' ? titleOf(it.name) : it.name, it.dirs.length > 0 && recreate ? h('span.path', {}, ' · ' + it.dirs.join(' / ')) : null,
        it.reason ? h('span.reason', {}, it.reason) : null),
      h('span.state', {}, t('import.' + it.state)))));
    startBtn.disabled = running || !items.some((x) => x.state === 'waiting');
  }

  const startBtn = h('button.btn.primary', { type: 'button', onclick: () => run() }, t('import.start'));
  const p = openPanel({
    title: t('import.title'),
    body: [
      h('p.hint', {}, t('import.intro')),
      h('p.hint', {}, t('import.samsungHint')),
      h('div.import-pick', {},
        // Samsung notes: no 'accept' filter (Android does not know the .sdocx type and would grey the files out).
        h('button.btn', { type: 'button', onclick: choose({}) }, icon('pen'), h('span', {}, t('import.samsung'))),
        h('button.btn', { type: 'button', onclick: choose({ accept: '.pdf,.txt,.pptx,.ppt,.odp,.zip,.sdocx,image/*' }) }, icon('importFiles'), h('span', {}, t('import.files'))),
        h('button.btn', { type: 'button', onclick: choose({ webkitdirectory: true }) }, icon('folder'), h('span', {}, t('import.folder')))),
      h('div.field', {}, h('span.field-label', {}, t('import.dest')), destBtn),
      h('label.switch-row', {}, recreateBox, h('span', {}, t('import.recreate'))),
      status, list, summary,
    ],
    footer: [h('button.btn', { type: 'button', onclick: () => p.close() }, t('import.close')), startBtn],
    onClose: () => onDone(),
  });
  render();

  // ---------------------------------------------------------------- import
  const folderCache = new Map();
  async function folderFor(it) {
    if (!recreate || !it.dirs.length) return dest;
    let parent = dest;
    for (const name of it.dirs) {
      const key = `${parent}/${name.toLowerCase()}`;
      if (!folderCache.has(key)) {
        const existing = store.childFolders(parent).find((f) => f.name.toLowerCase() === name.toLowerCase());
        folderCache.set(key, existing ? existing.id : (await api.createFolder(parent, name)).folder.id);
      }
      parent = folderCache.get(key);
    }
    return parent;
  }

  async function run() {
    running = true;
    render();
    try { await request('GET', '/settings'); } catch (e) {
      status.textContent = e.status === 0 ? t('import.needServer') : e.message;
      running = false; render(); return;
    }
    let ok = 0, bad = 0;
    const todo = items.filter((x) => x.state === 'waiting');
    for (const it of todo) {
      it.state = 'working'; render();
      try {
        await importOne(it, await folderFor(it));
        it.state = 'done'; ok++;
      } catch (e) {
        it.state = 'failed'; it.reason = e.message || String(e); bad++;
      }
      render();
    }
    running = false;
    summary.textContent = bad ? t('import.summaryErrors', { ok, n: todo.length, bad }) : t('import.summary', { ok, n: todo.length });
    render();
    await store.load().catch(() => {});
  }

  async function importOne(it, folder) {
    if (it.kind === 'archive') {
      const res = await importArchive(it.file, { targetFolderId: folder, onProgress: (done, total) => { it.reason = t('settings.importing', { done, total }); render(); } });
      it.reason = t('settings.imported', { n: res.imported, skipped: res.skipped }) + (res.failed.length ? ' · ' + res.failed.map((f) => `${f.path}: ${f.reason}`).join('; ') : '');
      if (!res.imported && res.failed.length) throw new Error(it.reason);
      return;
    }
    if (it.kind === 'samsung') {
      await importSdocx(it.file, folder, { title: titleOf(it.name), onStatus: (s) => { it.reason = s; render(); } });
      it.reason = '';
      return;
    }
    const pageDefaults = it.kind === 'txt' ? A4_LINED : prefs.get('pageDefaults');
    const created = await request('POST', '/notes', {
      folderId: folder, title: titleOf(it.name), pageDefaults, created: iso(it.lastModified), modified: iso(it.lastModified),
    });
    const id = created.note.id;
    const note = await request('GET', `/notes/${id}`);
    const save = (pages, meta) => request('PUT', `/notes/${id}`, { baseRevision: note.meta.revision, pages: { ...note.pages, pages }, ...(meta ? { meta } : {}) });
    const first = note.pages.pages[0];
    if (it.kind === 'txt') {
      const text = (await it.file.text()).replace(/\r\n?/g, '\n');
      const blocks = text.split('\n').map((line) => ({ t: 'p', runs: line ? [{ text: line }] : [] }));
      const obj = { id: 'ob-' + hex(4), type: 'text', x: 20, y: 24, w: 170, h: Math.max(20, blocks.length * 6.5), rotation: 0, z: 1, locked: false,
        blocks, style: { color: '#1A1A1A', sizePt: 12, align: 'left' } };
      await save([{ ...first, objects: [obj] }]);
      return;
    }
    if (it.kind === 'image') {
      const prep = await prepareImage(it.file);
      const tag = hex(4);
      const orig = await files.upload(id, it.file, `img-${tag}.${imageExt(it.file, it.name)}`);
      const view = Math.max(prep.natW, prep.natH) > 2560 || !/^(jpe?g|png|webp|gif)$/.test(imageExt(it.file, it.name))
        ? await files.upload(id, prep.view, `img-${tag}-view.${prep.viewExt}`) : null;
      const obj = makeImageObject('ob-' + hex(4), { file: orig, view, natW: prep.natW, natH: prep.natH }, first, null, 1);
      const page = { ...first, objects: [obj] };
      await save([page]);
      const bmp = await createImageBitmap(prep.view);
      await putCover(id, await renderCoverPng(page, [], { images: new Map([[obj.id, bmp]]) }));
      return;
    }
    // PDF and slides
    let pdfName, blob = it.file;
    if (it.kind === 'slides') {
      const up = await files.upload(id, it.file, it.name);
      const conv = await request('POST', '/convert/pptx', { noteId: id, name: up }, { timeoutMs: 180000 });
      pdfName = conv.name;
      blob = await files.getFile(id, pdfName);
    } else {
      pdfName = await files.upload(id, it.file, it.name.replace(/\.pdf$/i, '') + '.pdf');
    }
    let pdf;
    try { pdf = await openPdf(new Uint8Array(await blob.arrayBuffer())); } catch (e) {
      throw new Error(e?.name === 'PasswordException' ? t('insert.pdfProtected', { name: it.name }) : t('insert.pdfBroken', { name: it.name }));
    }
    const pages = [], texts = [];
    for (let i = 0; i < pdf.numPages; i++) {
      const size = await pageSizeMm(pdf, i);
      pages.push({
        id: 'pg-' + hex(4), size: { preset: 'pdf', widthMm: size.widthMm, heightMm: size.heightMm },
        orientation: size.widthMm > size.heightMm ? 'landscape' : 'portrait',
        background: { ...first.background, type: 'blank', paperColor: 'white' }, pdf: { file: pdfName, pageIndex: i }, inkRevision: 0, objects: [],
      });
      texts.push({ pageIndex: i, text: await pageText(pdf, i).catch(() => '') });
    }
    await save(pages);
    await request('PUT', `/notes/${id}/pdftext/${encodeURIComponent(pdfName)}`, { pages: texts });
    // Cover: the first PDF page.
    try {
      const pg = await pdf.getPage(1);
      const vp = pg.getViewport({ scale: 400 / pg.getViewport({ scale: 1 }).width });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp, background: 'white' }).promise;
      await putCover(id, await renderCoverPng(pages[0], [], { pdf: c }));
    } catch { /* the cover is made when the note is opened */ }
    pdf.destroy();
  }
}

async function putCover(id, png) {
  await fetch(`${prefs.serverBase()}/api/notes/${id}/cover`, {
    method: 'PUT', body: png,
    headers: { 'Content-Type': 'image/png', 'X-Quadernone-Token': prefs.get('token'), 'X-Quadernone-Device': prefs.get('deviceName') },
  }).catch(() => {});
}
