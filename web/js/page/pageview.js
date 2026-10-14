// Page engine: a vertical stack of pages inside a scroller.
//
// - Sizes come from pages.json in mm; `s` is the zoom in CSS px per mm. Page objects
//   use calc(var(--s) * …) so they follow the zoom without being re-created.
// - Virtualisation: every page has a cheap placeholder (keeps the scroll height right);
//   only pages near the viewport get background tiles and their objects mounted.
// - Backgrounds are drawn into canvas tiles (≤ TILE_PX tall), so long "infinite" pages
//   and high zoom stay sharp without giant canvases.
// - Zoom: pinch (two fingers), Ctrl+wheel, or setScale()/fit().
import { drawBackground, paperFill } from './paper.js';
import * as diag from '../diag.js';

export const MM_PER_CSS_PX = 25.4 / 96;          // 100 % zoom = real size on a 96 dpi screen
const PX_100 = 1 / MM_PER_CSS_PX;                 // ≈ 3.78 px per mm
const GAP_PX = 18;
const PAD_PX = 16;
const TILE_PX = 512;
const TILE_BUDGET_PX = 5e6;   // canvas pixels for the tiles around the viewport (see #ratio)
const MIN_S = PX_100 * 0.25, MAX_S = PX_100 * 4;
// Pinch tuning: zoom follows the fingers at a reduced rate (exponent < 1), and only
// after they moved apart/together by a few pixels, so two-finger panning stays a pan.
const PINCH_EXPONENT = 0.65;
const PINCH_DEADZONE_PX = 14;
// Kinetic scrolling after a finger flick.
const FLING_MIN_SPEED = 0.15;     // px/ms
const FLING_TIME_CONSTANT = 325;  // ms

export class PageView extends EventTarget {
  pages = [];
  s = PX_100;
  zoomMode = 'width';       // width | page | custom
  current = 0;
  #els = new Map();         // pageId -> { el, objEl, tilesEl, tiles: Map, mounted }
  #tops = [];
  #lefts = [];
  #raf = 0;
  #pinch = null;

