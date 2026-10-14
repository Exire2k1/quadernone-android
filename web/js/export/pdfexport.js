// Esporta PDF (pdf-lib, in the browser).
//
// - PDF-backed pages embed the original PDF page as vectors.
// - Paper, lines, highlighter, handwriting and shapes are drawn as vector paths.
// - Text boxes and images are drawn into high-resolution images and placed on top, so they
//   look exactly as on screen (fonts, rotation, crop).
// - Infinite pages are split into A4-height pages of the same width.
// Drawing order is the screen's: paper / PDF, highlighter, objects by z, handwriting.
import { geometry, isHighlighter } from '../page/ink.js';
import { shapePathD } from '../page/shapes.js';
import { paperFill, lineColor, defaultInk } from '../page/paper.js';
import { drawText, layoutText } from '../page/textmodel.js';
import { drawImageObj } from '../page/images.js';

const PT = 72 / 25.4;              // points per mm
const A4_H = 297;
const TEXT_PX_PER_MM = 12;         // ≈ 300 dpi for text
const IMAGE_MAX_PX_PER_MM = 12;

let lib = null;
const pdfLib = () => (lib ||= import('../../vendor/pdf-lib/pdf-lib.esm.min.js'));

function color(rgbFn, hex) {
  const n = parseInt((hex || '#000000').slice(1, 7), 16);
  return rgbFn(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const canvasBlob = (c, type, q) => new Promise((resolve) => c.toBlob(resolve, type, q));

/** Axis-aligned box (mm) of an object, rotation included. */
function objBox(o, h) {
  const cx = o.x + o.w / 2, cy = o.y + h / 2;
  const a = ((o.rotation || 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const bw = o.w * c + h * s, bh = o.w * s + h * c;
  return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
}

/** Draws fn(ctx) for a box of the page into a canvas at pxPerMm. */
function raster(box, pxPerMm, fn) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(box.w * pxPerMm));
  c.height = Math.max(1, Math.ceil(box.h * pxPerMm));
  const ctx = c.getContext('2d');
  ctx.scale(pxPerMm, pxPerMm);
  ctx.translate(-box.x, -box.y);
  fn(ctx);
  return c;
}

/**
 * note: { title, pages, strokes(pageId) → array, file(name) → Promise<Blob> }
 * Returns the PDF bytes. onProgress(i, n) per page.
 */
export async function exportNotePdf(note, { onProgress } = {}) {
  const { PDFDocument, rgb } = await pdfLib();
  const out = await PDFDocument.create();
  out.setTitle(note.title || 'Quadernone');
  out.setCreator('Quadernone');
  out.setProducer('Quadernone (pdf-lib)');
  const sources = new Map();    // file -> PDFDocument
  const bitmaps = new Map();    // file -> ImageBitmap
  const srcDoc = async (file) => {
    if (!sources.has(file)) sources.set(file, note.file(file).then((b) => b.arrayBuffer()).then((buf) => PDFDocument.load(buf, { ignoreEncryption: true })));
    return sources.get(file);
  };
  const bitmap = async (file) => {
    if (!bitmaps.has(file)) bitmaps.set(file, note.file(file).then((b) => createImageBitmap(b)));
    return bitmaps.get(file);
  };

  for (const [pi, page] of note.pages.entries()) {
    onProgress?.(pi, note.pages.length);
    const W = page.size.widthMm, Hfull = page.size.heightMm;
    const strokes = note.strokes(page.id) || [];
    const objects = [...(page.objects || [])].sort((a, b) => (a.z || 0) - (b.z || 0));
    // Prepare the raster parts once per page (shared by the A4 pieces of an infinite page).
    const ink = defaultInk(page.background);
    const rasters = [];
    for (const o of objects) {
      if (o.type === 'text') {
        const h = Math.max(o.h || 0, layoutText(o).heightMm + 1);
        const box = objBox({ ...o, h }, h);
        const c = raster(box, TEXT_PX_PER_MM, (ctx) => drawText(ctx, { ...o, h }, ink));
        rasters.push({ o, box, bytes: new Uint8Array(await (await canvasBlob(c, 'image/png')).arrayBuffer()), png: true });
      } else if (o.type === 'image') {
        try {
          const bmp = await bitmap(o.view || o.file);
          const cw = (o.crop?.w ?? 1) * bmp.width;
          const px = Math.min(IMAGE_MAX_PX_PER_MM, Math.max(2, cw / o.w));
          const box = objBox(o, o.h);
          const square = !((o.rotation || 0) % 90);
          const c = raster(box, px, (ctx) => drawImageObj(ctx, { ...o, opacity: 1 }, bmp));
          const png = !square || /png|gif|webp/i.test(o.view || o.file);
          const blob = await canvasBlob(c, png ? 'image/png' : 'image/jpeg', 0.9);
          rasters.push({ o, box, bytes: new Uint8Array(await blob.arrayBuffer()), png, opacity: o.opacity ?? 1 });
        } catch { /* missing image: left out */ }
      }
    }
    const embedded = new Map();
    for (const r of rasters) embedded.set(r, r.png ? await out.embedPng(r.bytes) : await out.embedJpg(r.bytes));

    let pdfPage = null;
    if (page.pdf) {
      try {
        const src = await srcDoc(page.pdf.file);
        [pdfPage] = await out.embedPdf(src, [page.pdf.pageIndex]);
      } catch { /* missing PDF: white page */ }
    }

    // Infinite pages: A4-height pieces of the same width.
    const pieces = page.size.preset === 'infinite' ? Math.max(1, Math.ceil(Hfull / A4_H - 0.001)) : 1;
    for (let k = 0; k < pieces; k++) {
      const off = k * A4_H;
      const H = pieces > 1 ? Math.min(A4_H, Hfull - off) : Hfull;
      const p = out.addPage([W * PT, H * PT]);
      const top = (H + off) * PT;   // y of the page's mm origin in PDF points
      const path = (d, opts) => p.drawSvgPath(d, { x: 0, y: top, scale: PT, ...opts });

      if (pdfPage) {
        p.drawPage(pdfPage, { x: 0, y: (H + off - Hfull) * PT, width: W * PT, height: Hfull * PT });
      } else {
        const bg = page.background;
        p.drawRectangle({ x: 0, y: 0, width: W * PT, height: H * PT, color: color(rgb, paperFill(bg)) });
        if (bg.type !== 'blank') {
          const s = bg.spacingMm, lc = color(rgb, lineColor(bg));
          const ys = [];
          for (let y = s; y < Hfull - 0.01; y += s) if (y >= off - 1 && y <= off + H + 1) ys.push(y);
          if (bg.type === 'dotted') {
            for (const y of ys) for (let x = s; x < W - 0.01; x += s) p.drawCircle({ x: x * PT, y: top - y * PT, size: 0.225 * PT, color: lc });
          } else {
            let d = ys.map((y) => `M0 ${y.toFixed(2)}H${W}`).join('');
            if (bg.type === 'grid') for (let x = s; x < W - 0.01; x += s) d += `M${x.toFixed(2)} ${off.toFixed(2)}V${(off + H).toFixed(2)}`;
            if (d) path(d, { borderColor: lc, borderWidth: 0.2 });
          }
        }
      }
      const inPiece = (b) => b[3] >= off && b[1] <= off + H;
      // Highlighter under everything else.
      for (const s of strokes) {
        if (!isHighlighter(s)) continue;
        const g = geometry(s);
        if (g.d && inPiece(g.bbox)) path(g.d, { color: color(rgb, s.color), opacity: Math.min(s.opacity ?? 0.35, 0.6), borderWidth: 0 });
      }
      for (const o of objects) {
        if (o.type === 'shape') {
          const open = o.kind === 'line' || o.kind === 'arrow';
          path(shapePathD(o), {
            borderColor: color(rgb, o.stroke.color), borderWidth: o.stroke.width,
            ...(open || !o.fill ? {} : { color: color(rgb, o.fill) }),
          });
        } else {
          const r = rasters.find((x) => x.o === o);
          if (!r || r.box.y + r.box.h < off || r.box.y > off + H) continue;
          p.drawImage(embedded.get(r), {
            x: r.box.x * PT, y: top - (r.box.y + r.box.h) * PT, width: r.box.w * PT, height: r.box.h * PT,
            ...(r.opacity !== undefined && r.opacity < 1 ? { opacity: r.opacity } : {}),
          });
        }
      }
      for (const s of strokes) {
        if (isHighlighter(s)) continue;
        const g = geometry(s);
        if (g.d && inPiece(g.bbox)) path(g.d, { color: color(rgb, s.color), opacity: s.opacity ?? 1, borderWidth: 0 });
      }
    }
  }
  onProgress?.(note.pages.length, note.pages.length);
  return out.save();
}

/** File name for an exported note (no characters Windows/Android reject). */
export const pdfName = (title) => `${(title || 'Nota').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/[. ]+$/, '').slice(0, 100) || 'Nota'}.pdf`;

/** Hands a file to the browser as a download. */
export function saveFile(bytesOrBlob, name, type = 'application/pdf') {
  const blob = bytesOrBlob instanceof Blob ? bytesOrBlob : new Blob([bytesOrBlob], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Several notes in one .zip (JSZip). items: [{ name, bytes }] */
export async function zipFiles(items) {
  await import('../../vendor/jszip/jszip.min.js');
  const zip = new window.JSZip();
  const used = new Set();
  for (const it of items) {
    let name = it.name, i = 2;
    while (used.has(name.toLowerCase())) name = it.name.replace(/\.pdf$/i, ` (${i++}).pdf`);
    used.add(name.toLowerCase());
    zip.file(name, it.bytes);
  }
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}
