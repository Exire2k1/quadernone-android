// Page objects in the editor: text boxes, shapes and images.
//
// Text tool: tap on an empty spot to create a box, tap a box to edit it, tap outside to
// finish. While editing, the box shows a move grip (top) and a width handle (right).
// Creating + typing + finishing is one undo step; moving and resizing are steps of their own.
import { createTextEl, applyTextStyle, readBlocks, measuredHeightMm } from '../page/textbox.js';
import { emptyBlocks, isEmptyText, PT_MM } from '../page/textmodel.js';
import { defaultInk } from '../page/paper.js';
import { createShapeEl } from '../page/shapes.js';
import { createImageEl } from '../page/images.js';

const TAP_PX = 8;
const TAP_MS = 500;
export const INFINITE_MARGIN_MM = 80;

const newObjectId = () => 'ob-' + [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');

export class ObjectLayer extends EventTarget {
  mounted = new Map();     // objId -> { el, obj, page }
  editing = null;          // { obj, page, el, before, isNew }

  constructor({ doc, view, getTool }) {
    super();
    this.doc = doc;
    this.view = view;
    this.getTool = getTool;
    this.#bind();
  }

  // ------------------------------------------------------------------ mounting

  mount(page, layer) {
    for (const obj of page.objects || []) {
      let el;
      if (obj.type === 'text') el = createTextEl(obj, defaultInk(page.background));
      else if (obj.type === 'shape') el = createShapeEl(obj);
      else if (obj.type === 'image') el = createImageEl(obj, this.doc.id);
      else continue;
      layer.append(el);
      this.mounted.set(obj.id, { el, obj, page });
    }
  }

  unmount(page, layer) {
    if (this.editing?.page === page) this.endEdit();
    for (const el of [...layer.children]) {
      this.mounted.delete(el.dataset.objId);
      el.remove();
    }
  }

  /** Re-renders every mounted page (after undo/redo, a background change, …). */
  remountAll() {
    if (this.editing) this.endEdit({ commit: false });
    for (const p of this.doc.list) this.view.remountPage(p.id);
  }

  // ------------------------------------------------------------------ pointer input

  #bind() {
    const stack = this.view.stack;
    let tap = null;

    stack.addEventListener('pointerdown', (e) => {
      if (e.qnClaimed || e.qnPalm) return;          // the pen is writing, or a palm
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const handle = e.target.closest('.tb-handle');
      if (handle) { this.#startDrag(e, handle.dataset.kind); return; }

      const box = e.target.closest('.obj-text');
      if (box) {
        const entry = this.mounted.get(box.dataset.objId);
        if (!entry) return;
        // Tapping a checklist box toggles it, without entering edit mode.
        const block = e.target.closest('[data-t="check"]');
        if (block && this.#onCheckMarker(block, e)) {
          e.preventDefault();
          this.#toggleCheck(entry, block);
          return;
        }
        if (this.editing?.el === box) return;   // caret placement inside the box
        if (entry.obj.locked || this.getTool() !== 'text') return;
        this.endEdit();
        this.beginEdit(entry);                   // the browser then puts the caret where tapped
        return;
      }
      if (!e.target.closest('.page')) return;
      tap = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, wasEditing: !!this.editing,
        image: e.target.closest('.obj-image')?.dataset.objId ?? null };
    });

    stack.addEventListener('pointerup', (e) => {
      if (!tap || e.pointerId !== tap.id || e.qnClaimed) return;
      const t = tap;
      tap = null;
      if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > TAP_PX || performance.now() - t.t > TAP_MS) return;
      if (t.wasEditing) { this.endEdit(); return; }       // first tap outside only closes the box
      // A tap on an image selects it (the editor shows the image bar).
      if (t.image && this.mounted.has(t.image)) {
        this.dispatchEvent(new CustomEvent('imagetap', { detail: this.mounted.get(t.image) }));
        return;
      }
      if (this.getTool() !== 'text') return;
      const hit = this.view.pageAt(e.clientX, e.clientY);
      if (hit) this.createAt(hit.page, hit.xMm, hit.yMm);
    });
    stack.addEventListener('pointercancel', () => { tap = null; });
  }

  #onCheckMarker(block, e) {
    const r = block.getBoundingClientRect();
    const em = parseFloat(getComputedStyle(block).fontSize) || 16;
    return e.clientX - r.left < em * 1.4;
  }

  #toggleCheck(entry, block) {
    const editingThis = this.editing?.el === entry.el;
    block.dataset.done = block.dataset.done === '1' ? '0' : '1';
    if (editingThis) return; // recorded when the edit ends
    const before = this.doc.snapshot();
    entry.obj.blocks = readBlocks(entry.el);
    this.doc.record(before);
  }

  // ------------------------------------------------------------------ editing

  createAt(page, xMm, yMm) {
    const sizePt = 12;
    const fontMm = sizePt * PT_MM;
    const x = Math.max(0, Math.min(xMm, page.size.widthMm - 25));
    const obj = {
      id: newObjectId(), type: 'text',
      x: round(x), y: round(Math.max(0, yMm - fontMm * 0.8)),
      w: round(Math.max(25, Math.min(page.size.widthMm - x - 10, 170))), h: round(fontMm * 1.35),
      rotation: 0, z: Math.max(0, ...(page.objects || []).map((o) => o.z || 0)) + 1, locked: false,
      blocks: emptyBlocks(),
      style: { color: defaultInk(page.background), sizePt, align: 'left' },
    };
    const before = this.doc.snapshot();
    page.objects ||= [];
    page.objects.push(obj);
    const layer = this.view.objectLayer(page.id);
    const el = createTextEl(obj, defaultInk(page.background));
    layer.append(el);
    const entry = { el, obj, page };
    this.mounted.set(obj.id, entry);
    this.beginEdit(entry, { before, isNew: true });
    const content = el.querySelector('.tb-content');
    content.focus();
  }

  beginEdit(entry, { before = this.doc.snapshot(), isNew = false } = {}) {
    const { el } = entry;
    const content = el.querySelector('.tb-content');
    content.contentEditable = 'true';
    el.classList.add('editing');
    el.append(handle('move'), handle('width'));
    this.editing = { ...entry, before, isNew };
    content.addEventListener('beforeinput', onBeforeInput);
    content.addEventListener('input', onInput);
    content.addEventListener('paste', onPaste);
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('defaultParagraphSeparator', false, 'div');
    this.dispatchEvent(new CustomEvent('editstart', { detail: this.editing }));
  }

  /** Finishes editing. commit=false drops the edit state without saving (undo/redo path). */
  endEdit({ commit = true } = {}) {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const content = ed.el.querySelector('.tb-content');
    content.contentEditable = 'false';
    content.removeEventListener('beforeinput', onBeforeInput);
    content.removeEventListener('input', onInput);
    content.removeEventListener('paste', onPaste);
    ed.el.classList.remove('editing');
    ed.el.querySelectorAll('.tb-handle').forEach((n) => n.remove());
    window.getSelection()?.removeAllRanges();
    if (commit) {
      const blocks = readBlocks(ed.el);
      if (isEmptyText(blocks)) {
        this.#remove(ed);
      } else {
        ed.obj.blocks = blocks;
        ed.obj.h = measuredHeightMm(ed.el, this.view.s);
        this.#growInfinite(ed.page, ed.obj);
      }
      this.doc.record(ed.before);
    }
    this.dispatchEvent(new Event('editend'));
  }

  deleteEditing() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    this.#remove(ed);
    this.doc.record(ed.before);
    this.dispatchEvent(new Event('editend'));
  }

  #remove(ed) {
    ed.page.objects = (ed.page.objects || []).filter((o) => o.id !== ed.obj.id);
    ed.el.remove();
    this.mounted.delete(ed.obj.id);
  }

  /** Applies a box-level style (size, colour, alignment) to the box being edited. */
  setBoxStyle(patch) {
    const ed = this.editing;
    if (!ed) return;
    ed.obj.style = { ...ed.obj.style, ...patch };
    applyTextStyle(ed.el, ed.obj, defaultInk(ed.page.background));
  }

  /** Infinite pages always keep some empty space below the lowest object. */
  #growInfinite(page, obj) {
    if (page.size.preset !== 'infinite') return;
    const need = obj.y + (obj.h || 0) + INFINITE_MARGIN_MM;
    if (need > page.size.heightMm) {
      page.size.heightMm = Math.ceil(need / 10) * 10;
      this.view.refreshPage(page.id);
    }
  }

  // ------------------------------------------------------------------ move / resize

  #startDrag(e, kind) {
    const ed = this.editing;
    if (!ed) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.target.closest('.tb-handle');
    target.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, ox: ed.obj.x, oy: ed.obj.y, ow: ed.obj.w };
    // Text typed so far stays in the DOM; only geometry is recorded by this step.
    const before = this.doc.snapshot();
    const s = this.view.s;
    const page = ed.page;
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / s, dy = (ev.clientY - start.y) / s;
      if (kind === 'move') {
        ed.obj.x = round(clamp(start.ox + dx, -ed.obj.w + 10, page.size.widthMm - 10));
        ed.obj.y = round(clamp(start.oy + dy, 0, page.size.heightMm - 5));
      } else {
        ed.obj.w = round(clamp(start.ow + dx, 15, page.size.widthMm * 2));
      }
      applyTextStyle(ed.el, ed.obj, defaultInk(page.background));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      this.#growInfinite(page, ed.obj);
      this.doc.record(before);
      ed.before = this.doc.snapshot();
      ed.el.querySelector('.tb-content').focus();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }
}

