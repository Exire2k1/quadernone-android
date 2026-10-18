// Samsung Notes (.sdocx) -> a new Quadernone note, in the browser (Importa panel).
//
// Handwriting stays handwriting: every Samsung stroke becomes a Quadernone stroke with its
// points, pressure, timing and colour. Mapping (calibrated on Antonio's notes against the
// reference renderer, ink coverage within 0.5 %):
//   - 1440 Samsung units = 210 mm (page width); visible pen width = 0.4 × pen size
//   - InkPen/Pen -> ballpoint ×0.72, Fountain/Calligraphy/Brush -> fountain ×0.9,
//     Marker/Highlighter -> highlighter ×1.5 (opacity from the colour's alpha), Pencil -> pencil
//   - points closer than 0.1 mm are merged (Samsung samples every ~0.01 mm)
//   - beige Samsung paper -> "sand"; PDF pages stay PDF pages (text extracted for search);
//     placed images and text boxes keep their place; typed body text -> text boxes per line
// The note keeps the Samsung creation and modification dates.
import { request } from '../api.js';
import * as files from '../local/files.js';
import { openPdf, pageText } from '../page/pdf.js';
import { prepareImage } from '../page/images.js';
import { renderCoverPng } from '../page/thumb.js';
import { pageToSvg } from '../page/svg.js';
import { readSdocx } from './sdocx.js';
import * as prefs from '../prefs.js';

const K = 210 / 1440;                // mm per Samsung unit
const TUNE = { ballpoint: 0.72, fountain: 0.9, highlighter: 1.5, pencil: 0.72 };
const MIN_POINT_MM = 0.1;
const r2 = (v) => Math.round(v * 100) / 100;
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const argbHex = (c) => '#' + [(c >>> 16) & 255, (c >>> 8) & 255, c & 255].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

function toolOf(penName) {
  const n = (penName || '').split('.').pop();
  if (/^Marker|Highlighter/i.test(n)) return 'highlighter';
  if (/Fountain|Calligraphy|Brush/i.test(n)) return 'fountain';
  if (/Pencil/i.test(n)) return 'pencil';
  return 'ballpoint';
}

/** A Samsung stroke as a Quadernone stroke (null for eraser strokes or empty ones). */
export function convertStroke(s) {
  if (s.eraser || !s.xs.length) return null;
  const tool = toolOf(s.penName);
  const alpha = ((s.argb >>> 24) & 255) / 255;
  const pts = [];
  const n = s.xs.length;
  for (let i = 0; i < n; i++) {
    const x = r2(s.xs[i] * K), y = r2(s.ys[i] * K);
    const p = Math.round(Math.min(1, Math.max(0, s.pressures[i] ?? 0.5)) * 100) / 100;
    const t = Math.round(s.timestamps[i] ?? i);
    const q = pts[pts.length - 1];
    if (q && i < n - 1 && Math.hypot(x - q[0], y - q[1]) < MIN_POINT_MM) { if (p > q[2]) q[2] = p; continue; }
    pts.push([x, y, p, t]);
  }
  if (pts.length === 1) pts.push([pts[0][0] + 0.01, pts[0][1] + 0.01, pts[0][2], pts[0][3] + 1]);
  const st = { id: 'st-' + hex(4), tool, color: argbHex(s.argb), width: r2(Math.max(0.05, 0.4 * s.penWidth * K * TUNE[tool])), points: pts };
  if (tool === 'highlighter') { st.opacity = Math.round(Math.min(0.6, alpha < 1 ? alpha : 0.4) * 100) / 100; st.tip = 'round'; }
  else if (alpha < 0.99) st.opacity = Math.round(alpha * 100) / 100;
  return st;
}

const paperOf = (argb) => {
  if (argb == null) return 'white';
  const r = (argb >>> 16) & 255, g = (argb >>> 8) & 255, b = argb & 255;
  if (Math.abs(r - 244) + Math.abs(g - 228) + Math.abs(b - 215) < 30) return 'sand';
  if (r + g + b < 150) return 'dark';
  return 'white';
};

const textBox = (x, y, w, text, sizePt, z) => ({
  id: 'ob-' + hex(4), type: 'text', x: r2(x), y: r2(y), w: r2(Math.max(20, w)), h: r2(sizePt * 0.3528 * 1.35 * Math.max(1, text.split('\n').length)),
  rotation: 0, z, locked: false,
  blocks: text.split('\n').map((line) => ({ t: 'p', runs: line ? [{ text: line }] : [] })),
  style: { color: '#252525', sizePt, align: 'left' },
});

