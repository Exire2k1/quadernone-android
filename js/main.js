// App shell: boot, router (Library ⇄ Editor), service worker, polling.
// Routes live in the hash (#/nota/<id>), so the app works from any static host and folder.
import { install as installLocalServer } from './local/intercept.js';
import * as prefs from './prefs.js';
import { store } from './store.js';
import { api } from './api.js';
import { t } from './i18n.js';
import { createLibrary } from './library/library.js';
import { createEditor } from './editor/editor.js';
import { handlePopState } from './ui/panel.js';
import { closeMenu } from './ui/menu.js';
import { toast, toastError } from './ui/toast.js';
import { showFirstRun } from './panels/firstrun.js';
import { openSettings } from './panels/settings.js';
import { openTrash } from './panels/trash.js';
import { openCoverPanel } from './panels/cover.js';
import { askNewNote } from './panels/newnote.js';
import * as diag from './diag.js';
import * as disk from './local/disk.js';
import { drive } from './local/drive.js';
import { driveSync } from './local/drivesync.js';

const screens = document.getElementById('screens');
let library = null;
let editor = null;

// ------------------------------------------------------------------ router
const NOTE_RE = /^#\/nota\/([0-9a-f-]{36})\/?(?:\?(.*))?$/;
const HOME = location.pathname + location.search;

function navigate(hash, { replace = false } = {}) {
  if (location.hash === hash || (hash === '#/' && !location.hash)) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', hash === '#/' ? HOME : hash);
  route();
}

async function route() {
  closeMenu();
  const m = location.hash.match(NOTE_RE);
  if (m) {
    editor ||= createEditor({
      goBack: () => (history.state?.fromLibrary ? history.back() : navigate('#/', { replace: true })),
      openNote: (id, { replace = false } = {}) => navigate(`#/nota/${id}`, { replace }),
    });
    show(editor.el);
    // ?pagina=N (from a search result): the page to show first.
    const page = Number(new URLSearchParams(m[2] || '').get('pagina')) - 1;
    await editor.open(m[1], { page: page > 0 ? page : 0 });
  } else {
    if (location.hash) history.replaceState(history.state, '', HOME);
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
  history.pushState({ fromLibrary: true }, '', `#/nota/${id}` + (page != null ? `?pagina=${page + 1}` : ''));
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
    askPersistence();
  } catch (e) {
    toastError(e);
  }
}

/** Notes live only in this browser until Drive is connected: ask it not to evict them. */
let persistAsked = false;
async function askPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  const ok = await disk.persist();
  if (!ok && !drive.connected) toast(t('storage.notPersistent'), { kind: 'warn', duration: 9000 });
}

// ------------------------------------------------------------------ service worker
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './' }).then((reg) => {
    // A new version is applied by itself when no note is open (everything is already on
    // the device); while writing, it waits for "Ricarica" or for the return to the library.
    let offered = false;
    const offerUpdate = (worker) => {
      if (!store.openNoteId) { worker.postMessage({ type: 'skipWaiting' }); return; }
      if (offered) return;
      offered = true;
      toast(t('settings.updateReady'), {
        duration: 0,
        action: { label: t('settings.reload'), fn: () => worker.postMessage({ type: 'skipWaiting' }) },
      });
    };
    store.addEventListener('change', () => { if (!store.openNoteId && reg.waiting) offerUpdate(reg.waiting); });
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    // An app left open for days still hears about new versions: check when it comes back.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
      });
    });
  }).catch(() => { /* the app still works online */ });
  let reloading = false;
  // Reload only when a new version replaces a running one: on the very first visit the
  // worker takes control after installing, and a reload would wipe the first-run form.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
}

// ------------------------------------------------------------------ boot
async function boot() {
  installLocalServer();
  registerServiceWorker();
  if (!prefs.isConfigured()) await showFirstRun();
  diag.start();
  disk.persist().then((ok) => { persistAsked ||= ok; });

  try {
    await store.load();
  } catch (e) {
    if (e.status === 401) toastError(e);
  }
  library = createLibrary({
    openNote,
    newNote,
    openTrash,
    openSettings: () => openSettings({ onSyncNow: () => driveSync.syncNow({ interactive: true }).then(() => store.load()).catch(() => {}) }),
    openCover: (n) => openCoverPanel(n),
  });
  await route();
  store.startPolling();
  driveSync.start(store);

  // Changes made by the Drive sync or in another tab of the app: the Library catches up.
  disk.onChange((info) => { if (info.fromDrive || info.remote || info.import) store.poll(); });
  const refresh = () => { if (document.visibilityState === 'visible') store.poll(); };
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('focus', refresh);
  window.addEventListener('online', refresh);
}

boot();
