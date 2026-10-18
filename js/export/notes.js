// Esporta PDF from the Library: one note → a PDF, several → a .zip of PDFs.
// Notes are read from the device when they have unsent changes, otherwise from the server.
import { t } from '../i18n.js';
import { toast, toastError } from '../ui/toast.js';
import * as db from '../local/db.js';
import { fromServer, getNoteWithInk, isPending } from '../local/sync.js';
import * as files from '../local/files.js';
import { exportNotePdf, pdfName, saveFile, zipFiles } from './pdfexport.js';

async function source(id) {
  let rec = await db.getNote(id);
  if (!rec || !isPending(rec)) {
    try {
      rec = fromServer(await getNoteWithInk(id, { timeoutMs: 20000 }));
      await db.putNote(rec).catch(() => {});
    } catch (e) {
      if (!rec) throw e;
    }
  }
  return {
    title: rec.meta.title, pages: rec.pages.pages,
    strokes: (pid) => rec.ink?.[pid]?.strokes || [],
    file: (name) => files.getFile(id, name),
  };
}

export async function exportNotes(notes) {
  if (!notes.length) return;
  const dismiss = toast(t('export.working'), { duration: 0 });
  let progress = null;
  try {
    if (notes.length === 1) {
      const src = await source(notes[0].id);
      saveFile(await exportNotePdf(src), pdfName(src.title));
      toast(t('export.done'), { duration: 2500 });
      return;
    }
    const items = [];
    for (const [i, n] of notes.entries()) {
      progress?.(); progress = toast(t('export.many', { i: i + 1, n: notes.length }), { duration: 0 });
      const src = await source(n.id);
      items.push({ name: pdfName(src.title), bytes: await exportNotePdf(src) });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    saveFile(await zipFiles(items), `Quadernone ${stamp}.zip`, 'application/zip');
    toast(t('export.zipDone'), { duration: 2500 });
  } catch (e) {
    toastError(e.status !== undefined ? e : new Error(t('export.failed')));
  } finally {
    progress?.();
    dismiss();
  }
}