  /**
   * hooks.mount(page, objEl) / hooks.unmount(page, objEl): put the page's objects in objEl.
   */
  constructor(scroller, hooks) {
    super();
    this.scroller = scroller;
    this.hooks = hooks;
    this.stack = document.createElement('div');
    this.stack.className = 'page-stack';
    scroller.append(this.stack);
    // Every listener on the scroller is removed in dispose(): the scroller element stays
    // when another note is opened, and listeners of an old view would move the new pages.
    this.#ac = new AbortController();
    scroller.addEventListener('scroll', () => this.#schedule(), { passive: true, signal: this.#ac.signal });
    this.#ro = new ResizeObserver(() => { if (this.zoomMode !== 'custom') this.fit(this.zoomMode, { keep: true }); else this.layout(); });
    this.#ro.observe(scroller);
    this.#bindZoomGestures();
  }
  #ro;

  #ac;
  #stopFling = () => {};

  dispose() {
    this.disposed = true;
    this.#ac.abort();
    this.#stopFling();
    cancelAnimationFrame(this.#raf);
    this.#ro.disconnect();
    for (const [id, e] of this.#els) this.#unmount(id, e);
    this.stack.remove();
  }

  get pinching() { return !!this.#pinch; }

  get percent() { return Math.round((this.s / PX_100) * 100); }

  setPages(pages) {
    this.pages = pages;
    const ids = new Set(pages.map((p) => p.id));
    for (const [id, e] of this.#els) {
      if (!ids.has(id)) { this.#unmount(id, e); e.el.remove(); this.#els.delete(id); }
    }
    for (const p of pages) {
      if (!this.#els.has(p.id)) {
        const el = document.createElement('div');
        el.className = 'page';
        el.dataset.pageId = p.id;
        const tilesEl = document.createElement('div');
        tilesEl.className = 'page-tiles';
        const objEl = document.createElement('div');
        objEl.className = 'page-objects';
        const inkEl = document.createElement('div');
        inkEl.className = 'page-ink';
        // Layers: background + highlighter, page objects (text, shapes), handwriting.
        el.append(tilesEl, objEl, inkEl);
        this.stack.append(el);
        this.#els.set(p.id, { el, objEl, tilesEl, inkEl, tiles: new Map(), mounted: false });
      }
    }
    this.layout();
  }

  // ------------------------------------------------------------------ layout

  layout() {
    if (this.disposed) return;
    const s = this.s;
    this.stack.style.setProperty('--s', String(s));
    const viewW = this.scroller.clientWidth;
    const maxW = Math.max(0, ...this.pages.map((p) => p.size.widthMm)) * s;
    const stackW = Math.max(viewW, maxW + PAD_PX * 2);
    let y = PAD_PX;
    this.#tops = [];
    this.#lefts = [];
    this.pages.forEach((p, i) => {
      const e = this.#els.get(p.id);
      const w = p.size.widthMm * s, hgt = p.size.heightMm * s;
      this.#tops.push(y);
      this.#lefts.push((stackW - w) / 2);
      // Paper colour underneath, so areas without a drawn tile yet never flash white.
      e.el.style.cssText = `top:${y}px;left:${(stackW - w) / 2}px;width:${w}px;height:${hgt}px;background:${paperFill(p.background)}`;
      e.el.dataset.index = String(i);
      y += hgt + GAP_PX;
    });
    this.stack.style.width = stackW + 'px';
    this.stack.style.height = (y - GAP_PX + PAD_PX * 4) + 'px';
    this.update();
  }

  #schedule() {
    if (this.#raf) return;
    this.#raf = requestAnimationFrame(() => { this.#raf = 0; this.update(); });
  }

  /** Mounts pages near the viewport, unmounts far ones, draws tiles, tracks the current page. */
  update() {
    if (this.disposed) return;
    const top = this.scroller.scrollTop, vh = this.scroller.clientHeight;
    // Mount pages within a screen of the viewport; unmount only when far away
    // (hysteresis), so scrolling back and forth does not rebuild them.
    const lo = top - vh, hi = top + vh * 2;
    const farLo = top - vh * 4, farHi = top + vh * 5;
    const mid = top + vh / 2;
    let current = 0;
    this.pages.forEach((p, i) => {
      const e = this.#els.get(p.id);
      const pt = this.#tops[i], pb = pt + p.size.heightMm * this.s;
      if (pt <= mid) current = i;
      const near = pb >= lo && pt <= hi;
      const far = pb < farLo || pt > farHi;
      if (near && !e.mounted) { this.hooks.mount(p, e.objEl); e.mounted = true; }
      if (far && e.mounted) this.#unmount(p.id, e);
      if (e.mounted) this.#tiles(p, e, pt, top, vh);
    });
    if (current !== this.current) {
      this.current = current;
      this.dispatchEvent(new CustomEvent('pagechange', { detail: current }));
    }
  }

  #unmount(id, e) {
    if (e.mounted) {
      const page = this.pages.find((p) => p.id === id);
      this.hooks.unmount(page, e.objEl);
      e.mounted = false;
    }
    for (const t of e.tiles.values()) removeTile(t);
    e.tiles.clear();
  }

  /**
   * Draws the background tiles of a page near the viewport. Tiles are created when
   * they come within half a screen and kept until they are 3 screens away, so normal
   * scrolling reuses them instead of allocating new canvases.
   */
  /**
   * Background tiles of a page near the viewport. Each tile has two canvases: the
   * paper (with highlighter strokes, drawn under the page objects) and the handwriting
   * (above them). Tiles are created within a quarter screen and kept until half a screen further.
   */
  #tiles(page, e, pageTop, top, vh) {
    const s = this.s;
    const hPx = page.size.heightMm * s, wPx = page.size.widthMm * s;
    const n = Math.ceil(hPx / TILE_PX);
    const dpr = this.#ratio(page);
    const key = bgKey(page);
    const ver = this.inkVersion(page.id);
    if (this.#pinch) {
      // During a pinch the drawn tiles are only stretched, each over the mm range it
      // was drawn for, so they stay aligned with the text; redrawn when the fingers lift.
      for (const tile of e.tiles.values()) setTileCss(tile, `top:${tile.y0Mm * s}px;width:${wPx}px;height:${tile.hMm * s}px`);
      return;
    }
    for (let i = 0; i < n; i++) {
      const t0 = i * TILE_PX, t1 = Math.min(hPx, t0 + TILE_PX);
      const a = pageTop + t0, b = pageTop + t1;
      const needed = b >= top - vh * 0.25 && a <= top + vh * 1.25;
      // Keep range kept small: every tile is up to two canvases (paper + ink) in GPU memory,
      // and running out of it makes the browser drop canvases (black areas).
      const keep = b >= top - vh * 0.5 && a <= top + vh * 1.5;
      let tile = e.tiles.get(i);
      if (!keep) { if (tile) { removeTile(tile); e.tiles.delete(i); } continue; }
      const css = `top:${t0}px;width:${wPx}px;height:${t1 - t0}px`;
      const fresh = tile && tile.s === s && tile.r === dpr && tile.key === key;
      if (fresh && tile.under === ver.under && tile.over === ver.over) { setTileCss(tile, css); continue; }
      if (!needed && !fresh) continue;
      if (!tile) {
        tile = { canvas: document.createElement('canvas'), ink: null };
        tile.canvas.className = 'page-tile';
        this.#watchContext(tile, 'under', tile.canvas);
        e.tilesEl.append(tile.canvas);
        e.tiles.set(i, tile);
      }
      const W = Math.max(1, Math.round(wPx * dpr)), Hh = Math.max(1, Math.round((t1 - t0) * dpr));
      tile.y0Mm = t0 / s;
      tile.hMm = (t1 - t0) / s;
      if (!fresh || tile.under !== ver.under) {
        const c = tile.canvas;
        if (c.width !== W) c.width = W;
        if (c.height !== Hh) c.height = Hh;
        // Not { alpha: false }: if the browser drops this canvas, an opaque one shows black,
        // a transparent one shows the paper colour of the page underneath.
        const ctx = c.getContext('2d');
        ctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
        const clip = fresh && this.#clipBand(ctx, tile, page);   // erasing: only the band that changed
        if (page.pdf && this.hooks.paintPdf) {
          // PDF page: drawn by the PDF painter; a sharper render later redraws this layer.
          this.hooks.paintPdf(ctx, page, tile, s, dpr, () => { tile.under = -1; this.#schedule(); });
        } else drawBackground(ctx, page, tile.y0Mm, tile.hMm);
        this.hooks.drawUnder?.(ctx, page, tile.y0Mm, tile.hMm);
        if (clip) ctx.restore();
      }
      if (!fresh || tile.over !== ver.over) {
        // An ink canvas only for tiles that have handwriting in their range.
        if (this.hooks.hasOver?.(page, tile.y0Mm, tile.hMm)) {
          if (!tile.ink) {
            tile.ink = document.createElement('canvas');
            tile.ink.className = 'page-tile';
            this.#watchContext(tile, 'over', tile.ink);
            e.inkEl.append(tile.ink);
          }
          const c = tile.ink;
          const sized = c.width === W && c.height === Hh;
          if (!sized) { c.width = W; c.height = Hh; }
          const ctx = c.getContext('2d');
          ctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
          const clip = fresh && sized && tile.inkDrawn && this.#clipBand(ctx, tile, page);
          if (clip) ctx.clearRect(0, 0, page.size.widthMm, tile.hMm);   // limited by the clip
          else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, Hh); ctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0); }
          this.hooks.drawOver(ctx, page, tile.y0Mm, tile.hMm);
          if (clip) ctx.restore();
          tile.inkDrawn = true;
        } else if (tile.ink) { tile.ink.remove(); tile.ink = null; }
      }
      tile.band = null;
      tile.css = null;
      setTileCss(tile, css);
      tile.s = s;
      tile.r = dpr;
      tile.key = key;
      tile.under = ver.under;
      tile.over = ver.over;
    }
    for (const [i, tile] of e.tiles) if (i >= n) { removeTile(tile); e.tiles.delete(i); }
  }

  /**
   * Canvas pixels per CSS pixel for a page's tiles. The screen's density (max 2) while it
   * fits; when zoomed in, the tiles (as wide as the whole page) grow with the square of
   * the zoom, and past the GPU's memory the browser drops canvases (black areas, slow
   * redraws). So the tiles near the viewport (~2–3 screens, two layers) are kept within
   * TILE_BUDGET_PX; zoomed in, the writing is already large, so the lower ratio does not show.
   */
  #ratio(page) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const wPx = page.size.widthMm * this.s;
    const vh = this.scroller.clientHeight || window.innerHeight || 800;
    const fit = Math.sqrt(TILE_BUDGET_PX / (4 * vh * wPx));
    return Math.round(Math.max(1, Math.min(dpr, fit)) * 100) / 100;
  }

  /** Clips ctx (tile mm, origin at the tile top) to the tile's changed band. Returns true if clipped. */
  #clipBand(ctx, tile, page) {
    if (!tile.band) return false;
    const a = Math.max(0, tile.band[0] - tile.y0Mm - 1), b = Math.min(tile.hMm, tile.band[1] - tile.y0Mm + 1);
    if (b <= a) return false;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, a, page.size.widthMm, b - a);
    ctx.clip();
    return true;
  }

  /**
   * If the browser drops a canvas (low GPU memory, app in background), it comes back
   * empty: mark that layer stale so the next update redraws it.
   */
  #watchContext(tile, layer, canvas) {
    canvas.addEventListener('contextlost', () => diag.note('contextlost', { layer, w: canvas.width, h: canvas.height, ...this.canvasStats() }));
    canvas.addEventListener('contextrestored', () => {
      diag.note('contextrestored', { layer });
      if (layer === 'under') tile.s = -1; else tile.over = -1;
      this.#schedule();
    });
  }

  // ------------------------------------------------------------------ ink layers

  #inkVer = new Map();   // pageId -> { under, over }

  inkVersion(pageId) {
    let v = this.#inkVer.get(pageId);
    if (!v) { v = { under: 0, over: 0 }; this.#inkVer.set(pageId, v); }
    return v;
  }

  /** The ink of a page changed (erase, undo, …): redraw its tiles. */
  /**
   * The ink of a page changed: redraw its tiles. Optional limits keep erasing fluid:
   * only the layers that changed ('under' = highlighter, 'over' = writing), and only the
   * tiles crossing [y0, y1] mm; other tiles are marked up to date without redrawing.
   */
  invalidateInk(pageId, { under = true, over = true, y0 = -Infinity, y1 = Infinity } = {}) {
    const v = this.inkVersion(pageId);
    const e = this.#els.get(pageId);
    const prev = { under: v.under, over: v.over };
    if (under) v.under++;
    if (over) v.over++;
    if (!(y0 > -Infinity || y1 < Infinity) && e) for (const t of e.tiles.values()) t.band = null;   // whole page
    if (e && (y0 > -Infinity || y1 < Infinity)) {
      for (const t of e.tiles.values()) {
        if (t.y0Mm + t.hMm >= y0 && t.y0Mm <= y1) {
          // Remember the changed band, so only that strip of the tile is redrawn.
          t.band = t.band ? [Math.min(t.band[0], y0), Math.max(t.band[1], y1)] : [y0, y1];
          continue;
        }
        if (under && t.under === prev.under) t.under = v.under;
        if (over && t.over === prev.over) t.over = v.over;
      }
    }
    this.update();
  }

  /**
   * A stroke was added: paint it onto the tiles that already exist instead of
   * redrawing them (keeps pen-up instant on long pages).
   */
  addStroke(pageId, stroke, layer, paint) {
    const e = this.#els.get(pageId);
    const v = this.inkVersion(pageId);
    const page = this.pages.find((p) => p.id === pageId);
    if (!e || !page) return;
    if (layer === 'over' && this.hooks.hasOver && [...e.tiles.values()].some((t) => !t.ink && this.hooks.hasOver(page, t.y0Mm, t.hMm))) {
      v.over++;            // some tiles have no ink canvas yet: let update() create them
      this.update();
      return;
    }
    const oldVer = v[layer];
    v[layer]++;
    for (const tile of e.tiles.values()) {
      if (tile.s !== this.s || tile[layer] !== oldVer) { tile.band = null; continue; }   // stale: update() redraws it all
      const c = layer === 'under' ? tile.canvas : tile.ink;
      if (!c) continue;
      const ctx = c.getContext('2d');
      ctx.setTransform(this.s * tile.r, 0, 0, this.s * tile.r, 0, 0);
      paint(ctx, stroke, tile.y0Mm, tile.hMm);
      tile[layer] = v[layer];
    }
    this.update();
  }

  /** Page index and mm position under a client point (diagnostics). */
  #mmAt(cx, cy) {
    const r = this.scroller.getBoundingClientRect();
    const docX = this.scroller.scrollLeft + cx - r.left, docY = this.scroller.scrollTop + cy - r.top;
    let i = 0;
    for (let k = 0; k < this.#tops.length; k++) if (this.#tops[k] <= docY) i = k;
    return [i, Math.round(((docX - (this.#lefts[i] ?? 0)) / this.s) * 10) / 10, Math.round(((docY - (this.#tops[i] ?? 0)) / this.s) * 10) / 10];
  }

  /** Canvases alive and their size in megapixels (diagnostics). */
  canvasStats() {
    let n = 0, px = 0;
    for (const e of this.#els.values()) for (const t of e.tiles.values()) {
      for (const c of [t.canvas, t.ink]) if (c) { n++; px += c.width * c.height; }
    }
    return { canvases: n, mpx: Math.round(px / 1e5) / 10 };
  }

  /** Client rect of a page element. */
  pageRect(pageId) { return this.#els.get(pageId)?.el.getBoundingClientRect() ?? null; }

  /** Redraw after a background or size change. */
  refreshPage(pageId) {
    const e = this.#els.get(pageId);
    if (!e) return;
    for (const t of e.tiles.values()) t.s = -1;
    this.layout();
  }

  /** Remount a page's objects (after undo/redo or an external change). */
  remountPage(pageId) {
    const e = this.#els.get(pageId);
    const page = this.pages.find((p) => p.id === pageId);
    if (!e || !page || !e.mounted) return;
    this.hooks.unmount(page, e.objEl);
    this.hooks.mount(page, e.objEl);
  }

  objectLayer(pageId) { return this.#els.get(pageId)?.objEl ?? null; }

  // ------------------------------------------------------------------ geometry

  /** Page under a client point: { index, page, xMm, yMm } or null. */
  pageAt(clientX, clientY) {
    for (let i = 0; i < this.pages.length; i++) {
      const r = this.#els.get(this.pages[i].id).el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom && clientX >= r.left && clientX <= r.right) {
        return { index: i, page: this.pages[i], xMm: (clientX - r.left) / this.s, yMm: (clientY - r.top) / this.s };
      }
    }
    return null;
  }

  scrollToPage(i, { smooth = false } = {}) {
    const top = this.#tops[Math.max(0, Math.min(i, this.#tops.length - 1))] - PAD_PX / 2;
    this.scroller.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  }

  /** Scrolls so that the given mm point of a page is visible. */
  revealPoint(index, yMm) {
    const y = this.#tops[index] + yMm * this.s;
    const top = this.scroller.scrollTop, vh = this.scroller.clientHeight;
    if (y < top + 40 || y > top + vh - 80) this.scroller.scrollTo({ top: y - vh / 3 });
  }

  // ------------------------------------------------------------------ zoom

  /** Sets the zoom, keeping the page point under (clientX, clientY) exactly in place. */
  setScale(s, clientX, clientY, { mode = 'custom' } = {}) {
    s = Math.min(MAX_S, Math.max(MIN_S, s));
    const sc = this.scroller;
    const rect = sc.getBoundingClientRect();
    const fx = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const fy = (clientY ?? rect.top + rect.height / 2) - rect.top;
    // Anchor: which page is under the focus point, and where on it (in mm).
    const docX = sc.scrollLeft + fx, docY = sc.scrollTop + fy;
    let idx = 0;
    for (let i = 0; i < this.#tops.length; i++) if (this.#tops[i] <= docY) idx = i;
    const xMm = (docX - (this.#lefts[idx] ?? 0)) / this.s;
    const yMm = (docY - (this.#tops[idx] ?? 0)) / this.s;
    this.s = s;
    this.zoomMode = mode;
    this.layout();
    sc.scrollLeft = (this.#lefts[idx] ?? 0) + xMm * s - fx;
    sc.scrollTop = (this.#tops[idx] ?? 0) + yMm * s - fy;
    this.update();
    this.dispatchEvent(new Event('zoom'));
  }

  fit(mode, { keep = false } = {}) {
    const sc = this.scroller;
    const maxW = Math.max(...this.pages.map((p) => p.size.widthMm), 1);
    const availW = sc.clientWidth - PAD_PX * 2;
    let s;
    if (mode === 'width') s = availW / maxW;
    else if (mode === 'page') {
      const p = this.pages[this.current] || this.pages[0];
      const h = p ? Math.min(p.size.heightMm, p.size.widthMm * 1.5) : 297;
      s = Math.min(availW / maxW, (sc.clientHeight - PAD_PX * 2) / h);
    } else s = PX_100;
    if (keep) { this.s = Math.min(MAX_S, Math.max(MIN_S, s)); this.zoomMode = mode; this.layout(); this.dispatchEvent(new Event('zoom')); return; }
    const cur = this.current;
    this.setScale(s, undefined, undefined, { mode: mode === '100' ? 'custom' : mode });
    if (mode === 'page') this.scrollToPage(cur);
  }

  /**
   * Touch navigation is handled here (the scroller has touch-action: none):
   * one finger pans with kinetic scrolling, two fingers pinch-zoom around their
   * midpoint and pan. Mouse uses the normal wheel/scrollbars; Ctrl+wheel zooms.
   */
  #bindZoomGestures() {
    const sc = this.scroller;
    const signal = this.#ac.signal;
    sc.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setScale(this.s * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    }, { passive: false, signal });

    const pts = new Map();          // pointerId -> { x, y }
    let pan = null;                 // { x, y, samples: [{ t, x, y }] }
    let fling = 0;

    const stopFling = () => { cancelAnimationFrame(fling); fling = 0; };
    this.#stopFling = stopFling;
    const startPan = (p) => { pan = { x: p.x, y: p.y, samples: [{ t: performance.now(), x: p.x, y: p.y }] }; };
    const startPinch = () => {
      const [a, b] = [...pts.values()];
      this.#pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), s0: this.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, active: false };
      this.#pinch.log = { start: this.#mmAt((a.x + b.x) / 2, (a.y + b.y) / 2), zoom0: this.percent, mid0: [Math.round(this.#pinch.mx), Math.round(this.#pinch.my)] };
      pan = null;
      this.dispatchEvent(new Event('pinchstart'));
    };

    // Fingers only: the pen writes (see editor/input.js). A finger the editor claimed
    // (drawing in "Dito e penna" mode) does not pan, but a second finger still pinches;
    // touches recognised as a resting palm are ignored completely.
    sc.addEventListener('pointerdown', (e) => {
      if (this.disposed || e.pointerType !== 'touch' || e.qnPalm) return;
      stopFling();
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, claimed: !!e.qnClaimed });
      if (pts.size === 1) { if (!e.qnClaimed) startPan(pts.get(e.pointerId)); }
      else if (pts.size === 2) startPinch();
    }, { signal });

    sc.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      if (this.#pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        sc.scrollLeft -= mx - this.#pinch.mx;
        sc.scrollTop -= my - this.#pinch.my;
        this.#pinch.mx = mx; this.#pinch.my = my;
        if (!this.#pinch.active && Math.abs(d - this.#pinch.d0) > PINCH_DEADZONE_PX) {
          // Start zooming from here, so the dead zone does not cause a jump.
          this.#pinch.active = true;
          this.#pinch.d0 = d;
          this.#pinch.s0 = this.s;
        }
        if (this.#pinch.active) {
          const target = this.#pinch.s0 * Math.pow(d / this.#pinch.d0, PINCH_EXPONENT);
          if (Math.abs(target - this.s) / this.s > 0.004) this.setScale(target, mx, my);
        }
      } else if (pan) {
        sc.scrollLeft -= p.x - pan.x;
        sc.scrollTop -= p.y - pan.y;
        pan.x = p.x; pan.y = p.y;
        pan.samples.push({ t: performance.now(), x: p.x, y: p.y });
        if (pan.samples.length > 6) pan.samples.shift();
      }
    }, { signal });

    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (this.#pinch && pts.size < 2) {
        // Diagnostics: page point under the fingers at the start and at the end (should match).
        const L = this.#pinch.log, m = [this.#pinch.mx, this.#pinch.my];
        const vv = window.visualViewport;
        diag.note('pinch', { ...L, end: this.#mmAt(m[0], m[1]), mid1: m.map(Math.round), zoom1: this.percent,
          scroll: [Math.round(sc.scrollLeft), Math.round(sc.scrollTop)], vv: vv ? [Math.round(vv.scale * 100) / 100, Math.round(vv.offsetLeft), Math.round(vv.offsetTop)] : null });
        this.#pinch = null;
        this.update();                       // redraw tiles at the final zoom
        this.dispatchEvent(new Event('pinchend'));
        // The finger left on the glass continues as a pan, without a jump.
        if (pts.size === 1 && ![...pts.values()][0].claimed) startPan([...pts.values()][0]);
        return;
      }
      if (pan && pts.size === 0) {
        const s = pan.samples;
        pan = null;
        if (e.type === 'pointercancel' || s.length < 2) return;
        const first = s[0], last = s[s.length - 1];
        const dt = Math.max(1, last.t - first.t);
        if (performance.now() - last.t > 80) return;  // the finger stopped before lifting
        let vx = (last.x - first.x) / dt, vy = (last.y - first.y) / dt;
        if (Math.hypot(vx, vy) < FLING_MIN_SPEED) return;
        let prev = performance.now();
        const step = (now) => {
          const ms = now - prev; prev = now;
          sc.scrollLeft -= vx * ms;
          sc.scrollTop -= vy * ms;
          const k = Math.exp(-ms / FLING_TIME_CONSTANT);
          vx *= k; vy *= k;
          fling = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
        };
        fling = requestAnimationFrame(step);
      }
    };
    sc.addEventListener('pointerup', end, { signal });
    sc.addEventListener('pointercancel', end, { signal });
  }
}

function setTileCss(tile, css) {
  if (tile.css === css) return;
  tile.css = css;
  tile.canvas.style.cssText = css;
  if (tile.ink) tile.ink.style.cssText = css;
}

function removeTile(tile) {
  tile.canvas.remove();
  tile.ink?.remove();
}

function bgKey(p) {
  const b = p.background;
  return `${p.size.widthMm}x${p.size.heightMm}|${b.type}|${b.spacingMm}|${b.lineColor}|${b.paperColor}|${p.pdf ? p.pdf.file + '#' + p.pdf.pageIndex : ''}`;
}