/** Title from the export file name ("Titolo_251004_143440.sdocx" -> "Titolo"). */
export const sdocxTitle = (name) => name.replace(/\.sdocx$/i, '').replace(/_\d{6}_\d{6}$/, '').trim() || 'Senza titolo';

/**
 * Imports one .sdocx file as a new note in folderId. onStatus(text) reports progress.
 * Returns the new note id. Throws (Italian message) if the file cannot be read.
 */
export async function importSdocx(file, folderId, { onStatus = () => {}, title = null } = {}) {
  onStatus('lettura del file Samsung…');
  await import('../../vendor/jszip/jszip.min.js');
  const doc = await readSdocx(file, window.JSZip);

  // Pages: trailing blank pages (Samsung keeps one at the end) are dropped.
  const pages = doc.pages.slice();
  const empty = (p) => p.pdfPageIndex == null && !p.objects.some((o) => o.type !== 'stroke' || !o.eraser);
  while (pages.length > 1 && empty(pages.at(-1))) pages.pop();
  const paper = paperOf(doc.pages[0]?.backgroundArgb);

  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const created = await request('POST', '/notes', {
    folderId, title: title || sdocxTitle(file.name), created: iso(doc.createdMs), modified: iso(doc.modifiedMs ?? doc.createdMs),
  });
  const id = created.note.id;
  const note = await request('GET', `/notes/${id}`);
  const defaults = note.pages.defaults;

  // Attachments actually used: the PDF behind PDF pages, the placed images.
  const usedImages = new Set(pages.flatMap((p) => p.objects.filter((o) => o.type === 'image' && o.mediaId != null).map((o) => o.mediaId)));
  const pdfEntry = [...doc.media.values()].find((m) => /\.pdf$/i.test(m.name));
  let pdfName = null, pdf = null;
  if (pdfEntry && pages.some((p) => p.pdfPageIndex != null)) {
    onStatus('caricamento del PDF…');
    const blob = await pdfEntry.blob();
    pdfName = await files.upload(id, new File([blob], pdfEntry.name, { type: 'application/pdf' }), pdfEntry.name);
    try { pdf = await openPdf(new Uint8Array(await blob.arrayBuffer())); } catch { pdf = null; }
  }
  const images = new Map();   // media id -> { file, view, natW, natH, bitmap }
  for (const mid of usedImages) {
    const m = doc.media.get(mid);
    if (!m) continue;
    onStatus('caricamento delle immagini…');
    const blob = await m.blob();
    const ext = /\.([a-z0-9]+)$/i.exec(m.name)?.[1]?.toLowerCase() || 'jpg';
    const typed = new File([blob], m.name, { type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg' });
    const prep = await prepareImage(typed);
    const stored = await files.upload(id, typed, m.name);
    const view = Math.max(prep.natW, prep.natH) > 2560 || !/^(jpe?g|png|webp|gif)$/.test(ext)
      ? await files.upload(id, prep.view, m.name.replace(/\.[^.]+$/, '') + `-view.${prep.viewExt}`) : null;
    images.set(mid, { file: stored, view, natW: prep.natW, natH: prep.natH, bitmap: await createImageBitmap(prep.view) });
  }

  onStatus('conversione della scrittura…');
  const out = [], inks = [];
  for (const p of pages) {
    const wMm = r2(p.width * K), hMm = r2(p.height * K);
    const isPdf = pdfName && p.pdfPageIndex != null;
    const a4 = Math.abs(wMm - 210) < 1 && Math.abs(hMm - 297) < 1;
    const page = {
      id: 'pg-' + hex(4),
      size: isPdf ? { preset: 'pdf', widthMm: wMm, heightMm: hMm } : a4 ? { preset: 'A4', widthMm: 210, heightMm: 297 } : { preset: 'custom', widthMm: wMm, heightMm: hMm },
      orientation: wMm > hMm ? 'landscape' : 'portrait',
      background: { type: 'blank', spacingMm: defaults.background.spacingMm || 8, lineColor: defaults.background.lineColor || '#A9BCD6', paperColor: isPdf ? 'white' : paper },
      pdf: isPdf ? { file: pdfName, pageIndex: p.pdfPageIndex } : null,
      inkRevision: 0, objects: [],
    };
    const strokes = [];
    let z = 1;
    for (const o of p.objects) {
      if (o.type === 'stroke') { const s = convertStroke(o); if (s) strokes.push(s); continue; }
      const b = o.bbox;
      if (o.type === 'image' && images.has(o.mediaId)) {
        const im = images.get(o.mediaId);
        page.objects.push({ id: 'ob-' + hex(4), type: 'image', x: r2(b.x_min * K), y: r2(b.y_min * K), w: r2((b.x_max - b.x_min) * K), h: r2((b.y_max - b.y_min) * K),
          rotation: o.rotation || 0, z: z++, locked: false, file: im.file, view: im.view, natW: im.natW, natH: im.natH, crop: null, opacity: 1 });
      } else if (o.type === 'text' && o.text.trim()) {
        page.objects.push(textBox(b.x_min * K, b.y_min * K, (b.x_max - b.x_min) * K, o.text.replace(/￼/g, '').replace(/\r\n?/g, '\n').trimEnd(), 12, z++));
      }
    }
    out.push(page);
    inks.push(strokes);
  }
  // Typed body text: Samsung lays it out from the top of the note, ~65.5 units per line.
  if (doc.bodyText && doc.bodyText.replace(/￼/g, '').trim()) {
    const LINE = 65.5, TOP = 42, PAGE_H = (pages[0]?.height || 2036) + 32;
    doc.bodyText.split('\n').forEach((line, i) => {
      const text = line.replace(/￼/g, '').trim();
      if (!text) return;
      const yU = TOP + i * LINE;
      const pi = Math.min(out.length - 1, Math.floor(yU / PAGE_H));
      out[pi].objects.push(textBox(60 * K, (yU - pi * PAGE_H) * K, 170, text, Math.round((52 * K / 0.3528) * 0.72), 50));
    });
  }

  onStatus('salvataggio sul server…');
  const saved = await request('PUT', `/notes/${id}`, { baseRevision: note.meta.revision, pages: { ...note.pages, pages: out } });
  for (let i = 0; i < out.length; i++) {
    if (!inks[i].length) continue;
    onStatus(`salvataggio della scrittura (pagina ${i + 1} di ${out.length})…`);
    await request('PUT', `/notes/${id}/ink/${out[i].id}`, { baseInkRevision: 0, strokes: inks[i] });
  }
  if (pdf && pdfName) {
    onStatus('testo del PDF per la ricerca…');
    const texts = [];
    for (let i = 0; i < pdf.numPages; i++) texts.push({ pageIndex: i, text: await pageText(pdf, i).catch(() => '') });
    await request('PUT', `/notes/${id}/pdftext/${encodeURIComponent(pdfName)}`, { pages: texts });
  }

  // Previews (for reading the files without the app) and the cover.
  onStatus('anteprime e copertina…');
  for (let i = 0; i < out.length; i++) {
    const svg = pageToSvg(out[i], { title: created.note.title, pageNumber: i + 1, strokes: inks[i] });
    await rawPut(`/notes/${id}/previews/${out[i].id}`, svg, 'image/svg+xml');
  }
  try {
    const first = out[0];
    const imgs = new Map(first.objects.filter((o) => o.type === 'image').map((o) => [o.id, [...images.values()].find((im) => im.file === o.file)?.bitmap]).filter(([, b]) => b));
    let pdfCanvas = null;
    if (pdf && first.pdf) {
      const pg = await pdf.getPage(first.pdf.pageIndex + 1);
      const vp = pg.getViewport({ scale: 400 / pg.getViewport({ scale: 1 }).width });
      pdfCanvas = document.createElement('canvas');
      pdfCanvas.width = Math.round(vp.width); pdfCanvas.height = Math.round(vp.height);
      await pg.render({ canvasContext: pdfCanvas.getContext('2d'), viewport: vp, background: 'white' }).promise;
    }
    await rawPut(`/notes/${id}/cover`, await renderCoverPng(first, inks[0], { images: imgs, pdf: pdfCanvas }), 'image/png');
  } catch { /* the cover is made when the note is opened */ }
  pdf?.destroy?.();
  for (const im of images.values()) im.bitmap?.close?.();

  // Last: the original modification date (every write above set it to "now").
  if (doc.modifiedMs) {
    await request('PUT', `/notes/${id}`, { baseRevision: saved.revision, meta: { modified: iso(doc.modifiedMs) } }).catch(() => {});
  }
  return id;
}

async function rawPut(path, body, type) {
  await fetch(`${prefs.serverBase()}/api${path}`, {
    method: 'PUT', body,
    headers: { 'Content-Type': type, 'X-Quadernone-Token': prefs.get('token'), 'X-Quadernone-Device': prefs.get('deviceName') },
  }).catch(() => {});
}
