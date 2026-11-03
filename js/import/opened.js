// Files opened "with Quadernone" from outside the app. Each PDF becomes a new note in the
// main folder, ready to write on, exactly as with Importa; a single file opens straight
// in the editor.
//
// Two ways in, depending on the system:
// - "Apri con › Quadernone" (Windows, macOS, Linux, ChromeOS: Chrome/Edge 102+): the
//   manifest's file_handlers; the files arrive through window.launchQueue, also when the
//   app is already open.
// - "Condividi › Quadernone" (Android, where an installed web app cannot be an "Apri con"
//   target): the manifest's share_target. The service worker receives the shared files
//   (POST to ./condividi), keeps them in the SHARE cache and opens the app, which picks
//   them up here at start.
import { t } from '../i18n.js';
import { toast } from '../ui/toast.js';
import { isPdf } from '../editor/inserts.js';
import { importItem } from '../panels/import.js';

export const SHARE_CACHE = 'qnl-shared-files';   // same name in sw.js

let busy = Promise.resolve();

/**
 * Starts listening for opened and shared files. openNote(id) shows a note; refresh()
 * reloads the Library. Files are imported one batch at a time, in arrival order.
 */
export function listenForOpenedFiles({ openNote, refresh }) {
  const run = (files) => { busy = busy.then(() => importOpened(files, { openNote, refresh })).catch(() => {}); };
  takeShared().then((files) => { if (files.length) run(files); });
  if ('launchQueue' in window && 'files' in (window.LaunchParams?.prototype || {})) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      const files = [];
      for (const handle of params.files) {
        try { if (handle.kind === 'file') files.push(await handle.getFile()); } catch { /* unreadable: skipped */ }
      }
      if (files.length) run(files);
    });
  }
}

/** The files left by the service worker after a share, removed as they are read. */
async function takeShared() {
  if (!('caches' in window)) return [];
  try {
    if (!(await caches.has(SHARE_CACHE))) return [];
    const cache = await caches.open(SHARE_CACHE);
    const files = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      await cache.delete(req);
      if (!res) continue;
      const name = decodeURIComponent(res.headers.get('X-Qn-Name') || 'Documento.pdf');
      const lastModified = Number(res.headers.get('X-Qn-Modified')) || Date.now();
      files.push(new File([await res.blob()], name, { type: res.headers.get('Content-Type') || '', lastModified }));
    }
    await caches.delete(SHARE_CACHE);
    return files;
  } catch {
    return [];
  }
}

async function importOpened(files, { openNote, refresh }) {
  const pdfs = files.filter(isPdf);
  if (pdfs.length < files.length) toast(t('opened.notPdf', { n: files.length - pdfs.length }), { kind: 'warn', duration: 6000 });
  if (!pdfs.length) return;
  const ids = [];
  for (const file of pdfs) {
    const done = toast(t('opened.importing', { name: file.name }), { duration: 0 });
    try {
      const id = await importItem({ file, name: file.name, kind: 'pdf', lastModified: file.lastModified, reason: '' }, null);
      if (id) ids.push(id);
    } catch (e) {
      toast(t('opened.failed', { name: file.name, reason: e.message || String(e) }), { kind: 'error', duration: 8000 });
    } finally {
      done();
    }
  }
  await refresh().catch(() => {});
  if (ids.length === 1) openNote(ids[0]);
  else if (ids.length > 1) toast(t('opened.many', { n: ids.length }), { duration: 6000 });
}
