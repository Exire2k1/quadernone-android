// App shell: boot (local server), router (Library ⇄ Editor), polling.
import * as prefs from './prefs.js';
import { store } from './store.js';
import { api } from './api.js';
import { t } from './i18n.js';
import { createLibrary } from './library/library.js';
import { createEditor } from './editor/editor.js';
import { handlePopState } from './ui/panel.js';
import { closeMenu } from './ui/menu.js';
import { toast, toastError } from './ui/toast.js';
import { startLocalServer } from './localserver/boot.js';
import { openSettings } from './panels/settings.js';
import { openTrash } from './panels/trash.js';
import { openCoverPanel } from './panels/cover.js';
import { askNewNote } from './panels/newnote.js';
import { createLocal } from './local/sync.js';
import * as diag from './diag.js';

const screens = document.getElementById('screens');
let library = null;
let editor = null;

// ------------------------------------------------------------------ router
const NOTE_RE = /^\/nota\/([0-9a-f-]{36})\/?$/;

function navigate(path, { replace = false } = {}) {
  if (location.pathname === path) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  route();
}

async function route() {
  closeMenu();
  const m = location.pathname.match(NOTE_RE);
  if (m) {
    editor ||= createEditor({
      goBack: () => (history.state?.fromLibrary ? history.back() : navigate('/', { replace: true })),
      openNote: (id, { replace = false } = {}) => navigate(`/nota/${id}`, { replace }),
    });
    show(editor.el);
    // ?pagina=N (from a search result): the page to show first.
    const page = Number(new URLSearchParams(location.search).get('pagina')) - 1;
    await editor.open(m[1], { page: page > 0 ? page : 0 });
  } else {
    if (location.pathname !== '/' || location.search) history.replaceState(history.state, '', '/');
    await editor?.close();
    show(library.el);
    library.shown();
  }
}

function show(el) {
  for (const c of screens.children) c.hidden = c !== el;
  if (!el.isConnected) screens.append(el);
  el.hidden = false;
}

window.addEventListener('popstate', () => {
  if (handlePopState()) return;
  route();
});

function openNote(id, { page = null } = {}) {
  history.pushState({ fromLibrary: true }, '', `/nota/${id}` + (page != null ? `?pagina=${page + 1}` : ''));
  route();
}

async function newNote(folderId) {
  const choice = await askNewNote();
  if (!choice) return;
  try {
    const res = await api.createNote(folderId, choice.title, choice.pageDefaults);
    for (const w of res.warnings || []) toast(w, { kind: 'warn', duration: 8000 });
    await store.load();
    openNote(res.note.id);
  } catch (e) {
    if (e.status !== 0) { toastError(e); return; }
    // Server unreachable: create it on this device; it is sent when the server is back.
    const rec = await createLocal(folderId, choice.title, choice.pageDefaults || prefs.get('pageDefaults'));
    store.addLocal(rec);
    toast(t('sync.createdOffline'));
    openNote(rec.id);
  }
}

// ------------------------------------------------------------------ boot
async function boot() {
  // The notes live on this device: the local server answers every /api call.
  await startLocalServer({ deviceName: () => prefs.get('deviceName') });
  diag.start();

  try {
    await store.load();
  } catch (e) {
    if (e.status === 401) toastError(e);
  }
  library = createLibrary({
    openNote,
    newNote,
    openTrash,
    openSettings: () => openSettings(),
    openCover: (n) => openCoverPanel(n),
  });
  await route();

  // Back in the foreground: re-read the folder (another app may have changed it).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !store.openNoteId) store.load().catch(() => {});
  });
}

boot();
