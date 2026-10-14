// PDF pages as page backgrounds (pdf.js), page sizes and text extraction.
//
// Rendering: each background tile of a PDF-backed page gets its own render of the region
// it covers, at the tile's resolution (capped). Until it is ready the tile shows a small
// render of the whole page, so scrolling and zooming never show an empty page.
// pdf.js is loaded only when a note with PDF pages is opened.
import { getFile } from '../local/files.js';

const VENDOR = new URL('../../vendor/pdfjs/', import.meta.url).href;
const MM_PER_PT = 25.4 / 72;
const MAX_PX_PER_MM = 12;      // ≈ 300 dpi: sharper is invisible, and costs memory
const LOW_PX_PER_MM = 2.5;     // placeholder render of the whole page

let lib = null;
export function pdfjs() {
  lib ||= import(VENDOR + 'pdf.min.js').then((m) => {
    m.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.js';
    return m;
  });
  return lib;
}

/** Opens a PDF from bytes (ArrayBuffer/Uint8Array). */
export async function openPdf(data) {
  const m = await pdfjs();
  return m.getDocument({
    data, cMapUrl: VENDOR + 'cmaps/', cMapPacked: true, standardFontDataUrl: VENDOR + 'standard_fonts/',
    isEvalSupported: false, enableXfa: false,
  }).promise;
}

/** Page size in mm, rotation applied (as shown). */
export async function pageSizeMm(doc, index) {
  const page = await doc.getPage(index + 1);
  const v = page.getViewport({ scale: 1 });
  return { widthMm: Math.round(v.width * MM_PER_PT * 100) / 100, heightMm: Math.round(v.height * MM_PER_PT * 100) / 100 };
}

/** Plain text of a page (for search), lines kept. */
export async function pageText(doc, index) {
  const page = await doc.getPage(index + 1);
  const tc = await page.getTextContent();
  let out = '';
  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue;
    out += it.str + (it.hasEOL ? '\n' : (it.str.endsWith(' ') ? '' : ' '));
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim();
}

/** Renders the region [y0Mm, y0Mm + hMm] of a page at pxPerMm into a new canvas. */
async function renderRegion(doc, index, pxPerMm, y0Mm, hMm, widthMm) {
  const page = await doc.getPage(index + 1);
  const viewport = page.getViewport({ scale: pxPerMm * MM_PER_PT });   // pdf.js scale: px per PDF point
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(widthMm * pxPerMm));
  canvas.height = Math.max(1, Math.round(hMm * pxPerMm));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, transform: [1, 0, 0, 1, 0, -y0Mm * pxPerMm], background: 'white' }).promise;
  return canvas;
}

/**
 * Paints PDF backgrounds into the page tiles of one note (see page/pageview.js).
 * One render at a time, the newest request first; requests for tiles that are gone or
 * were drawn at another zoom meanwhile are skipped.
 */
export class PdfPainter {
  #docs = new Map();     // file -> Promise<PDFDocumentProxy>
  #low = new Map();      // "file#i" -> canvas | Promise
  #tiles = new WeakMap(); // tile -> { key, canvas }
  #queue = [];
  #busy = false;
  disposed = false;

  constructor(noteId) { this.noteId = noteId; }

  doc(file) {
    if (!this.#docs.has(file)) {
      const p = getFile(this.noteId, file).then((b) => b.arrayBuffer()).then((buf) => openPdf(buf));
      p.catch(() => this.#docs.delete(file));
      this.#docs.set(file, p);
    }
    return this.#docs.get(file);
  }

  /** Low-resolution render of a whole PDF page (thumbnails, cover). */
  async low(page) {
    const lowKey = `${page.pdf.file}#${page.pdf.pageIndex}`;
    let c = this.#low.get(lowKey);
    if (!c) {
      c = this.doc(page.pdf.file).then((d) => renderRegion(d, page.pdf.pageIndex, LOW_PX_PER_MM, 0, page.size.heightMm, page.size.widthMm));
      this.#low.set(lowKey, c);
      c.then((cv) => this.#low.set(lowKey, cv)).catch(() => this.#low.delete(lowKey));
    }
    return c;
  }

  /** The low-resolution render if it is already available (synchronous). */
  lowNow(page) {
    const c = this.#low.get(`${page.pdf.file}#${page.pdf.pageIndex}`);
    return c instanceof HTMLCanvasElement ? c : null;
  }

  dispose() {
    this.disposed = true;
    this.#queue = [];
    for (const p of this.#docs.values()) p.then((d) => d.destroy()).catch(() => {});
    this.#docs.clear();
  }

  /**
   * Draws the PDF background of a tile into ctx (unit: mm, origin at the tile top).
   * Returns at once: when a sharper render is ready, done() asks for a redraw.
   */
  paint(ctx, page, tile, s, dpr, done) {
    const w = page.size.widthMm;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, tile.hMm);
    const px = Math.min(MAX_PX_PER_MM, s * dpr);
    const key = `${page.pdf.file}#${page.pdf.pageIndex}|${px.toFixed(3)}|${tile.y0Mm.toFixed(2)}|${tile.hMm.toFixed(2)}`;
    const ready = this.#tiles.get(tile);
    if (ready?.key === key) {
      ctx.drawImage(ready.canvas, 0, 0, w, tile.hMm);
      return;
    }
    // Placeholder: the whole page at low resolution, then a request for this region.
    const lowKey = `${page.pdf.file}#${page.pdf.pageIndex}`;
    const low = this.#low.get(lowKey);
    if (low instanceof HTMLCanvasElement) {
      ctx.drawImage(low, 0, (tile.y0Mm / page.size.heightMm) * low.height, low.width, (tile.hMm / page.size.heightMm) * low.height, 0, 0, w, tile.hMm);
    } else if (!low) {
      const p = this.doc(page.pdf.file)
        .then((d) => renderRegion(d, page.pdf.pageIndex, LOW_PX_PER_MM, 0, page.size.heightMm, w))
        .then((c) => { this.#low.set(lowKey, c); if (!this.disposed) done(); })
        .catch(() => this.#low.delete(lowKey));
      this.#low.set(lowKey, p);
    }
    tile.pdfWant = key;
    if (this.#queue.some((q) => q.tile === tile && q.key === key)) return;
    this.#queue = this.#queue.filter((q) => q.tile !== tile);
    this.#queue.unshift({ tile, key, page, px, done });
    this.#run();
  }

  async #run() {
    if (this.#busy || this.disposed) return;
    this.#busy = true;
    while (this.#queue.length && !this.disposed) {
      const q = this.#queue.shift();
      if (q.tile.pdfWant !== q.key || !q.tile.canvas.isConnected) continue;
      try {
        const d = await this.doc(q.page.pdf.file);
        const canvas = await renderRegion(d, q.page.pdf.pageIndex, q.px, q.tile.y0Mm, q.tile.hMm, q.page.size.widthMm);
        if (q.tile.pdfWant !== q.key) continue;
        this.#tiles.set(q.tile, { key: q.key, canvas });
        q.done();
      } catch {
        // Missing or broken PDF: the page stays white (the error is shown by the editor).
      }
    }
    this.#busy = false;
  }
}
