// Pointer gestures for library items: tap, long-press, right-click and drag-to-move.
// Pointer Events only (HTML5 drag-and-drop does not work with touch).
//
//   mouse:       click = tap, right-click = menu, press + move = drag
//   touch / pen: tap = tap, hold still ~450 ms = menu, hold then move = drag,
//                move before the hold = normal scrolling
import { h } from '../dom.js';

const HOLD_MS = 450;
const MOUSE_DRAG_PX = 6;
const TOUCH_SLOP_PX = 10;

/**
 * attachGestures(el, {
 *   onTap(e), onMenu(x, y), dragLabel() -> string | null (null = not draggable),
 *   onDragStart(), onDrop(targetFolderId), onDragEnd(), onDragEdge(x) })
 * Drop targets are elements with data-drop-folder ("root" or a folder id) and
 * optionally data-drop-reject="1" while invalid.
 */
export function attachGestures(el, opts) {
  let s = null; // gesture state

  const reset = () => {
    if (s?.timer) clearTimeout(s.timer);
    if (s?.state === 'drag') opts.onDragEnd?.();
    s?.ghost?.remove();
    document.querySelectorAll('.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
    document.body.classList.remove('dragging');
    el.classList.remove('pressed');
    s = null;
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (s) reset();
    s = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, state: 'pending', ev: e };
    el.classList.add('pressed');
    if (e.pointerType !== 'mouse') {
      s.timer = setTimeout(() => {
        if (!s || s.state !== 'pending') return;
        s.state = 'armed';
        navigator.vibrate?.(12);
      }, HOLD_MS);
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id) return;
    const d = Math.hypot(e.clientX - s.x, e.clientY - s.y);
    if (s.state === 'pending') {
      if (s.type === 'mouse' && d > MOUSE_DRAG_PX) startDrag(e);
      else if (s.type !== 'mouse' && d > TOUCH_SLOP_PX) reset(); // it is a scroll
    } else if (s.state === 'armed' && d > TOUCH_SLOP_PX) {
      startDrag(e);
    } else if (s.state === 'drag') {
      moveDrag(e);
    }
  });

  el.addEventListener('pointerup', (e) => {
    if (!s || e.pointerId !== s.id) return;
    const st = s.state;
    if (st === 'drag') {
      const target = hitTarget(e.clientX, e.clientY);
      reset();
      if (target) opts.onDrop?.(target.dataset.dropFolder);
    } else if (st === 'armed') {
      const { x, y } = s;
      reset();
      opts.onMenu?.(x, y);
    } else if (st === 'pending') {
      const ev = s.ev;
      reset();
      opts.onTap?.(ev);
    }
  });

  el.addEventListener('pointercancel', reset);

  // Keep the page from scrolling once a touch hold has armed the drag.
  el.addEventListener('touchmove', (e) => { if (s && (s.state === 'armed' || s.state === 'drag')) e.preventDefault(); }, { passive: false });

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // Touch long-press is handled by our own timer; only real right-clicks open the menu here.
    if (s && s.type !== 'mouse') return;
    if (e.pointerType && e.pointerType !== 'mouse') return;
    reset();
    opts.onMenu?.(e.clientX, e.clientY);
  });

  // Keyboard activation (Enter / Space on the focused item).
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onTap?.(e); }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      opts.onMenu?.(r.left + 20, r.top + 20);
    }
  });

  function startDrag(e) {
    const label = opts.dragLabel?.();
    if (!label) { if (s.type === 'mouse') reset(); return; }
    s.state = 'drag';
    clearTimeout(s.timer);
    opts.onDragStart?.();
    try { el.setPointerCapture(e.pointerId); } catch { /* not critical */ }
    s.ghost = h('div.drag-ghost', {}, label);
    document.body.append(s.ghost);
    document.body.classList.add('dragging');
    moveDrag(e);
  }

  function moveDrag(e) {
    s.ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
    const target = hitTarget(e.clientX, e.clientY);
    document.querySelectorAll('.drop-hover').forEach((n) => { if (n !== target) n.classList.remove('drop-hover'); });
    target?.classList.add('drop-hover');
    opts.onDragEdge?.(e.clientX);
  }
}

function hitTarget(x, y) {
  const t = document.elementFromPoint(x, y)?.closest('[data-drop-folder]');
  return t && t.dataset.dropReject !== '1' ? t : null;
}
