// Context menus (right-click / long-press). Items: { label, icon, action, danger, disabled } or 'sep'.
import { h } from '../dom.js';
import { icon } from '../icons.js';

let current = null;

export function closeMenu() {
  if (!current) return;
  current.remove();
  current = null;
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', closeMenu);
}

function outside(e) { if (current && !current.contains(e.target)) closeMenu(); }
function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }

export function openMenu(x, y, items, { title = '' } = {}) {
  closeMenu();
  const menu = h('div.menu', { role: 'menu' },
    title ? h('div.menu-title', {}, title) : null,
    items.filter(Boolean).map((it) => it === 'sep' ? h('div.menu-sep') :
      h(`button.menu-item${it.danger ? '.danger' : ''}`, {
        type: 'button', role: 'menuitem', disabled: it.disabled,
        onclick: () => { closeMenu(); it.action(); },
      }, it.icon ? icon(it.icon) : h('span.icon'), h('span', {}, it.label))));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.max(8, Math.min(x, vw - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, vh - r.height - 8)) + 'px';
  current = menu;
  // Listen after the opening event has finished.
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMenu);
  }, 0);
  menu.querySelector('.menu-item:not([disabled])')?.focus({ preventScroll: true });
  return menu;
}
