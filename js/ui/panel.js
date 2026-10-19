// Overlay panels and dialogs. They open over the current screen and close back to it.
// Each open panel adds a history entry, so the Android back button closes it.
import { h, iconButton } from '../dom.js';
import { t } from '../i18n.js';

const stack = [];
let ignoreNextPop = false;
// onClose callbacks run only after the history step back has happened, so code that
// navigates right after a panel closes (e.g. opening a new note) cannot race with it.
let afterPop = [];
let afterPopTimer = 0;

function runAfterPop() {
  clearTimeout(afterPopTimer);
  const fns = afterPop;
  afterPop = [];
  for (const fn of fns) fn();
}

/**
 * openPanel({ title, body, footer, variant: 'side'|'dialog'|'full', dismissable, onClose })
 * Returns { close, el, body, setTitle }.
 */
export function openPanel({ title = '', body = null, footer = null, variant = 'side', dismissable = true, onClose = null, className = '' }) {
  const titleEl = h('h2.panel-title', { id: 'panel-title-' + (stack.length + 1) }, title);
  const bodyEl = h('div.panel-body', {}, body);
  const panel = h(`div.panel.panel-${variant}${className ? '.' + className : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleEl.id },
    h('header.panel-header', {}, titleEl, dismissable ? iconButton('close', t('common.close'), () => entry.close()) : null),
    bodyEl,
    footer ? h('footer.panel-footer', {}, footer) : null);
  const layer = h('div.panel-layer', {
    onpointerdown: (e) => { if (e.target === layer && dismissable) entry.close(); },
  }, panel);
  const entry = {
    el: panel, body: bodyEl, dismissable, onClose,
    setTitle: (s) => { titleEl.textContent = s; },
    close: () => {
      const i = stack.indexOf(entry);
      if (i === -1) return;
      // Close this panel and any opened on top of it.
      const toClose = stack.length - i;
      for (let k = 0; k < toClose; k++) remove(stack.pop(), { deferCallback: true });
      ignoreNextPop = true;
      history.go(-toClose);
      afterPopTimer = setTimeout(runAfterPop, 400);   // in case no popstate arrives
    },
  };
  layer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && entry.dismissable && stack[stack.length - 1] === entry) { e.stopPropagation(); entry.close(); }
  });
  document.getElementById('overlays').append(layer);
  stack.push(entry);
  history.pushState({ ...(history.state || {}), qnPanel: stack.length }, '');
  // Fade in on the next frame. The timer is a fallback: an app launched from the home screen
  // can start before it draws its first frame, and a panel must never stay invisible.
  const show = () => layer.classList.add('open');
  requestAnimationFrame(show);
  setTimeout(show, 250);
  // Focus the first field, or the panel itself.
  setTimeout(() => (panel.querySelector('[autofocus], input, select, textarea') || panel).focus?.({ preventScroll: true }), 60);
  panel.tabIndex = -1;
  return entry;
}

function remove(entry, { deferCallback = false } = {}) {
  const layer = entry.el.parentElement;
  layer.classList.remove('open');
  layer.classList.add('closing');
  layer.inert = true;   // no focus or input while it fades out
  setTimeout(() => layer.remove(), 180);
  if (!entry.onClose) return;
  if (deferCallback) afterPop.push(entry.onClose);
  else entry.onClose();
}

/** Called by the app's popstate handler. Returns true if a panel consumed the event. */
export function handlePopState() {
  if (ignoreNextPop) { ignoreNextPop = false; runAfterPop(); return true; }
  const top = stack[stack.length - 1];
  if (!top) return false;
  if (!top.dismissable) {
    history.pushState({ ...(history.state || {}), qnPanel: stack.length }, '');
    return true;
  }
  remove(stack.pop());
  return true;
}

export const panelOpen = () => stack.length > 0;

// ---- dialogs

export function confirmDialog({ title, body = '', confirmLabel = t('common.confirm'), danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const p = openPanel({
      title, variant: 'dialog', body: body ? h('p.dialog-text', {}, body) : null,
      footer: [
        h('button.btn', { type: 'button', onclick: () => p.close() }, t('common.cancel')),
        h(`button.btn.${danger ? 'danger' : 'primary'}`, { type: 'button', autofocus: true, onclick: () => { result = true; p.close(); } }, confirmLabel),
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog({ title, label = '', value = '', confirmLabel = t('common.ok'), maxLength = 200 }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input.field-input', { type: 'text', value, maxLength, autofocus: true, 'aria-label': label || title, enterkeyhint: 'done' });
    const submit = () => { result = input.value.trim(); p.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const p = openPanel({
      title, variant: 'dialog',
      body: h('label.field', {}, label ? h('span.field-label', {}, label) : null, input),
      footer: [
        h('button.btn', { type: 'button', onclick: () => p.close() }, t('common.cancel')),
        h('button.btn.primary', { type: 'button', onclick: submit }, confirmLabel),
      ],
      onClose: () => resolve(result),
    });
    setTimeout(() => { input.focus(); input.select(); }, 80);
  });
}
