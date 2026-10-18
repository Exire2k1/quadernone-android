// Pagine: thumbnails to jump to a page, drag to reorder, duplicate, delete, add.
// Reordering only changes the order in pages.json: page files are named by id.
import { h, clear } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { openPanel, confirmDialog } from '../ui/panel.js';
import { openMenu } from '../ui/menu.js';
import { renderPageCanvas } from '../page/thumb.js';

export function openPagesPanel({ doc, view, onJump, actions, extras = null }) {
  const list = h('div.pages-list');
  const thumbs = new Map(); // page JSON -> { strokes, canvas } (reused between renders)

  function thumb(page) {
    const key = JSON.stringify(page);
    const strokes = doc.strokes(page.id);   // stroke arrays are replaced, never mutated
    let t = thumbs.get(key);
    if (!t || t.strokes !== strokes) {
      const opts = { dpr: Math.min(2, devicePixelRatio || 1), strokes };
      t = { strokes, canvas: renderPageCanvas(page, 96, opts) };
      thumbs.set(key, t);
      // Images and PDF backgrounds load asynchronously: redraw the thumbnail when ready.
      const needs = page.pdf || (page.objects || []).some((o) => o.type === 'image');
      if (needs && extras) {
        const entry = t;
        extras(page).then((x) => {
          const c = renderPageCanvas(page, 96, { ...opts, ...x });
          c.className = 'page-thumb';
          entry.canvas.replaceWith(c);
          entry.canvas = c;
        }).catch(() => {});
      }
    }
    t.canvas.className = 'page-thumb';
    return t.canvas;
  }

  function render() {
    clear(list);
    doc.list.forEach((page, i) => {
      const item = h(`div.page-item${i === view.current ? '.current' : ''}`, { dataset: { id: page.id } },
        h('button.page-jump', { type: 'button', onclick: () => { onJump(i); p.close(); } }, thumb(page), h('span.page-num', {}, String(i + 1))),
        h('div.page-actions', {},
          h('button.icon-btn', { type: 'button', 'aria-label': t('pages.more'), title: t('pages.more'), onclick: (e) => itemMenu(e.currentTarget, i) }, icon('more')),
          h('div.drag-grip', { 'aria-label': t('pages.drag'), title: t('pages.drag'), onpointerdown: (e) => startReorder(e, item) }, icon('grip'))));
      list.append(item);
    });
  }

  function itemMenu(anchor, i) {
    const r = anchor.getBoundingClientRect();
    openMenu(r.left - 180, r.bottom, [
      { label: t('pages.insertBefore'), icon: 'plus', action: () => { actions.insertPage(i); render(); } },
      { label: t('pages.insertAfter'), icon: 'plus', action: () => { actions.insertPage(i + 1); render(); } },
      { label: t('pages.duplicate'), icon: 'copy', action: () => { actions.duplicatePage(i); render(); } },
      'sep',
      { label: t('pages.delete'), icon: 'trash', danger: true, disabled: doc.list.length < 2, action: async () => {
        if (await confirmDialog({ title: t('pages.deleteTitle', { n: i + 1 }), body: t('pages.deleteBody'), confirmLabel: t('common.delete'), danger: true })) {
          actions.deletePage(i); render();
        }
      } },
    ], { title: t('pages.page', { n: i + 1 }) });
  }

  // Drag the grip: items swap places live; the new order is applied on release.
  // Listeners sit on window, because moving the item in the DOM drops pointer capture.
  function startReorder(e, item) {
    e.preventDefault();
    const pointerId = e.pointerId;
    item.classList.add('dragging');
    const move = (ev) => {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      const siblings = [...list.children].filter((n) => n !== item);
      const after = siblings.find((n) => { const r = n.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
      if (after) { if (item.nextSibling !== after) list.insertBefore(item, after); } else if (list.lastElementChild !== item) list.append(item);
      const lr = list.parentElement.getBoundingClientRect();
      if (ev.clientY < lr.top + 40) list.parentElement.scrollTop -= 12;
      if (ev.clientY > lr.bottom - 40) list.parentElement.scrollTop += 12;
    };
    const up = (ev) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      item.classList.remove('dragging');
      const order = [...list.children].map((n) => n.dataset.id);
      if (order.join() !== doc.list.map((pg) => pg.id).join()) actions.reorder(order);
      render();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  render();
  const p = openPanel({
    title: t('pages.title'),
    body: list,
    footer: [h('button.btn', { type: 'button', onclick: () => { actions.insertPage(doc.list.length); render(); list.lastElementChild?.scrollIntoView({ block: 'nearest' }); } }, icon('plus'), h('span', {}, t('pages.add')))],
    className: 'pages-panel',
  });
  requestAnimationFrame(() => list.querySelector('.current')?.scrollIntoView({ block: 'center' }));
}
