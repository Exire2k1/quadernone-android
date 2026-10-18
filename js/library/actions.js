// Library operations shared by menus, the selection bar, drag-and-drop and the editor.
// Each one calls the API, refreshes the store and tells the user what happened.
import { api } from '../api.js';
import { store } from '../store.js';
import { t } from '../i18n.js';
import { toast, toastError } from '../ui/toast.js';
import { confirmDialog, promptDialog, openPanel } from '../ui/panel.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { COVER_COLORS } from './cover.js';
import { request } from '../api.js';
import * as prefs from '../prefs.js';
import { pageToSvg } from '../page/svg.js';

function showWarnings(res) {
  for (const w of res?.warnings || []) toast(w, { kind: 'warn', duration: 8000 });
}

async function run(fn) {
  try {
    const res = await fn();
    showWarnings(res);
    await store.load();
    return res;
  } catch (e) {
    toastError(e);
    // The state on the server may differ from ours (e.g. 404, 409): resync.
    store.load().catch(() => {});
    return null;
  }
}

const folderLabel = (id) => (id ? store.folders.get(id)?.name : t('views.root')) ?? t('views.root');

// ---------------------------------------------------------------- notes

export async function renameNote(note) {
  const title = await promptDialog({ title: t('common.rename'), label: t('library.noteTitle'), value: note.title });
  if (title === null || title === note.title) return;
  return run(() => api.saveNote(note.id, note.revision, { meta: { title } }));
}

export async function setFavorite(notes, favorite) {
  for (const n of notes) {
    if (n.favorite === favorite) continue;
    const ok = await run(() => api.saveNote(n.id, store.notes.get(n.id)?.revision ?? n.revision, { meta: { favorite } }));
    if (!ok) break;
  }
}

export async function setCover(note, cover) {
  return run(() => api.saveNote(note.id, store.notes.get(note.id)?.revision ?? note.revision, { meta: { cover } }));
}

export async function moveNotes(notes, folderId) {
  const toMove = notes.filter((n) => n.folderId !== folderId);
  if (!toMove.length) return;
  let moved = 0;
  try {
    for (const n of toMove) { showWarnings(await api.moveNote(n.id, folderId)); moved++; }
  } catch (e) { toastError(e); }
  await store.load().catch(() => {});
  if (moved) {
    toast(moved === 1 ? t('library.moved', { name: folderLabel(folderId) }) : t('library.movedMany', { n: moved, name: folderLabel(folderId) }));
  }
}

export async function trashNotes(notes, { ask = true } = {}) {
  if (!notes.length) return false;
  if (ask) {
    const days = store.serverSettings.trashRetentionDays;
    const ok = await confirmDialog({
      title: notes.length === 1 ? t('library.deleteNoteTitle', { name: notes[0].title }) : t('library.deleteNotesTitle', { n: notes.length }),
      body: t('library.deleteNoteBody', { days }), confirmLabel: t('common.delete'), danger: true,
    });
    if (!ok) return false;
  }
  let done = 0;
  try {
    for (const n of notes) { await api.deleteNote(n.id); done++; }
  } catch (e) { toastError(e); }
  await store.load().catch(() => {});
  if (done) toast(done === 1 ? t('library.trashed') : t('library.trashedMany', { n: done }));
  return done > 0;
}

// ---------------------------------------------------------------- AI suggestions

/** Moves the note where the AI suggested (the server creates missing folders). */
export async function acceptSuggestion(s) {
  try {
    showWarnings(await api.acceptSuggestion(s.noteId));
    store.dropSuggestion(s.noteId);
    toast(t('library.moved', { name: s.destination }));
  } catch (e) { toastError(e); }
  await store.load().catch(() => {});
}

export async function dismissSuggestion(s) {
  try {
    await api.dismissSuggestion(s.noteId);
    store.dropSuggestion(s.noteId);
    toast(t('ai.ignored'));
  } catch (e) { toastError(e); }
}

// ---------------------------------------------------------------- conflicts

const RESOLVE_TEXT = {
  original: () => ({ title: t('conflicts.confirmOriginalTitle'), body: t('conflicts.confirmOriginal') }),
  copy: () => ({ title: t('conflicts.confirmCopyTitle'), body: t('conflicts.confirmCopy') }),
  merge: () => ({ title: t('conflicts.confirmMergeTitle'), body: t('conflicts.confirmMerge') }),
  both: () => ({ title: t('conflicts.confirmBothTitle'), body: t('conflicts.confirmBoth') }),
};

/** Resolves a conflict copy on the server, then rebuilds the previews of merged pages. */
export async function resolveConflict(c, action) {
  const txt = RESOLVE_TEXT[action]();
  if (!c.originalId) txt.body = action === 'both' ? t('conflicts.confirmOrphanKeep') : t('conflicts.confirmOrphanDelete');
  const ok = await confirmDialog({ title: txt.title, body: txt.body, confirmLabel: t('common.confirm'), danger: action === 'original' && !c.originalId });
  if (!ok) return false;
  try {
    const res = await api.resolveConflict(c.copyId, action);
    store.dropConflict(c.copyId);
    if (res.note && res.changedPages?.length) await rebuildPreviews(res.note.id, res.changedPages);
    toast(t('conflicts.done.' + action));
  } catch (e) { toastError(e); }
  await store.load().catch(() => {});
  return true;
}

