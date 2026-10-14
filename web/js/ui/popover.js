// Popover anchored to a button (tool options, colours). Closes on outside tap or Escape.
import { h } from '../dom.js';

let current = null;

export function closePopover() {
  if (!current) return;
  current.el.remove();
  document.removeEventListener('pointerdown', current.outside, true);
  document.removeEventListener('keydown', current.key, true);
  current.onClose?.();
  current = null;
}

export function openPopover(anchor, content, { className = '', onClose = null } = {}) {
  closePopover();
  const el = h(`div.popover${className ? '.' + className : ''}`, { role: 'dialog' }, content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const pr = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(r.left + r.width / 2 - pr.width / 2, innerWidth - pr.width - 8)) + 'px';
  const below = r.bottom + 6;
  el.style.top = (below + pr.height > innerHeight - 8 ? Math.max(8, r.top - pr.height - 6) : below) + 'px';
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
  }, 0);
  current = { el, outside, key, onClose, anchor };
  return closePopover;
}

export const popoverOpenFor = (anchor) => current?.anchor === anchor;
