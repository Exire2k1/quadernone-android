// Crop panel for an image object: the whole image with the visible part as a rectangle
// (drag inside to move it, drag the corners to resize). Returns the new object, with the
// same scale on the page (cropping does not zoom the image), or null if cancelled.
import { h } from '../dom.js';
import { t } from '../i18n.js';
import { openPanel } from '../ui/panel.js';
import { objectUrl } from '../local/files.js';

const MIN = 0.05;
const r4 = (n) => Math.round(n * 10000) / 10000;
const r2 = (n) => Math.round(n * 100) / 100;

export function openCropPanel(obj, noteId) {
  return new Promise((resolve) => {
    let crop = { ...(obj.crop || { x: 0, y: 0, w: 1, h: 1 }) };
    let result = null;
    const img = h('img.crop-img', { alt: '', draggable: false });
    const rect = h('div.crop-rect', {},
      ...['nw', 'ne', 'sw', 'se'].map((c) => h(`div.crop-handle.${c}`, { dataset: { corner: c } })));
    const box = h('div.crop-box', {}, img, rect);
    objectUrl(noteId, obj.view || obj.file).then((u) => { img.src = u; });

    const render = () => {
      rect.style.left = `${crop.x * 100}%`; rect.style.top = `${crop.y * 100}%`;
      rect.style.width = `${crop.w * 100}%`; rect.style.height = `${crop.h * 100}%`;
    };
    render();

    rect.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      rect.setPointerCapture(e.pointerId);
      const b = box.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, crop: { ...crop } };
      const corner = e.target.dataset.corner || null;
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / b.width, dy = (ev.clientY - start.y) / b.height;
        const c = { ...start.crop };
        if (!corner) {
          c.x = Math.min(1 - c.w, Math.max(0, c.x + dx));
          c.y = Math.min(1 - c.h, Math.max(0, c.y + dy));
        } else {
          let x0 = c.x, y0 = c.y, x1 = c.x + c.w, y1 = c.y + c.h;
          if (corner.includes('w')) x0 = Math.min(x1 - MIN, Math.max(0, x0 + dx));
          if (corner.includes('e')) x1 = Math.max(x0 + MIN, Math.min(1, x1 + dx));
          if (corner.includes('n')) y0 = Math.min(y1 - MIN, Math.max(0, y0 + dy));
          if (corner.includes('s')) y1 = Math.max(y0 + MIN, Math.min(1, y1 + dy));
          Object.assign(c, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
        }
        crop = c;
        render();
      };
      const up = () => { rect.removeEventListener('pointermove', move); rect.removeEventListener('pointerup', up); rect.removeEventListener('pointercancel', up); };
      rect.addEventListener('pointermove', move);
      rect.addEventListener('pointerup', up);
      rect.addEventListener('pointercancel', up);
    });

    const p = openPanel({
      title: t('image.crop'),
      variant: 'dialog',
      className: 'crop-panel',
      body: [h('p.hint', {}, t('image.cropHint')), box],
      footer: [
        h('button.btn', { type: 'button', onclick: () => { crop = { x: 0, y: 0, w: 1, h: 1 }; render(); } }, t('image.cropReset')),
        h('button.btn', { type: 'button', onclick: () => p.close() }, t('common.cancel')),
        h('button.btn.primary', { type: 'button', onclick: () => {
          const old = obj.crop || { x: 0, y: 0, w: 1, h: 1 };
          // Same page scale: mm per image fraction stays as before.
          const kx = obj.w / old.w, ky = obj.h / old.h;
          const full = crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1;
          result = {
            ...obj,
            x: r2(obj.x + (crop.x - old.x) * kx), y: r2(obj.y + (crop.y - old.y) * ky),
            w: r2(crop.w * kx), h: r2(crop.h * ky),
            crop: full ? null : { x: r4(crop.x), y: r4(crop.y), w: r4(crop.w), h: r4(crop.h) },
          };
          p.close();
        } }, t('common.ok')),
      ],
      onClose: () => resolve(result),
    });
  });
}
