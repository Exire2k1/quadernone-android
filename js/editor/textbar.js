// Contextual bar for the text box being edited: paragraph type, B I U S, lists,
// checklist, colour, size, alignment, delete. Buttons keep the caret in the box
// (pointerdown is prevented, so focus never leaves the text).
import { h, clear } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { openMenu } from '../ui/menu.js';

export const TEXT_COLORS = ['#1A1A1A', '#ECECEC', '#C62828', '#E65100', '#F9A825', '#2E7D32', '#00838F', '#1565C0', '#6A1B9A', '#AD1457'];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];

export function createTextBar(objects) {
  const bar = h('div.textbar', { hidden: true, role: 'toolbar', 'aria-label': t('text.bar') });
  const keep = (fn) => ({ onpointerdown: (e) => e.preventDefault(), onclick: fn });
  const btn = (name, label, fn, extra = {}) => h('button.tb-btn', { type: 'button', title: label, 'aria-label': label, ...keep(fn), ...extra }, icon(name));
  const txt = (text, label, fn, cls = '') => h(`button.tb-btn.tb-txt${cls}`, { type: 'button', title: label, 'aria-label': label, ...keep(fn) }, text);

  const blockBtn = h('button.tb-btn.tb-select', { type: 'button', ...keep((e) => blockMenu(e.currentTarget)) });
  const bBtn = txt('B', t('text.bold'), () => exec('bold'), '.b');
  const iBtn = txt('I', t('text.italic'), () => exec('italic'), '.i');
  const uBtn = txt('U', t('text.underline'), () => exec('underline'), '.u');
  const sBtn = txt('S', t('text.strike'), () => exec('strikeThrough'), '.s');
  const ulBtn = btn('listBullet', t('text.ul'), () => toggleList('ul'));
  const olBtn = btn('listNumber', t('text.ol'), () => toggleList('ol'));
  const ckBtn = btn('checklist', t('text.check'), () => toggleList('check'));
  const colorBtn = h('button.tb-btn.tb-color', { type: 'button', title: t('text.color'), 'aria-label': t('text.color'), ...keep((e) => colorMenu(e.currentTarget)) }, h('span.color-dot'));
  const sizeBtn = h('button.tb-btn.tb-select', { type: 'button', title: t('text.size'), ...keep((e) => sizeMenu(e.currentTarget)) });
  const alignBtn = btn('alignLeft', t('text.align'), () => cycleAlign());
  const delBtn = btn('trash', t('text.deleteBox'), () => objects.deleteEditing(), { class: 'danger' });

  bar.append(h('div.tb-group', {}, blockBtn), h('div.tb-group', {}, bBtn, iBtn, uBtn, sBtn),
    h('div.tb-group', {}, ulBtn, olBtn, ckBtn), h('div.tb-group', {}, colorBtn, sizeBtn, alignBtn), h('div.tb-group', {}, delBtn));

  const content = () => objects.editing?.el.querySelector('.tb-content');

  function exec(cmd, value) {
    document.execCommand(cmd, false, value);
    refresh();
  }

  /** Block divs touched by the current selection. */
  function selectedBlocks() {
    const root = content();
    const sel = window.getSelection();
    if (!root || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const blocks = [...root.children].filter((b) => range.intersectsNode(b));
    return blocks.length ? blocks : [root.lastElementChild].filter(Boolean);
  }

  function setType(type) {
    for (const b of selectedBlocks()) {
      b.dataset.t = type;
      if (type === 'check') b.dataset.done = b.dataset.done === '1' ? '1' : '0';
      else delete b.dataset.done;
    }
    refresh();
  }

  function toggleList(type) {
    const blocks = selectedBlocks();
    setType(blocks.length && blocks.every((b) => b.dataset.t === type) ? 'p' : type);
  }

  function blockMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, [
      ['h1', t('text.h1')], ['h2', t('text.h2')], ['h3', t('text.h3')], ['p', t('text.p')],
    ].map(([type, label]) => ({ label, action: () => { content()?.focus(); setType(type); } })), { title: t('text.paragraph') });
  }

  function colorMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const sel = window.getSelection();
    const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const pick = (c) => {
      menu.remove();
      const root = content();
      if (!root) return;
      root.focus();
      if (saved) { sel.removeAllRanges(); sel.addRange(saved); }
      // A selection gets coloured text; with just a caret the whole box changes colour.
      if (saved && !saved.collapsed) exec('foreColor', c);
      else { objects.setBoxStyle({ color: c }); refresh(); }
    };
    const menu = h('div.menu.color-menu', { onpointerdown: (e) => e.preventDefault() },
      h('div.swatches', {}, TEXT_COLORS.map((c) => h('button.swatch.sm', { type: 'button', style: { background: c }, 'aria-label': c, onclick: () => pick(c) }))));
    document.body.append(menu);
    menu.style.left = Math.min(r.left, innerWidth - 260) + 'px';
    menu.style.top = r.bottom + 4 + 'px';
    const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  }

  function sizeMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const cur = objects.editing?.obj.style.sizePt;
    openMenu(r.left, r.bottom + 4, SIZES.map((n) => ({
      label: (n === cur ? '✓ ' : '') + n + ' pt', action: () => { content()?.focus(); objects.setBoxStyle({ sizePt: n }); refresh(); },
    })), { title: t('text.size') });
  }

  function cycleAlign() {
    const order = ['left', 'center', 'right'];
    const cur = objects.editing?.obj.style.align || 'left';
    objects.setBoxStyle({ align: order[(order.indexOf(cur) + 1) % 3] });
    refresh();
  }

  /** Reflects the formatting at the caret. */
  function refresh() {
    const ed = objects.editing;
    if (!ed) return;
    const blocks = selectedBlocks();
    const type = blocks[0]?.dataset.t || 'p';
    blockBtn.textContent = { h1: t('text.h1'), h2: t('text.h2'), h3: t('text.h3') }[type] || t('text.p');
    const on = (b, v) => b.classList.toggle('active', Boolean(v));
    on(bBtn, document.queryCommandState('bold'));
    on(iBtn, document.queryCommandState('italic'));
    on(uBtn, document.queryCommandState('underline'));
    on(sBtn, document.queryCommandState('strikeThrough'));
    on(ulBtn, type === 'ul'); on(olBtn, type === 'ol'); on(ckBtn, type === 'check');
    colorBtn.querySelector('.color-dot').style.background = ed.obj.style.color || '#1A1A1A';
    sizeBtn.textContent = (ed.obj.style.sizePt || 12) + ' pt';
    clear(alignBtn).append(icon({ left: 'alignLeft', center: 'alignCenter', right: 'alignRight' }[ed.obj.style.align || 'left']));
  }

  document.addEventListener('selectionchange', () => { if (!bar.hidden) refresh(); });
  objects.addEventListener('editstart', () => { bar.hidden = false; setTimeout(refresh, 0); });
  objects.addEventListener('editend', () => { bar.hidden = true; });
  return bar;
}
