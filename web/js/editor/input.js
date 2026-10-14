// Pen, finger and mouse input on the pages (Pointer Events).
//
// - The pen writes with the active tool; its eraser end always erases.
// - Side button (if enabled): short press = pen ⇄ eraser, hold = lasso while held.
// - Fingers navigate (page view), or also draw in "Dito e penna" mode.
// - Palm rejection: touches are ignored while a pen is in use or hovering, and large
//   contact areas are ignored always.
// - Two-finger double tap = undo, three-finger double tap = redo.
// The live stroke is drawn on an overlay canvas and committed to the page on pen-up.
import { tools } from './tools.js';
import { PressureTrack } from './pressure.js';
import { liveSvg, eraseArea, strokeHit, newStrokeId, isHighlighter, drawStrokes, quickBBox } from '../page/ink.js';
import { recognize, makeShape, shapeFromDrag, shapeSvg } from '../page/shapes.js';
import * as diag from '../diag.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
import { INFINITE_MARGIN_MM } from './objects.js';

const PALM_AFTER_PEN_MS = 700;
const PALM_CONTACT_PX = 46;
const MIN_POINT_MM = 0.12;
const SHAPE_HOLD_MS = 500;
const HOVER_PRESS_MIN_MS = 80;   // see #actionFor

export class InkInput extends EventTarget {
  #stroke = null;        // action in progress
  #raf = 0;
  #penActiveUntil = 0;
  #penDown = false;
  #hoverBtn = null;      // side button pressed while hovering
  #taps = null;          // multi-finger tap detection
  #lastTap = null;
  hiddenStrokes = null;  // { pageId, ids:Set } hidden while the selection is transformed
  erasing = null;        // { pageId, strokes } preview while erasing
  pickColor = null;      // eyedropper without the EyeDropper API: callback(color) for the next tap

