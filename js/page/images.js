// Image objects on a page.
//
// { id, type: 'image', x, y, w, h, rotation, z, locked,
//   file,        // original in attachments/ (never changed)
//   view,        // display copy, long side ≤ 2560 px (what the app draws and exports)
//   natW, natH,  // pixel size of the original
//   crop,        // null or { x, y, w, h } as fractions of the image (0–1)
//   opacity }    // 0–1
import { objectUrl } from '../local/files.js';

export const VIEW_MAX_PX = 2560;
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Reads an image file: decoded size and a display copy (JPEG, or PNG when the original
 * may be transparent), with the camera orientation applied.
 */
export async function prepareImage(blob) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const natW = bmp.width, natH = bmp.height;
  const k = Math.min(1, VIEW_MAX_PX / Math.max(natW, natH));
  const w = Math.max(1, Math.round(natW * k)), h = Math.max(1, Math.round(natH * k));
  const transparent = /png|webp|gif|svg/i.test(blob.type);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!transparent) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const view = await canvas.convertToBlob(transparent ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.88 });
  return { natW, natH, view, viewExt: transparent ? 'png' : 'jpg' };
}

/** Extension for an image MIME type (for the stored original). */
export function imageExt(blob, fallbackName = '') {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(fallbackName)?.[1]?.toLowerCase();
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/avif': 'avif' };
  return map[blob.type] || fromName || 'jpg';
}

/** A new image object fitted on a page (max 80 % of the width / 60 % of the height). */
export function makeImageObject(id, { file, view, natW, natH }, page, at = null, z = 1) {
  const maxW = page.size.widthMm * 0.8, maxH = page.size.heightMm * 0.6;
  const k = Math.min(maxW / natW, maxH / natH);
  const w = r2(natW * k), h = r2(natH * k);
  const x = at ? at[0] - w / 2 : (page.size.widthMm - w) / 2;
  const y = at ? at[1] - h / 2 : Math.min(page.size.heightMm * 0.15, page.size.heightMm - h);
  return {
    id, type: 'image', x: r2(Math.max(0, x)), y: r2(Math.max(0, y)), w, h, rotation: 0, z, locked: false,
    file, view, natW, natH, crop: null, opacity: 1,
  };
}

const cropOf = (o) => o.crop || { x: 0, y: 0, w: 1, h: 1 };

/** DOM element (follows the zoom like text boxes: mm × --s). */
export function createImageEl(obj, noteId) {
  const el = document.createElement('div');
  el.className = 'obj obj-image';
  el.dataset.objId = obj.id;
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  el.append(img);
  updateImageEl(el, obj, noteId);
  return el;
}

export function updateImageEl(el, obj, noteId) {
  const c = cropOf(obj);
  el.style.setProperty('--x', obj.x); el.style.setProperty('--y', obj.y);
  el.style.setProperty('--w', obj.w); el.style.setProperty('--h', obj.h);
  el.style.setProperty('--rot', `${obj.rotation || 0}deg`);
  el.style.zIndex = String(10 + (obj.z || 0));
  el.style.opacity = String(obj.opacity ?? 1);
  el.classList.toggle('locked', !!obj.locked);
  // The visible part is the crop rectangle: the whole image is scaled and shifted inside.
  const img = el.firstElementChild;
  img.style.width = `${100 / c.w}%`;
  img.style.height = `${100 / c.h}%`;
  img.style.left = `${(-c.x / c.w) * 100}%`;
  img.style.top = `${(-c.y / c.h) * 100}%`;
  const src = obj.view || obj.file;
  if (img.dataset.src !== src) {
    img.dataset.src = src;
    objectUrl(noteId, src).then((u) => { if (img.dataset.src === src) img.src = u; })
      .catch(() => el.classList.add('missing'));
  }
}

/** Draws an image object into a canvas whose unit is 1 mm (bitmap = decoded view copy). */
export function drawImageObj(ctx, obj, bitmap) {
  if (!bitmap) return;
  const c = cropOf(obj);
  ctx.save();
  ctx.globalAlpha = obj.opacity ?? 1;
  ctx.translate(obj.x + obj.w / 2, obj.y + obj.h / 2);
  if (obj.rotation) ctx.rotate((obj.rotation * Math.PI) / 180);
  ctx.drawImage(bitmap, c.x * bitmap.width, c.y * bitmap.height, c.w * bitmap.width, c.h * bitmap.height, -obj.w / 2, -obj.h / 2, obj.w, obj.h);
  ctx.restore();
}

/** SVG for previews: the display copy referenced next to the preview (previews/ → ../attachments/). */
export function imageSvg(obj) {
  const c = cropOf(obj);
  const src = `../attachments/${encodeURIComponent(obj.view || obj.file)}`;
  const iw = obj.w / c.w, ih = obj.h / c.h;
  const rot = obj.rotation ? ` transform="rotate(${obj.rotation} ${r2(obj.x + obj.w / 2)} ${r2(obj.y + obj.h / 2)})"` : '';
  return `<g${rot}${(obj.opacity ?? 1) < 1 ? ` opacity="${obj.opacity}"` : ''}><svg x="${r2(obj.x)}" y="${r2(obj.y)}" width="${r2(obj.w)}" height="${r2(obj.h)}" viewBox="0 0 ${r2(obj.w)} ${r2(obj.h)}" preserveAspectRatio="none">`
    + `<image href="${src}" x="${r2(-c.x * iw)}" y="${r2(-c.y * ih)}" width="${r2(iw)}" height="${r2(ih)}" preserveAspectRatio="none"/></svg></g>`;
}
