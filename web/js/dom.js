// Tiny DOM helpers. h('div.card', { onclick }, child, ...) builds elements.
import { icon } from './icons.js';

export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Icon-only button with an accessible label. */
export function iconButton(name, label, onclick, extra = {}) {
  return h('button.icon-btn', { type: 'button', title: label, 'aria-label': label, onclick, ...extra }, icon(name));
}

/** Text button, optionally with an icon. */
export function button(label, onclick, { iconName, kind = '', ...extra } = {}) {
  return h(`button.btn${kind ? '.' + kind : ''}`, { type: 'button', onclick, ...extra }, iconName ? icon(iconName) : null, h('span', {}, label));
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

/** Replaces the children of el; skips null/false and flattens arrays (unlike replaceChildren). */
export function fill(el, ...children) { clear(el); append(el, children); return el; }

export const qs = (sel, root = document) => root.querySelector(sel);