  constructor({ stage, view, doc, ruler, selection, onUndo, onRedo, onPenStroke }) {
    super();
    Object.assign(this, { stage, view, doc, ruler, selection, onUndo, onRedo, onPenStroke });
    // The stroke being drawn is shown in a vector layer (SVG) over the stage, redrawn at most
    // once per frame. A full-screen canvas was used before: on some Android tablets it showed
    // black over the page while the pen was down.
    this.overlay = document.createElementNS(SVG_NS, 'svg');
    this.overlay.setAttribute('class', 'ink-overlay');
    this.ovPage = document.createElementNS(SVG_NS, 'g');      // page mm -> stage px
    this.ovContent = document.createElementNS(SVG_NS, 'g');   // extra transform (selection drag)
    this.ovPage.append(this.ovContent);
    this.overlay.append(this.ovPage);
    stage.append(this.overlay);
    const st = view.stack;
    this.ac = new AbortController();
    const o = { signal: this.ac.signal, capture: true };
    st.addEventListener('pointerdown', (e) => this.#down(e), o);
    st.addEventListener('pointermove', (e) => this.#move(e), o);
    st.addEventListener('pointerup', (e) => this.#up(e), o);
    st.addEventListener('pointercancel', (e) => this.#cancel(e), o);
    // Hover (pen near the screen): side-button presses and palm rejection.
    view.scroller.addEventListener('pointermove', (e) => this.#hover(e), { signal: this.ac.signal });
    view.scroller.addEventListener('pointerover', (e) => { if (e.pointerType === 'pen') this.#penActiveUntil = performance.now() + PALM_AFTER_PEN_MS; }, { signal: this.ac.signal });
    // Windows maps the pen button to right-click: no context menu on the pages.
    st.addEventListener('contextmenu', (e) => e.preventDefault(), { signal: this.ac.signal });
  }

  dispose() { this.ac.abort(); cancelAnimationFrame(this.#raf); this.overlay.remove(); }

  /** Strokes of a page as they should be drawn now (erase preview, hidden selection). */
  inkFor(pageId) {
    let s = this.erasing?.pageId === pageId ? this.erasing.strokes : this.doc.strokes(pageId);
    if (this.hiddenStrokes?.pageId === pageId) s = s.filter((x) => !this.hiddenStrokes.ids.has(x.id));
    return s;
  }

  clearOverlay() {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.ovContent.replaceChildren();
    this.ovContent.removeAttribute('transform');
  }

  /** Places the overlay so 1 unit = 1 mm on the given page. */
  overlayToPage(pageId) {
    const r = this.view.pageRect(pageId), sr = this.stage.getBoundingClientRect();
    if (!r) return;
    this.ovPage.setAttribute('transform', `translate(${r.left - sr.left} ${r.top - sr.top}) scale(${this.view.s})`);
  }

  /** SVG markup (page mm) shown in the overlay. */
  setOverlay(markup) { this.ovContent.innerHTML = markup; }

  /** Extra transform (DOMMatrix, page mm) applied to the overlay content. */
  setOverlayMatrix(m) { this.ovContent.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`); }

  // ------------------------------------------------------------------ classification

  #isPalm(e) {
    if (e.pointerType !== 'touch') return false;
    if (this.#penDown || performance.now() < this.#penActiveUntil) return true;
    return (e.width || 0) > PALM_CONTACT_PX && (e.height || 0) > PALM_CONTACT_PX;
  }

  /** What a pointerdown should do: null (not ours) or an action name. */
  #actionFor(e) {
    if (e.pointerType === 'pen') {
      if (e.buttons & 32) return 'erase';                      // eraser end
      // Chrome sends one "buttons 1, pressure 0" move right before every touch-down, so a
      // hover press only counts if it started a moment before the tip touched the screen.
      // A press left over from the previous stroke ("used") never starts a selection.
      const hb = this.#hoverBtn;
      if (hb && !hb.used && e.timeStamp - hb.t < HOVER_PRESS_MIN_MS) this.#hoverBtn = null;
      const held = this.#hoverBtn && !this.#hoverBtn.used;
      if (tools.s.sideButton && held) {
        // Button held while touching down: a selection, not a toggle on release.
        this.#hoverBtn.used = true;
        return 'lasso';
      }
      if (tools.s.sideButton && (e.buttons & 2)) return 'side';
      return tools.isDrawing() ? tools.active : null;           // text tool: handled by the text layer
    }
    const fingerDraws = tools.s.fingerMode === 'both' && tools.isDrawing();
    if (e.pointerType === 'mouse') return e.button === 0 && fingerDraws ? tools.active : null;
    return fingerDraws ? tools.active : null;
  }

  // ------------------------------------------------------------------ pointer events

  #down(e) {
    if (e.pointerType === 'pen') { this.#penDown = true; this.#penActiveUntil = performance.now() + PALM_AFTER_PEN_MS; }
    if (this.#isPalm(e)) { e.qnPalm = true; e.stopPropagation(); return; }
    if (e.pointerType === 'touch') this.#tapDown(e);

    // Ruler: fingers on it move/rotate it.
    if (e.pointerType === 'touch' && this.ruler.visible) {
      const sr = this.stage.getBoundingClientRect();
      if (this.ruler.owns(e.pointerId) || this.ruler.hit(e.clientX - sr.left, e.clientY - sr.top)) {
        this.ruler.down(e);
        e.qnClaimed = true; e.qnPalm = true;   // the page neither pans nor pinches
        return;
      }
    }
    // A second finger while drawing with a finger: it is a pinch, drop the stroke.
    if (e.pointerType === 'touch' && this.#stroke?.pointerType === 'touch') { this.#abort(); return; }
    if (this.#stroke) return;

    if (this.pickColor && (e.pointerType !== 'mouse' || e.button === 0)) {
      const hit = this.view.pageAt(e.clientX, e.clientY);
      if (!hit) return;
      e.qnClaimed = true; e.preventDefault(); e.stopPropagation();
      const cb = this.pickColor;
      this.pickColor = null;
      cb(this.#colorAt(hit.page, e.clientX, e.clientY));
      return;
    }

    const action = this.#actionFor(e);
    if (e.pointerType === 'pen') this.#logButtons('down', e, { action });
    if (!action) return;
    // Taps on the selection frame are handled by the selection itself.
    if (e.target.closest('.sel-frame')) return;
    const hit = this.view.pageAt(e.clientX, e.clientY);
    if (!hit) return;
    e.qnClaimed = true;
    e.preventDefault();
    try { this.view.stack.setPointerCapture(e.pointerId); } catch { /* fine */ }
    if (action !== 'side' && this.selection.active && action !== 'lasso') this.selection.clear();

    const st = {
      viaButton: action === 'side' || (action === 'lasso' && e.pointerType === 'pen' && !!this.#hoverBtn?.used && !!(e.buttons & 3)),
      action, pointerId: e.pointerId, pointerType: e.pointerType, pageId: hit.page.id, page: hit.page,
      t0: e.timeStamp, x0: e.clientX, y0: e.clientY, points: [],
      pressure: e.pointerType === 'pen' ? new PressureTrack() : null,
    };
    if (action === 'side') {
      // Short press = pen/eraser toggle; hold or move = lasso while held.
      this.#sawButton();
      st.action = 'side-pending';
      st.timer = setTimeout(() => { if (this.#stroke === st) this.#becomeLasso(st); }, tools.s.holdMs);
    } else if (action === 'pen' || action === 'highlighter') {
      st.stroke = { id: newStrokeId(), ...tools.strokeStyle(action), points: st.points };
      st.edge = this.#rulerEdge(e);
    } else if (action === 'shape') {
      st.shapeMode = tools.s.shape.mode;
      st.stroke = { id: newStrokeId(), ...tools.strokeStyle('shape'), points: st.points };
    } else if (action === 'erase' || action === 'eraser') {
      st.action = 'erase';
      this.erasing = { pageId: hit.page.id, strokes: this.doc.strokes(hit.page.id) };
    } else if (action === 'lasso') {
      this.selection.clear();
    }
    this.#stroke = st;
    this.#addPoints(st, e, [e]);
    if (st.action === 'erase') this.#eraseAt(st, [e]);   // a tap erases too
    this.#render(st, e);
  }

  #move(e) {
    if (this.ruler.owns(e.pointerId)) { this.ruler.move(e); e.qnClaimed = true; return; }
    if (e.pointerType === 'touch') this.#tapMove(e);
    const st = this.#stroke;
    if (!st || e.pointerId !== st.pointerId) return;
    e.qnClaimed = true;
    if (st.action === 'side-pending') {
      if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) > 6) this.#becomeLasso(st);
      else return;
    }
    const events = e.getCoalescedEvents?.() || [e];
    this.#addPoints(st, e, events.length ? events : [e]);
    if (st.action === 'erase') this.#eraseAt(st, events.length ? events : [e]);
    if ((st.action === 'shape' && st.shapeMode === 'auto') || (st.action === 'pen' && tools.s.penShapes)) this.#watchHold(st);
    this.#render(st, e);
  }

  #up(e) {
    if (e.pointerType === 'pen') { this.#penDown = false; this.#penActiveUntil = performance.now() + PALM_AFTER_PEN_MS; }
    if (this.ruler.owns(e.pointerId)) { this.ruler.up(e); return; }
    if (e.pointerType === 'touch') this.#tapUp(e);
    const st = this.#stroke;
    if (!st || e.pointerId !== st.pointerId) return;
    e.qnClaimed = true;
    this.#stroke = null;
    clearTimeout(st.timer);
    clearTimeout(st.holdTimer);
    this.clearOverlay();
    this.#strokeStats(st, e);
    // The side button may still be held after lifting: its release must not toggle tools.
    if (st.viaButton) this.#hoverBtn = { t: 0, used: true };
    switch (st.action) {
      case 'side-pending': tools.togglePenEraser(); break;
      case 'pen': if (st.recognized) this.#commitShape(st); else this.#commitStroke(st); break;
      case 'highlighter': this.#commitStroke(st); break;
      case 'shape': this.#commitShape(st); break;
      case 'erase': this.#commitErase(st); break;
      case 'lasso': this.#commitLasso(st); break;
      default: break;
    }
  }

  /** Every 20th stroke: drawing timings for the diagnostics log. */
  #strokeStats(st, e) {
    this.strokeCount = (this.strokeCount || 0) + 1;
    if (this.strokeCount % 20 !== 1 || !st.frames) return;
    const secs = Math.max(0.001, (e.timeStamp - st.t0) / 1000);
    diag.note('stroke', {
      n: this.strokeCount, pointer: st.pointerType, action: st.action, points: st.points.length, secs: Math.round(secs * 100) / 100,
      fps: Math.round(st.frames / secs), avgMs: Math.round((st.paintMs / st.frames) * 10) / 10, maxMs: Math.round(st.maxMs * 10) / 10,
      zoom: this.view.percent, ...this.view.canvasStats(),
      pressure: st.pressure?.stats() ?? undefined,
    });
  }

  #cancel(e) {
    if (this.ruler.owns(e.pointerId)) { this.ruler.up(e); return; }
    if (e.pointerType === 'pen') this.#penDown = false;
    this.#taps = null;
    if (this.#stroke?.pointerId === e.pointerId) this.#abort();
  }

  #abort() {
    const st = this.#stroke;
    if (!st) return;
    clearTimeout(st.timer);
    clearTimeout(st.holdTimer);
    this.#stroke = null;
    if (this.erasing) { this.erasing = null; this.view.invalidateInk(st.pageId); }
    this.clearOverlay();
  }

  /** Colour of the topmost stroke or shape under a point (null if none). */
  #colorAt(page, cx, cy) {
    const r = this.view.pageRect(page.id);
    const x = (cx - r.left) / this.view.s, y = (cy - r.top) / this.view.s;
    const strokes = this.doc.strokes(page.id);
    const tol = Math.max(1.5, 8 / this.view.s);
    for (let i = strokes.length - 1; i >= 0; i--) if (strokeHit(strokes[i], x, y, tol)) return strokes[i].color;
    const objs = [...(page.objects || [])].sort((a, b) => (b.z || 0) - (a.z || 0));
    for (const o of objs) {
      if (x >= o.x - tol && x <= o.x + o.w + tol && y >= o.y - tol && y <= o.y + (o.h || 0) + tol) {
        return o.stroke?.color || o.style?.color || null;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ points

  #toMm(st, cx, cy) {
    const r = this.view.pageRect(st.pageId);
    return [(cx - r.left) / this.view.s, (cy - r.top) / this.view.s];
  }

  /** Pen: raw pressure through the device's calibrated curve (see pressure.js); else 0.5. */
  #pressure(st, ev) {
    return st.pressure ? st.pressure.map(ev.pressure) : 0.5;
  }

  #addPoints(st, e, events) {
    const sr = this.stage.getBoundingClientRect();
    for (const ev of events) {
      let cx = ev.clientX, cy = ev.clientY;
      if (st.edge != null) {
        const p = this.ruler.project(cx - sr.left, cy - sr.top, st.edge);
        cx = p.x + sr.left; cy = p.y + sr.top;
      }
      const [x, y] = this.#toMm(st, cx, cy);
      const p = this.#pressure(st, ev);   // every sample feeds the pressure smoothing
      const last = st.points[st.points.length - 1];
      if (last && Math.hypot(x - last[0], y - last[1]) < MIN_POINT_MM) continue;
      st.points.push([round(x), round(y), round(p), Math.round(ev.timeStamp - st.t0)]);
      if (st.pressure) (st.rawP ||= []).push(st.pressure.lastRaw);
    }
  }

  #rulerEdge(e) {
    if (!this.ruler.visible) return null;
    const sr = this.stage.getBoundingClientRect();
    return this.ruler.edgeNear(e.clientX - sr.left, e.clientY - sr.top);
  }

  // ------------------------------------------------------------------ live rendering

  /** Remembers the predicted points (only readable during the event) and redraws next frame. */
  #render(st, e) {
    const predicted = e?.getPredictedEvents?.() || [];
    st.predicted = predicted.slice(0, 2).map((p) => [...this.#toMm(st, p.clientX, p.clientY), st.points.at(-1)?.[2] ?? 0.5, 0]);
    if (this.#raf) return;
    this.#raf = requestAnimationFrame(() => {
      this.#raf = 0;
      if (this.#stroke === st) this.#paint(st);
    });
  }

  #paint(st) {
    const t0 = performance.now();
    if (st.action === 'side-pending') { this.ovContent.replaceChildren(); return; }
    this.overlayToPage(st.pageId);
    let markup = '';
    if (st.recognized) {
      // Held still at the end: preview of the perfect shape it will become.
      markup = shapeSvg({ kind: st.recognized.kind, points: st.recognized.points, stroke: this.#shapeStyle(st), fill: st.action === 'shape' ? tools.s.shape.fill : null });
    } else if (st.action === 'pen' || st.action === 'highlighter' || (st.action === 'shape' && st.shapeMode === 'auto')) {
      // Predicted points shorten the gap between the pen tip and the ink.
      const pts = st.predicted?.length ? [...st.points, ...st.predicted] : st.points;
      if (pts.length) markup = liveSvg({ ...st.stroke, points: st.action === 'highlighter' && tools.s.highlighter.straight ? straight(pts) : pts });
    } else if (st.action === 'shape') {
      const sh = st.recognized || (st.points.length > 1 ? { kind: st.shapeMode, points: shapeFromDrag(st.shapeMode, st.points[0], st.points.at(-1)) } : null);
      if (sh) markup = shapeSvg({ kind: sh.kind, points: sh.points, stroke: { color: tools.s.shape.color, width: tools.s.shape.widthPt * 0.3528 }, fill: tools.s.shape.fill });
    } else if (st.action === 'erase') {
      const p = st.points.at(-1);
      if (p) markup = `<circle cx="${p[0]}" cy="${p[1]}" r="${tools.s.eraser.sizeMm / 2}" fill="rgba(233,162,59,0.1)" stroke="#E9A23B" stroke-width="0.3"/>`;
    } else if (st.action === 'lasso') {
      const pts = tools.s.lasso.mode === 'rect' && st.points.length > 1 ? rectPoints(st.points[0], st.points.at(-1)) : st.points;
      if (pts.length > 1) {
        markup = `<path d="M${pts.map((p) => `${p[0]} ${p[1]}`).join('L')}Z" fill="rgba(233,162,59,0.08)" stroke="#E9A23B" stroke-width="0.35" stroke-dasharray="1.6 1.2"/>`;
      }
    }
    this.ovContent.innerHTML = markup;
    const ms = performance.now() - t0;
    st.frames = (st.frames || 0) + 1;
    st.paintMs = (st.paintMs || 0) + ms;
    st.maxMs = Math.max(st.maxMs || 0, ms);
  }

  // ------------------------------------------------------------------ actions

  #commitStroke(st) {
    if (!st.points.length) return;
    const remap = st.pressure?.end();
    let pts = remap ? st.points.map((q, i) => [q[0], q[1], round(remap(st.rawP[i])), q[3]]) : st.points;
    if (st.action === 'highlighter' && tools.s.highlighter.straight) pts = straight(pts);
    if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.01, pts[0][1] + 0.01, pts[0][2], pts[0][3]]];   // a dot
    const stroke = { ...st.stroke, points: pts };
    this.doc.setInk(st.pageId, [...this.doc.strokes(st.pageId), stroke]);
    this.view.addStroke(st.pageId, stroke, isHighlighter(stroke) ? 'under' : 'over',
      (ctx, s, y0, h) => drawStrokes(ctx, [s], isHighlighter(s) ? 'under' : 'over', y0, h));
    this.#growInfinite(st.page, stroke);
    this.onPenStroke?.(st.pointerType);
  }

  #watchHold(st) {
    const p = st.points.at(-1);
    if (!p) return;
    if (st.recognized) {
      // Moving on after the snap: back to a free-hand stroke.
      // (Penna: any real movement, so a pause in the middle of handwriting changes nothing.)
      if (Math.hypot(p[0] - st.holdAt[0], p[1] - st.holdAt[1]) > (st.action === 'pen' ? 0.8 : 3)) { st.recognized = null; st.holdAt = p; }
      return;
    }
    if (!st.holdAt || Math.hypot(p[0] - st.holdAt[0], p[1] - st.holdAt[1]) > 1) {
      st.holdAt = p;
      clearTimeout(st.holdTimer);
      st.holdTimer = setTimeout(() => {
        if (this.#stroke !== st) return;
        // With the Penna only drawings, not letters: at least 8 mm across.
        if (st.action === 'pen') {
          const xs = st.points.map((q) => q[0]), ys = st.points.map((q) => q[1]);
          if (Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < 8) return;
        }
        st.recognized = recognize(st.points);
        if (st.recognized) { navigator.vibrate?.(10); this.#render(st, null); }
      }, SHAPE_HOLD_MS);
    }
  }

  #commitShape(st) {
    let sh = null;
    if (st.action === 'pen') sh = st.recognized;
    else if (st.shapeMode === 'auto') {
      sh = st.recognized;
      if (!sh) { if (st.points.length > 1) this.#commitStroke({ ...st, action: 'pen' }); return; }
    } else if (st.points.length > 1) {
      const a = st.points[0], b = st.points.at(-1);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 2) return;
      sh = { kind: st.shapeMode, points: shapeFromDrag(st.shapeMode, a, b) };
    }
    if (!sh) return;
    const page = st.page;
    const z = Math.max(0, ...(page.objects || []).map((o) => o.z || 0)) + 1;
    const style = this.#shapeStyle(st);
    const obj = makeShape(sh.kind, sh.points, { ...style, fill: st.action === 'shape' ? tools.s.shape.fill : null }, z);
    this.doc.transact(() => { page.objects ||= []; page.objects.push(obj); });
    this.view.remountPage(page.id);
    this.#growInfinite(page, { points: [[obj.x, obj.y + obj.h]], width: 0 });
  }

  /** Line colour and width of a recognised shape: the pen's own when drawn with the Penna. */
  #shapeStyle(st) {
    if (st.action === 'pen') return { color: st.stroke.color, width: Math.max(0.2, st.stroke.width) };
    return { color: tools.s.shape.color, width: tools.s.shape.widthPt * 0.3528 };
  }

  #eraseAt(st, events) {
    const r = tools.s.eraser.sizeMm / 2;
    const area = tools.s.eraser.mode === 'area';
    // Eraser positions, filled in between events so a fast swipe leaves no gaps.
    const spots = [];
    for (const ev of events) {
      const p = this.#toMm(st, ev.clientX, ev.clientY);
      const last = st.lastErase;
      if (last) {
        const d = Math.hypot(p[0] - last[0], p[1] - last[1]);
        const n = Math.floor(d / Math.max(0.3, r / 2));
        for (let k = 1; k <= n; k++) spots.push([last[0] + (p[0] - last[0]) * k / (n + 1), last[1] + (p[1] - last[1]) * k / (n + 1)]);
      }
      spots.push(p);
      st.lastErase = p;
    }
    let strokes = this.erasing.strokes;
    const before = new Set(strokes);
    for (const [x, y] of spots) {
      strokes = area ? strokes.flatMap((s) => eraseArea(s, x, y, r)) : strokes.filter((s) => !strokeHit(s, x, y, r));
    }
    // What changed: strokes removed or cut (their old boxes) and the new pieces.
    const after = new Set(strokes);
    const touched = [...before].filter((s) => !after.has(s)).concat(strokes.filter((s) => !before.has(s)));
    if (!touched.length) return;
    this.erasing.strokes = strokes;
    const d = this.erasing.dirty ||= { y0: Infinity, y1: -Infinity, under: false, over: false };
    for (const s of touched) {
      const b = quickBBox(s);
      d.y0 = Math.min(d.y0, b[1]); d.y1 = Math.max(d.y1, b[3]);
      if (isHighlighter(s)) d.under = true; else d.over = true;
    }
    if (this.eraseRaf) return;
    // At most one redraw per frame, only of the tiles and layers that changed.
    this.eraseRaf = requestAnimationFrame(() => {
      this.eraseRaf = 0;
      const dd = this.erasing?.dirty;
      if (!dd) return;
      this.erasing.dirty = null;
      this.view.invalidateInk(st.pageId, dd);
    });
  }

  #commitErase(st) {
    cancelAnimationFrame(this.eraseRaf);
    this.eraseRaf = 0;
    const er = this.erasing;
    this.erasing = null;
    if (!er) return;
    if (er.strokes !== this.doc.strokes(st.pageId)) this.doc.setInk(st.pageId, er.strokes);
    // The tiles already show these strokes; only a change not yet drawn needs a redraw.
    if (er.dirty) this.view.invalidateInk(st.pageId, er.dirty);
  }

  #becomeLasso(st) {
    clearTimeout(st.timer);
    st.action = 'lasso';
    this.selection.clear();
    navigator.vibrate?.(8);
  }

  #commitLasso(st) {
    const poly = tools.s.lasso.mode === 'rect' && st.points.length > 1 ? rectPoints(st.points[0], st.points.at(-1)) : st.points;
    if (poly.length < 3) return;
    this.selection.select(st.pageId, poly, tools.s.lasso.filter);
  }

  #growInfinite(page, stroke) {
    if (page.size.preset !== 'infinite') return;
    const bottom = Math.max(...stroke.points.map((p) => p[1])) + (stroke.width || 0);
    if (bottom + INFINITE_MARGIN_MM > page.size.heightMm) {
      this.doc.transact(() => { page.size.heightMm = Math.ceil((bottom + INFINITE_MARGIN_MM) / 10) * 10; });
      this.view.refreshPage(page.id);
    }
  }

  // ------------------------------------------------------------------ side button while hovering

  #sawButton() {
    this.dispatchEvent(new Event('penbutton'));
  }

  /**
   * Side button while the pen hovers. How the button arrives depends on the platform:
   * Windows reports it as buttons & 2; Chrome on Samsung tablets reports buttons & 1 with
   * zero pressure while the tip is not touching (seen in the diagnostics of the S Pen).
   * A short press toggles Penna/Gomma on release; if the pen touches the screen while
   * the button is held, that touch is a lasso selection (see #down).
   */
  /** Side-button diagnostics: every change of the pen's buttons (max 300 per session). */
  #logButtons(where, e, extra = {}) {
    const key = `${where}:${e.buttons}:${e.pressure > 0}`;
    if (key === this.lastBtnKey || (this.btnLogs = (this.btnLogs || 0) + 1) > 300) return;
    this.lastBtnKey = key;
    diag.note('penbtn', { where, ev: e.type, b: e.button, bs: e.buttons, p: Math.round((e.pressure || 0) * 100) / 100,
      hb: this.#hoverBtn ? (this.#hoverBtn.used ? 'used' : Math.round(e.timeStamp - this.#hoverBtn.t)) : null,
      sideButton: tools.s.sideButton, tool: tools.active, ...extra });
  }

  #hover(e) {
    if (e.pointerType !== 'pen') return;
    this.#logButtons('hover', e, { stroke: !!this.#stroke, penDown: this.#penDown });
    this.#penActiveUntil = performance.now() + PALM_AFTER_PEN_MS;
    if (!tools.s.sideButton || this.#stroke || this.#penDown || e.pressure > 0) return;
    const pressed = (e.buttons & 3) !== 0;
    if (pressed && !this.#hoverBtn) { this.#hoverBtn = { t: e.timeStamp, used: false }; }
    else if (!pressed && this.#hoverBtn) {
      const b = this.#hoverBtn;
      this.#hoverBtn = null;
      if (b.used) return;
      this.#sawButton();
      if (e.timeStamp - b.t < tools.s.holdMs) tools.togglePenEraser();
    }
  }

  // ------------------------------------------------------------------ multi-finger taps

  #tapDown(e) {
    const now = performance.now();
    if (!this.#taps || now - this.#taps.t0 > 220 || this.#taps.done) this.#taps = { t0: now, pts: new Map(), max: 0, valid: true };
    this.#taps.pts.set(e.pointerId, [e.clientX, e.clientY]);
    this.#taps.max = Math.max(this.#taps.max, this.#taps.pts.size);
  }

  #tapMove(e) {
    const t = this.#taps;
    const p = t?.pts.get(e.pointerId);
    if (p && Math.hypot(e.clientX - p[0], e.clientY - p[1]) > 14) t.valid = false;
  }

  #tapUp(e) {
    const t = this.#taps;
    if (!t || !t.pts.has(e.pointerId)) return;
    t.pts.delete(e.pointerId);
    if (t.pts.size) return;
    t.done = true;
    const now = performance.now();
    if (!t.valid || t.max < 2 || now - t.t0 > 380) return;
    if (this.#lastTap && this.#lastTap.n === t.max && now - this.#lastTap.time < 450) {
      this.#lastTap = null;
      if (t.max === 2) this.onUndo();
      else if (t.max === 3) this.onRedo();
    } else this.#lastTap = { n: t.max, time: now };
  }
}

const round = (v) => Math.round(v * 100) / 100;

/** Straight-line highlighter: start to end, levelled when nearly horizontal. */
function straight(pts) {
  const a = pts[0], b = pts[pts.length - 1];
  const level = Math.abs(b[1] - a[1]) < Math.abs(b[0] - a[0]) * 0.14;
  return [a, [b[0], level ? a[1] : b[1], b[2], b[3]]];
}

function rectPoints(a, b) {
  return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
}
