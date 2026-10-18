// Cestino: deleted notes with days left and original path.
import { h, clear } from '../dom.js';
import { t, formatDate } from '../i18n.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { openPanel, confirmDialog } from '../ui/panel.js';
import { toast, toastError } from '../ui/toast.js';
import { renderCover } from '../library/cover.js';

export function openTrash() {
  const list = h('div.trash-list', {}, h('p.empty', {}, t('common.loading')));
  const emptyBtn = h('button.btn.danger', { type: 'button', disabled: true, onclick: () => emptyAll() }, t('trash.emptyAll'));
  let items = [];

  async function load() {
    try {
      const res = await api.trash();
      items = res.items;
      render();
    } catch (e) { clear(list).append(h('p.empty', {}, e.message)); }
  }

  function render() {
    clear(list);
    emptyBtn.disabled = items.length === 0;
    if (!items.length) { list.append(h('p.empty', {}, t('trash.empty'))); return; }
    for (const it of items) {
      const days = it.daysLeft <= 1 ? (it.daysLeft === 1 ? t('trash.dayLeft') : t('trash.lastDay')) : t('trash.daysLeft', { n: it.daysLeft });
      const folder = it.originalPath.includes('/') ? it.originalPath.slice(0, it.originalPath.lastIndexOf('/')) : t('trash.rootPath');
      list.append(h('div.trash-item', {},
        renderCover({ title: it.title, cover: it.cover }, { small: true }),
        h('div.trash-info', {},
          h('div.note-title', {}, it.title),
          h('div.note-sub', {}, `${days} · ${formatDate(it.deleted)}`),
          h('div.note-sub', {}, t('trash.from', { path: folder }))),
        h('div.trash-actions', {},
          h('button.btn.small', { type: 'button', onclick: () => restore(it) }, t('trash.restore')),
          h('button.btn.small.danger-text', { type: 'button', onclick: () => deleteNow(it) }, t('trash.deleteNow')))));
    }
  }

  async function restore(it) {
    try {
      await api.restore(it.trashId);
      const folder = it.originalPath.includes('/') ? it.originalPath.slice(0, it.originalPath.lastIndexOf('/')) : t('views.root');
      toast(t('trash.restored', { path: folder }));
      await Promise.all([load(), store.load()]);
    } catch (e) { toastError(e); load(); }
  }

  async function deleteNow(it) {
    if (!await confirmDialog({ title: t('trash.deleteNowTitle', { name: it.title }), body: t('trash.deleteNowBody'), confirmLabel: t('trash.deleteNow'), danger: true })) return;
    try { await api.deleteForever(it.trashId); toast(t('trash.deleted')); } catch (e) { toastError(e); }
    await Promise.all([load(), store.load().catch(() => {})]);
  }

  async function emptyAll() {
    if (!await confirmDialog({ title: t('trash.emptyTitle'), body: t('trash.emptyBody', { n: items.length }), confirmLabel: t('trash.emptyAll'), danger: true })) return;
    try { await api.emptyTrash(); toast(t('trash.emptied')); } catch (e) { toastError(e); }
    await Promise.all([load(), store.load().catch(() => {})]);
  }

  openPanel({ title: t('trash.title'), body: list, footer: [emptyBtn] });
  load();
}
