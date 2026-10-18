// Lasso selection: strokes and page objects on one page, with a frame to move, scale
// and rotate them, and a contextual bar (colour, width, copy, cut, duplicate, delete,
// order, convert to shape, move to another page).
import { h, iconButton } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { transformStroke, strokesBBox, newStrokeId, strokesSvg, isHighlighter } from '../page/ink.js';
import { transformShape, recognize, makeShape } from '../page/shapes.js';
import { openMenu } from '../ui/menu.js';
import { promptDialog } from '../ui/panel.js';
import { toast } from '../ui/toast.js';
import { tools, QUICK_COLORS } from './tools.js';

const newObjId = () => 'ob-' + [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
const WIDTHS_PT = [0.5, 1, 1.6, 2.4, 3.2, 5, 8, 12];
let clipboard = null;   // { strokes, objects } (deep copies, page mm)

/** Something was copied with the lasso (Ctrl+V pastes it instead of the system clipboard). */
export const hasClipboard = () => !!clipboard;

function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export class Selection extends EventTarget {
  active = null;   // { pageId, strokeIds: Set, objectIds: Set, bbox }

  /** onImage(kind, obj, page): 'crop' | 'cover' (handled by the editor). */
  constructor({ doc, view, getInput, onImage = () => {} }) {
    super();
    Object.assign(this, { doc, view, getInput, onImage });
    this.frame = h('div.sel-frame', {},
      h('div.sel-handle.sel-rotate', { dataset: { kind: 'rotate' } }),
      h('div.sel-handle.sel-scale', { dataset: { kind: 'scale' } }));
    this.frame.addEventListener('pointerdown', (e) => this.#startTransform(e));
    this.bar = this.#buildBar();
  }

  get page() { return this.doc.list.find((p) => p.id === this.active?.pageId); }

  #strokes() { return this.doc.strokes(this.active.pageId).filter((s) => this.active.strokeIds.has(s.id)); }
  #objects() { return (this.page?.objects || []).filter((o) => this.active.objectIds.has(o.id)); }

  // ------------------------------------------------------------------ selecting

  select(pageId, poly, filter = 'all') {
    const page = this.doc.list.find((p) => p.id === pageId);
    const strokeIds = new Set(), objectIds = new Set();
    if (filter === 'all' || filter === 'ink') {
      for (const s of this.doc.strokes(pageId)) {
        const pts = s.points, step = Math.max(1, Math.floor(pts.length / 30));
        let n = 0, ins = 0;
        for (let i = 0; i < pts.length; i += step) { n++; if (inside(poly, pts[i][0], pts[i][1])) ins++; }
        if (n && ins / n >= 0.5) strokeIds.add(s.id);
      }
    }
    for (const o of page?.objects || []) {
      if (o.locked) continue;   // locked objects are selected by tapping them
      const want = filter === 'all' || (filter === 'text' && o.type === 'text') || (filter === 'images' && o.type === 'image');
      if (want && inside(poly, o.x + o.w / 2, o.y + (o.h || 0) / 2)) objectIds.add(o.id);
    }
    if (!strokeIds.size && !objectIds.size) { this.clear(); return; }
    this.setSelection(pageId, strokeIds, objectIds);
  }

  setSelection(pageId, strokeIds, objectIds) {
    this.active = { pageId, strokeIds, objectIds, bbox: null };
    this.#refreshFrame();
    this.dispatchEvent(new Event('change'));
  }

  clear() {
    if (!this.active) return;
    this.active = null;
    this.frame.remove();
    this.dispatchEvent(new Event('change'));
  }

  #bbox() {
    let [x0, y0, x1, y1] = this.#strokes().length ? strokesBBox(this.#strokes()) : [Infinity, Infinity, -Infinity, -Infinity];
    for (const o of this.#objects()) {
      x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y);
      x1 = Math.max(x1, o.x + o.w); y1 = Math.max(y1, o.y + (o.h || 0));
    }
    return [x0, y0, x1, y1];
  }

  #refreshFrame() {
    if (!this.active) return;
    if (!this.#strokes().length && !this.#objects().length) { this.clear(); return; }
    const b = this.#bbox();
    this.active.bbox = b;
    const pageEl = this.view.objectLayer(this.active.pageId)?.parentElement;
    if (!pageEl) { this.frame.remove(); return; }
    if (this.frame.parentElement !== pageEl) pageEl.append(this.frame);
    this.frame.style.setProperty('--x', b[0]); this.frame.style.setProperty('--y', b[1]);
    this.frame.style.setProperty('--w', b[2] - b[0]); this.frame.style.setProperty('--h', b[3] - b[1]);
    this.frame.style.transform = '';
    this.frame.style.transformOrigin = '';
  }

  // ------------------------------------------------------------------ move / scale / rotate

  #startTransform(e) {
    if (!this.active || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (this.#objects().some((o) => o.locked)) { e.stopPropagation(); e.qnClaimed = true; toast(t('image.lockedHint'), { duration: 1800 }); return; }
    e.preventDefault();
    e.stopPropagation();
    e.qnClaimed = true;
    const kind = e.target.dataset.kind || 'move';
    this.frame.setPointerCapture(e.pointerId);
    const s = this.view.s;
    const [x0, y0, x1, y1] = this.active.bbox;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const r = this.view.pageRect(this.active.pageId);
    const toMm = (ev) => [(ev.clientX - r.left) / s, (ev.clientY - r.top) / s];
    const start = toMm(e);
    const input = this.getInput();
    const strokes = this.#strokes();
    const objs = this.#objects();
    const els = objs.map((o) => this.view.objectLayer(this.active.pageId)?.querySelector(`[data-obj-id="${o.id}"]`)).filter(Boolean);
    input.hiddenStrokes = { pageId: this.active.pageId, ids: new Set(strokes.map((x) => x.id)) };
    this.view.invalidateInk(this.active.pageId);
    let m = new DOMMatrix(), k = 1, ang = 0;

    // Strokes being moved: drawn once in the overlay, then only its transform changes.
    input.overlayToPage(this.active.pageId);
    input.setOverlay(strokesSvg(strokes, 'under') + strokesSvg(strokes, 'over'));
    const preview = () => {
      input.setOverlayMatrix(m);
      for (const el of els) {
        // Transform around the page origin: the element's own top-left is at (--x, --y) mm.
        const o = objs.find((x) => x.id === el.dataset.objId);
        const ex = parseFloat(el.style.getPropertyValue('--x')), ey = parseFloat(el.style.getPropertyValue('--y'));
        el.style.transformOrigin = `${-(Number.isFinite(ex) ? ex : o.x) * s}px ${-(Number.isFinite(ey) ? ey : o.y) * s}px`;
        el.style.transform = `matrix(${m.a},${m.b},${m.c},${m.d},${m.e * s},${m.f * s})`;
      }
      // Same trick for the frame: transform around the page origin.
      this.frame.style.transformOrigin = `${-x0 * s}px ${-y0 * s}px`;
      this.frame.style.transform = `matrix(${m.a},${m.b},${m.c},${m.d},${m.e * s},${m.f * s})`;
    };

    const move = (ev) => {
      const p = toMm(ev);
      if (kind === 'move') {
        m = new DOMMatrix().translate(p[0] - start[0], p[1] - start[1]);
      } else if (kind === 'scale') {
        const d0 = Math.hypot(start[0] - x0, start[1] - y0), d1 = Math.hypot(p[0] - x0, p[1] - y0);
        k = Math.max(0.1, Math.min(10, d1 / Math.max(1, d0)));
        m = new DOMMatrix().translate(x0, y0).scale(k).translate(-x0, -y0);
      } else {
        ang = Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(start[1] - cy, start[0] - cx);
        const deg = ang * 180 / Math.PI;
        const snapped = Math.abs(deg % 90) < 3 ? Math.round(deg / 90) * 90 : deg;
        ang = snapped * Math.PI / 180;
        m = new DOMMatrix().translate(cx, cy).rotate(snapped).translate(-cx, -cy);
      }
      preview();
    };
    const up = () => {
      this.frame.removeEventListener('pointermove', move);
      this.frame.removeEventListener('pointerup', up);
      this.frame.removeEventListener('pointercancel', up);
      input.clearOverlay();
      input.hiddenStrokes = null;
      for (const el of els) { el.style.transform = ''; el.style.transformOrigin = ''; }
      if (!m.isIdentity) this.#applyMatrix(m, k, ang * 180 / Math.PI);
      else { this.view.invalidateInk(this.active.pageId); this.#refreshFrame(); }
    };
    this.frame.addEventListener('pointermove', move);
    this.frame.addEventListener('pointerup', up);
    this.frame.addEventListener('pointercancel', up);
  }

  #applyMatrix(m, k, deg) {
    const pageId = this.active.pageId;
    const page = this.page;
    this.doc.transact(() => {
      this.doc.setInk(pageId, this.doc.strokes(pageId).map((s) => (this.active.strokeIds.has(s.id) ? transformStroke(s, m, k) : s)));
      page.objects = page.objects.map((o) => {
        if (!this.active.objectIds.has(o.id)) return o;
        if (o.type === 'shape') return transformShape(o, m, k);
        const c = m.transformPoint({ x: o.x + o.w / 2, y: o.y + (o.h || 0) / 2 });
        const w = o.w * k, hh = (o.h || 0) * k;
        const out = { ...o, x: r2(c.x - w / 2), y: r2(c.y - hh / 2), w: r2(w), h: r2(hh), rotation: r2(((o.rotation || 0) + deg) % 360) };
        if (o.type === 'text' && k !== 1) out.style = { ...o.style, sizePt: Math.max(4, Math.round((o.style?.sizePt || 12) * k * 2) / 2) };
        return out;
      });
    });
    this.#afterEdit(pageId);
  }

  #afterEdit(pageId) {
    this.view.invalidateInk(pageId);
    this.view.remountPage(pageId);
    this.#refreshFrame();
  }

  // ------------------------------------------------------------------ bar actions

  setColor(c) {
    const pageId = this.active.pageId, page = this.page;
    this.doc.transact(() => {
      this.doc.setInk(pageId, this.doc.strokes(pageId).map((s) => (this.active.strokeIds.has(s.id) ? { ...s, color: c } : s)));
      page.objects = page.objects.map((o) => {
        if (!this.active.objectIds.has(o.id)) return o;
        if (o.type === 'shape') return { ...o, stroke: { ...o.stroke, color: c } };
        if (o.type === 'text') return { ...o, style: { ...o.style, color: c } };
        return o;
      });
    });
    this.#afterEdit(pageId);
  }

  setWidth(pt) {
    const pageId = this.active.pageId;
    const mm = pt * 0.3528;
    this.doc.setInk(pageId, this.doc.strokes(pageId).map((s) => (this.active.strokeIds.has(s.id) && !isHighlighter(s) ? { ...s, width: mm } : s)));
    this.#afterEdit(pageId);
  }

  /** The selection is exactly one image (the image bar is shown). */
  get image() {
    if (!this.active || this.active.strokeIds.size || this.active.objectIds.size !== 1) return null;
    const o = this.#objects()[0];
    return o?.type === 'image' ? o : null;
  }

  #updateObject(id, fn) {
    const pageId = this.active.pageId, page = this.page;
    this.doc.transact(() => { page.objects = page.objects.map((o) => (o.id === id ? fn({ ...o }) : o)); });
    this.#afterEdit(pageId);
    this.dispatchEvent(new Event('change'));
  }

  rotate90() {
    const img = this.image;
    if (img && !img.locked) this.#updateObject(img.id, (o) => ({ ...o, rotation: ((o.rotation || 0) + 90) % 360 }));
  }

  setOpacity(v) {
    const img = this.image;
    if (img) this.#updateObject(img.id, (o) => ({ ...o, opacity: v }));
  }

  toggleLock() {
    const img = this.image;
    if (img) this.#updateObject(img.id, (o) => ({ ...o, locked: !o.locked }));
  }

  /** Replaces one object (e.g. after cropping) as one undo step. */
  replaceObject(obj) { this.#updateObject(obj.id, () => obj); }

  copy() {
    clipboard = { strokes: structuredClone(this.#strokes()), objects: structuredClone(this.#objects()) };
    toast(t('sel.copied'), { duration: 1500 });
  }

  cut() { this.copy(); this.remove(); }

  remove() {
    const pageId = this.active.pageId, page = this.page;
    this.doc.transact(() => {
      this.doc.setInk(pageId, this.doc.strokes(pageId).filter((s) => !this.active.strokeIds.has(s.id)));
      page.objects = page.objects.filter((o) => !this.active.objectIds.has(o.id));
    });
    this.view.invalidateInk(pageId);
    this.view.remountPage(pageId);
    this.clear();
  }

  duplicate() {
    clipboard = { strokes: structuredClone(this.#strokes()), objects: structuredClone(this.#objects()) };
    this.paste(this.active.pageId, 6);
  }

  /** Pastes the clipboard on a page (offset in mm), and selects what was pasted. */
  paste(pageId, offset = 6) {
    if (!clipboard) return;
    const page = this.doc.list.find((p) => p.id === pageId);
    const m = new DOMMatrix().translate(offset, offset);
    const strokes = clipboard.strokes.map((s) => ({ ...transformStroke(s, m), id: newStrokeId() }));
    let z = Math.max(0, ...(page.objects || []).map((o) => o.z || 0));
    const objects = clipboard.objects.map((o) => {
      const moved = o.type === 'shape' ? transformShape(o, m) : { ...structuredClone(o), x: o.x + offset, y: o.y + offset };
      return { ...moved, id: newObjId(), z: ++z };
    });
    this.doc.transact(() => {
      this.doc.setInk(pageId, [...this.doc.strokes(pageId), ...strokes]);
      page.objects = [...(page.objects || []), ...objects];
    });
    this.view.invalidateInk(pageId);
    this.view.remountPage(pageId);
    this.setSelection(pageId, new Set(strokes.map((s) => s.id)), new Set(objects.map((o) => o.id)));
  }

  /** Bring forward (+1) / send backward (-1): objects by z, strokes by drawing order. */
  order(dir) {
    const pageId = this.active.pageId, page = this.page;
    this.doc.transact(() => {
      const all = this.doc.strokes(pageId);
      const sel = all.filter((s) => this.active.strokeIds.has(s.id)), rest = all.filter((s) => !this.active.strokeIds.has(s.id));
      if (sel.length) this.doc.setInk(pageId, dir > 0 ? [...rest, ...sel] : [...sel, ...rest]);
      const objs = [...(page.objects || [])].sort((a, b) => (a.z || 0) - (b.z || 0));
      const chosen = objs.filter((o) => this.active.objectIds.has(o.id)), others = objs.filter((o) => !this.active.objectIds.has(o.id));
      const ordered = dir > 0 ? [...others, ...chosen] : [...chosen, ...others];
      page.objects = ordered.map((o, i) => ({ ...o, z: i + 1 }));
    });
    this.#afterEdit(pageId);
  }

  toShape() {
    const strokes = this.#strokes();
    if (!strokes.length) return;
    const pts = strokes.length === 1 ? strokes[0].points : strokes.flatMap((s) => s.points);
    const rec = recognize(pts);
    if (!rec) { toast(t('sel.noShape')); return; }
    const pageId = this.active.pageId, page = this.page;
    const z = Math.max(0, ...(page.objects || []).map((o) => o.z || 0)) + 1;
    const obj = makeShape(rec.kind, rec.points, { color: strokes[0].color, width: Math.max(0.2, strokes[0].width * 0.7) }, z);
    this.doc.transact(() => {
      this.doc.setInk(pageId, this.doc.strokes(pageId).filter((s) => !this.active.strokeIds.has(s.id)));
      page.objects = [...(page.objects || []), obj];
    });
    this.view.invalidateInk(pageId);
    this.view.remountPage(pageId);
    this.setSelection(pageId, new Set(), new Set([obj.id]));
  }

  async moveToPage() {
    const n = this.doc.list.length;
    const v = await promptDialog({ title: t('sel.moveToPage'), label: t('sel.pageNumber', { n }), value: '' });
    const idx = Number(v) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= n) return;
    const from = this.page, to = this.doc.list[idx];
    if (!from || to.id === from.id) return;
    const strokes = this.#strokes(), objs = this.#objects();
    this.doc.transact(() => {
      this.doc.setInk(from.id, this.doc.strokes(from.id).filter((s) => !this.active.strokeIds.has(s.id)));
      this.doc.setInk(to.id, [...this.doc.strokes(to.id), ...strokes]);
      from.objects = from.objects.filter((o) => !this.active.objectIds.has(o.id));
      to.objects = [...(to.objects || []), ...objs];
    });
    for (const p of [from, to]) { this.view.invalidateInk(p.id); this.view.remountPage(p.id); }
    this.clear();
    this.view.scrollToPage(idx, { smooth: true });
  }

  #buildBar() {
    const keep = (fn) => ({ onclick: fn });
    const colorBtn = h('button.tb-btn.tb-color', { type: 'button', title: t('text.color'), 'aria-label': t('text.color'), ...keep((e) => this.#colorMenu(e.currentTarget)) }, h('span.color-dot'));
    const widthBtn = h('button.tb-btn.tb-select', { type: 'button', title: t('sel.width'), ...keep((e) => this.#widthMenu(e.currentTarget)) }, t('sel.width'));
    const lockBtn = iconButton('lock', t('image.lock'), () => this.toggleLock());
    const imageGroup = h('div.tb-group.image-group', {},
      iconButton('crop', t('image.crop'), () => this.image && !this.image.locked && this.onImage('crop', this.image, this.page)),
      iconButton('rotate', t('image.rotate'), () => this.rotate90()),
      iconButton('opacity', t('image.opacity'), (e) => this.#opacityMenu(e.currentTarget)),
      lockBtn,
      iconButton('cover', t('image.setCover'), () => this.image && this.onImage('cover', this.image, this.page)));
    const inkGroup = h('div.tb-group', {}, colorBtn, widthBtn);
    const bar = h('div.textbar.selbar', { role: 'toolbar', 'aria-label': t('sel.bar') },
      imageGroup, inkGroup,
      h('div.tb-group', {},
        iconButton('copy', t('sel.copy'), () => this.copy()),
        iconButton('cut', t('sel.cut'), () => this.cut()),
        iconButton('duplicate', t('sel.duplicate'), () => this.duplicate())),
      h('div.tb-group', {},
        iconButton('forward', t('sel.forward'), () => this.order(1)),
        iconButton('backward', t('sel.backward'), () => this.order(-1)),
        iconButton('shapes', t('sel.toShape'), () => this.toShape()),
        iconButton('pageMove', t('sel.moveToPage'), () => this.moveToPage())),
      h('div.tb-group', {},
        iconButton('trash', t('common.delete'), () => this.remove(), { class: 'danger' }),
        iconButton('close', t('common.close'), () => this.clear())));
    this.addEventListener('change', () => {
      if (!this.active) return;
      const first = this.#strokes()[0] || this.#objects()[0];
      colorBtn.querySelector('.color-dot').style.background = first?.color || first?.stroke?.color || first?.style?.color || '#1A1A1A';
      widthBtn.hidden = !this.#strokes().length;
      const img = this.image;
      imageGroup.hidden = !img;
      inkGroup.hidden = !!img;
      if (img) {
        lockBtn.replaceChildren(icon(img.locked ? 'unlock' : 'lock'));
        lockBtn.title = t(img.locked ? 'image.unlock' : 'image.lock');
        lockBtn.setAttribute('aria-label', lockBtn.title);
        lockBtn.classList.toggle('active', !!img.locked);
      }
    });
    return bar;
  }

  #colorMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const colors = [...new Set([...tools.s.quickColors, ...QUICK_COLORS])].slice(0, 12);
    const menu = h('div.menu.color-menu', {},
      h('div.swatches', {}, colors.map((c) => h('button.swatch.sm', { type: 'button', style: { background: c }, 'aria-label': c, onclick: () => { menu.remove(); this.setColor(c); } }))));
    document.body.append(menu);
    menu.style.left = Math.min(r.left, innerWidth - 260) + 'px';
    menu.style.top = r.bottom + 4 + 'px';
    const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  }

  #opacityMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, [1, 0.75, 0.5, 0.25].map((v) => ({ label: `${Math.round(v * 100)}%`, action: () => this.setOpacity(v) })), { title: t('image.opacity') });
  }

  #widthMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, WIDTHS_PT.map((pt) => ({ label: `${pt} pt`, action: () => this.setWidth(pt) })), { title: t('sel.width') });
  }
}

const r2 = (n) => Math.round(n * 100) / 100;
