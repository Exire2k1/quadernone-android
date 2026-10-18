// Renders a page into a canvas (thumbnails in the Pagine panel, the auto cover).
import { drawBackground, defaultInk } from './paper.js';
import { drawText } from './textmodel.js';
import { drawStrokes } from './ink.js';
import { drawShape } from './shapes.js';
import { drawImageObj } from './images.js';

/** Draws the page scaled to widthPx. For tall (infinite) pages only the top maxAspect×width is drawn. */
/** images: Map objId -> decoded image; pdf: a render of the PDF page (for PDF-backed pages). */
export function renderPageCanvas(page, widthPx, { maxAspect = 1.5, dpr = 1, strokes = [], images = null, pdf = null } = {}) {
  const pxPerMm = widthPx / page.size.widthMm;
  const hMm = Math.min(page.size.heightMm, page.size.widthMm * maxAspect);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(widthPx * dpr);
  canvas.height = Math.round(hMm * pxPerMm * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(pxPerMm * dpr, pxPerMm * dpr);
  if (page.pdf) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, page.size.widthMm, hMm);
    if (pdf) ctx.drawImage(pdf, 0, 0, page.size.widthMm, page.size.heightMm);
  } else drawBackground(ctx, page, 0, hMm);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, page.size.widthMm, hMm); ctx.clip();
  const ink = defaultInk(page.background);
  drawStrokes(ctx, strokes, 'under');
  for (const o of [...(page.objects || [])].sort((a, b) => (a.z || 0) - (b.z || 0))) {
    if (o.type === 'text') drawText(ctx, o, ink);
    else if (o.type === 'shape') drawShape(ctx, o);
    else if (o.type === 'image') drawImageObj(ctx, o, images?.get(o.id));
  }
  drawStrokes(ctx, strokes, 'over');
  ctx.restore();
  return canvas;
}

/** cover.png for the Library: first page, about 400 px wide. */
export function renderCoverPng(page, strokes = [], extra = {}) {
  const canvas = renderPageCanvas(page, 400, { maxAspect: 297 / 210, strokes, ...extra });
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** cover.png from an image chosen as cover: centre-cropped to the cover shape, 400 px wide. */
export function renderImageCover(bitmap) {
  const W = 400, H = Math.round(400 * 297 / 210);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  const k = Math.max(W / bitmap.width, H / bitmap.height);
  const w = bitmap.width * k, h = bitmap.height * k;
  ctx.drawImage(bitmap, (W - w) / 2, (H - h) / 2, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
