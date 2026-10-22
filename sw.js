// Quadernone Locale service worker: the app works with no network once opened.
// - App shell: precached, cache-first. A new VERSION installs a new cache; the app updates
//   itself when no note is open (see js/main.js).
// - pdf.js fonts are kept the first time a PDF needs them.
// - Nothing else is touched: notes never go through here (they are in IndexedDB), and Google
//   (sign-in, Drive) always goes straight to the network.
// Paths are relative to the worker's scope, so the app can live in any folder of any host.
const VERSION = '1.0.3'; // keep in sync with js/version.js
const SHELL = `qnl-shell-${VERSION}`;
const RUNTIME = 'qnl-runtime-v1';

const SHELL_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'config.js',
  'css/app.css',
  'i18n/it.js',
  'js/api.js',
  'js/bootguard.js',
  'js/diag.js',
  'js/dom.js',
  'js/i18n.js',
  'js/icons.js',
  'js/main.js',
  'js/prefs.js',
  'js/store.js',
  'js/version.js',
  'js/page/images.js',
  'js/page/ink.js',
  'js/page/pageview.js',
  'js/page/paper.js',
  'js/page/pdf.js',
  'js/page/shapes.js',
  'js/page/svg.js',
  'js/page/textbox.js',
  'js/page/textmodel.js',
  'js/page/thumb.js',
  'js/editor/doc.js',
  'js/editor/editor.js',
  'js/editor/formatpanel.js',
  'js/editor/imagecrop.js',
  'js/editor/input.js',
  'js/editor/inserts.js',
  'js/editor/objects.js',
  'js/editor/pagespanel.js',
  'js/editor/pdfbar.js',
  'js/editor/pressure.js',
  'js/editor/ruler.js',
  'js/editor/selection.js',
  'js/editor/textbar.js',
  'js/editor/tools.js',
  'js/editor/toolui.js',
  'js/ui/menu.js',
  'js/ui/panel.js',
  'js/ui/popover.js',
  'js/ui/toast.js',
  'js/library/actions.js',
  'js/library/cover.js',
  'js/library/coverimages.js',
  'js/library/gestures.js',
  'js/library/library.js',
  'js/export/notes.js',
  'js/export/pdfexport.js',
  'js/panels/cover.js',
  'js/panels/firstrun.js',
  'js/panels/format.js',
  'js/panels/import.js',
  'js/panels/newnote.js',
  'js/panels/pentest.js',
  'js/panels/search.js',
  'js/panels/settings.js',
  'js/panels/trash.js',
  'js/import/samsung.js',
  'js/import/sdocx.js',
  'js/local/backup.js',
  'js/local/db.js',
  'js/local/disk.js',
  'js/local/drive.js',
  'js/local/drivesync.js',
  'js/local/errors.js',
  'js/local/files.js',
  'js/local/intercept.js',
  'js/local/names.js',
  'js/local/notefiles.js',
  'js/local/server.js',
  'js/local/sync.js',
  'vendor/pdfjs/pdf.min.js',
  'vendor/pdfjs/pdf.worker.min.js',
  'vendor/pdf-lib/pdf-lib.esm.min.js',
  'vendor/jszip/jszip.min.js',
  'vendor/perfect-freehand/index.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon.svg',
];

const scoped = (p) => new URL(p, self.registration.scope).href;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((u) => new Request(scoped(u), { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('qnl-shell-') && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  if (!url.href.startsWith(self.registration.scope)) return;
  e.respondWith(handle(e.request, url));
});

async function handle(request, url) {
  const shell = await caches.open(SHELL);
  // Every navigation inside the app gets index.html (routes live in the hash).
  const key = request.mode === 'navigate' ? scoped('index.html') : request;
  const hit = await shell.match(key, { ignoreSearch: true }) || await (await caches.open(RUNTIME)).match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok && url.href.startsWith(scoped('vendor/'))) (await caches.open(RUNTIME)).put(request, res.clone());
    return res;
  } catch {
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