function handle(kind) {
  const h = document.createElement('div');
  h.className = `tb-handle tb-handle-${kind}`;
  h.dataset.kind = kind;
  h.setAttribute('aria-hidden', 'true');
  return h;
}

const round = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------------- editing behaviour

function currentBlock() {
  const sel = window.getSelection();
  let n = sel?.anchorNode;
  if (n && n.nodeType === Node.TEXT_NODE) n = n.parentElement;
  return n?.closest?.('.tb-content > div') ?? null;
}

function onBeforeInput(e) {
  if (e.inputType !== 'insertParagraph') return;
  const block = currentBlock();
  if (!block) return;
  const t = block.dataset.t;
  // Enter on an empty list item leaves the list.
  if ((t === 'ul' || t === 'ol' || t === 'check') && !block.textContent.replace(/​/g, '').trim()) {
    e.preventDefault();
    block.dataset.t = 'p';
    delete block.dataset.done;
  }
}

function onInput(e) {
  const content = e.currentTarget;
  // Keep every line inside a block div (the browser may put text directly in the root).
  for (const n of [...content.childNodes]) {
    if (n.nodeType === Node.TEXT_NODE && n.nodeValue.trim()) {
      const div = document.createElement('div');
      div.dataset.t = 'p';
      n.replaceWith(div);
      div.append(n);
      const r = document.createRange();
      r.setStart(n, n.nodeValue.length);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
  if (e.inputType === 'insertParagraph') {
    const block = currentBlock();
    if (block) {
      // A new line after a heading is body text; a new checklist item starts unchecked.
      if (/^h[1-3]$/.test(block.dataset.t) && !block.textContent.trim()) block.dataset.t = 'p';
      if (block.dataset.t === 'check') block.dataset.done = '0';
      if (!block.dataset.t) block.dataset.t = 'p';
    }
  }
  if (!content.firstElementChild) content.innerHTML = '<div data-t="p"><br></div>';
}

function onPaste(e) {
  // Plain text only: no foreign HTML gets into the note.
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') || '';
  document.execCommand('insertText', false, text);
}