/** Previews are derived files made by the client: redo them for pages the server merged. */
async function rebuildPreviews(noteId, pageIds) {
  try {
    const data = await request('GET', `/notes/${noteId}?ink=1`);
    const list = data.pages?.pages || [];
    for (const pid of pageIds) {
      const index = list.findIndex((p) => p.id === pid);
      if (index === -1) continue;
      const svg = pageToSvg(list[index], { title: data.meta.title, pageNumber: index + 1, strokes: data.ink?.[pid]?.strokes || [] });
      await fetch(`${prefs.serverBase()}/api/notes/${noteId}/previews/${pid}`, {
        method: 'PUT', body: svg,
        headers: { 'Content-Type': 'image/svg+xml', 'X-Quadernone-Token': prefs.get('token'), 'X-Quadernone-Device': prefs.get('deviceName') },
      });
    }
  } catch { /* derived files: the next edit of the note redoes them */ }
}

// ---------------------------------------------------------------- folders

export async function newFolder(parentId) {
  const name = await promptDialog({ title: parentId ? t('library.newSubfolder') : t('library.newFolder'), label: t('library.folderName'), value: '' });
  if (!name) return null;
  const res = await run(() => api.createFolder(parentId, name));
  return res?.folder ?? null;
}

export async function renameFolder(folder) {
  const name = await promptDialog({ title: t('common.rename'), label: t('library.folderName'), value: folder.name });
  if (name === null || name === '' || name === folder.name) return;
  return run(() => api.updateFolder(folder.id, { name }));
}

export async function moveFolder(folder, parentId) {
  if (folder.parentId === parentId || folder.id === parentId) return;
  if (parentId && store.isDescendant(parentId, folder.id)) return;
  const res = await run(() => api.updateFolder(folder.id, { parentId }));
  if (res) toast(t('library.moved', { name: folderLabel(parentId) }));
}

export async function deleteFolder(folder) {
  let n = 0;
  try { n = (await api.folderCount(folder.id)).notes; } catch (e) { toastError(e); return false; }
  const body = n === 0 ? t('library.deleteFolderBodyEmpty') : n === 1 ? t('library.deleteFolderBodyOne') : t('library.deleteFolderBody', { n });
  const ok = await confirmDialog({ title: t('library.deleteFolderTitle', { name: folder.name }), body, confirmLabel: t('common.delete'), danger: true });
  if (!ok) return false;
  const res = await run(() => api.deleteFolder(folder.id));
  if (res?.leftovers) toast(t('library.leftovers'), { kind: 'warn', duration: 9000 });
  else if (res && res.trashedNotes) toast(res.trashedNotes === 1 ? t('library.trashed') : t('library.trashedMany', { n: res.trashedNotes }));
  return Boolean(res);
}

export function pickFolderColor(folder) {
  const choose = (color) => { p.close(); if (color !== folder.color) run(() => api.updateFolder(folder.id, { color })); };
  const p = openPanel({
    title: t('library.folderColor'), variant: 'dialog',
    body: h('div.swatches', {},
      h('button.swatch.swatch-none', { type: 'button', title: t('library.noColor'), 'aria-label': t('library.noColor'), onclick: () => choose(null) }, icon('close')),
      COVER_COLORS.map((c) => h(`button.swatch${folder.color === c ? '.active' : ''}`, {
        type: 'button', style: { background: c }, title: c, 'aria-label': c, onclick: () => choose(c),
      }))),
  });
}

/**
 * Folder picker. Resolves to a folder id, null for the root, or undefined if cancelled.
 * excludeId: a folder being moved (it and its descendants cannot be targets).
 */
export function pickFolder({ title = t('move.title'), excludeId = null, currentId } = {}) {
  return new Promise((resolve) => {
    let result;
    const pick = (id) => { result = id; p.close(); };
    const row = (f, depth) => {
      const invalid = excludeId && (f.id === excludeId || store.isDescendant(f.id, excludeId));
      const ic = icon('folder');
      if (f.color) ic.style.color = f.color;
      return [
        h('button.pick-row', {
          type: 'button', disabled: invalid || f.id === currentId, style: { paddingLeft: 12 + depth * 18 + 'px' }, onclick: () => pick(f.id),
        }, ic, h('span', {}, f.name)),
        ...(invalid ? [] : store.childFolders(f.id).flatMap((c) => row(c, depth + 1))),
      ];
    };
    const p = openPanel({
      title,
      body: h('div.pick-list', {},
        h('button.pick-row', { type: 'button', disabled: currentId === null, onclick: () => pick(null) }, icon('notebook'), h('span', {}, t('move.root'))),
        store.childFolders(null).flatMap((f) => row(f, 1))),
      onClose: () => resolve(result),
    });
  });
}
