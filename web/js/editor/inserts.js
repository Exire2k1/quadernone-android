// Inserisci: images (file, gallery, camera, clipboard, drop), PDF as pages, slides (.pptx)
// as pages. Files are stored in the note's attachments/ (the original is never changed);
// offline, images and PDFs wait on the device and are uploaded before the pages that use
// them (local/sync.js). Slides need the server, which converts them with LibreOffice.
import { t } from '../i18n.js';
import { request } from '../api.js';
import { toast, toastError } from '../ui/toast.js';
import * as files from '../local/files.js';
import { prepareImage, imageExt, makeImageObject } from '../page/images.js';
import { openPdf, pageSizeMm, pageText } from '../page/pdf.js';

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const newPageId = () => 'pg-' + hex(4);
const newObjId = () => 'ob-' + hex(4);
const WEB_IMAGE = /^(jpg|jpeg|png|webp|gif)$/;

export const isImage = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp)$/i.test(f.name || '');
export const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
export const isSlides = (f) => /\.(pptx|ppt|odp)$/i.test(f.name || '') || /presentation/.test(f.type);

/** Picks files with the system dialog. accept: MIME list; capture: 'environment' for the camera. */
export function pickFiles({ accept = '', multiple = false, capture = null } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute('capture', capture);
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); }, { once: true });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); }, { once: true });
    document.body.append(input);
    input.click();
  });
}

/** A toast that stays until done (long uploads and conversions). */
function busy(text) {
  const dismiss = toast(text, { duration: 0 });
  return dismiss;
}

/**
 * ctx: { doc, view, selection, afterPages(newIndex) } — supplied by the editor.
 * Where to put new things: the centre of the visible part of the current page.
 */
function visibleSpot(ctx) {
  const page = ctx.doc.list[ctx.view.current] || ctx.doc.list[0];
  const r = ctx.view.pageRect(page.id);
  const sr = ctx.view.scroller.getBoundingClientRect();
  if (!r) return { page, at: null };
  const cy = (Math.max(r.top, sr.top) + Math.min(r.bottom, sr.bottom)) / 2;
  const cx = (Math.max(r.left, sr.left) + Math.min(r.right, sr.right)) / 2;
  const at = [(cx - r.left) / ctx.view.s, (cy - r.top) / ctx.view.s];
  return { page, at };
}

// ------------------------------------------------------------------ images

export async function insertImages(ctx, blobs, { page = null, at = null } = {}) {
  const spot = page ? { page, at } : visibleSpot(ctx);
  const added = [];
  let pending = false;
  for (const [i, blob] of blobs.entries()) {
    const done = busy(t('insert.addingImage', { name: blob.name || t('insert.image') }));
    try {
      const prep = await prepareImage(blob);
      const tag = files.randomTag();
      const ext = imageExt(blob, blob.name);
      const orig = await files.addFile(ctx.doc.id, blob, `img-${tag}.${ext}`);
      pending ||= orig.pending;
      // A display copy only when needed: very large photos, or formats not every browser shows.
      let viewName = null;
      if (Math.max(prep.natW, prep.natH) > 2560 || !WEB_IMAGE.test(ext)) {
        const v = await files.addFile(ctx.doc.id, prep.view, `img-${tag}-view.${prep.viewExt}`);
        pending ||= v.pending;
        viewName = v.name;
      }
      const pg = spot.page;
      const z = Math.max(0, ...(pg.objects || []).map((o) => o.z || 0)) + 1;
      const at = spot.at ? [spot.at[0] + i * 8, spot.at[1] + i * 8] : null;
      const obj = makeImageObject(newObjId(), { file: orig.name, view: viewName, natW: prep.natW, natH: prep.natH }, pg, at, z);
      ctx.doc.transact(() => { pg.objects ||= []; pg.objects.push(obj); });
      ctx.view.remountPage(pg.id);
      added.push(obj);
    } catch (e) {
      toastError(e.status !== undefined ? e : new Error(t('insert.imageFailed', { name: blob.name || '' })));
    } finally {
      done();
    }
  }
  if (pending) {
    ctx.doc.addPending({ files: true });
    toast(t('insert.savedOnDevice'), { duration: 3500 });
  }
  if (added.length) ctx.selection.setSelection(spot.page.id, new Set(), new Set(added.map((o) => o.id)));
  return added;
}

/** Ctrl+V / "Incolla": images from the system clipboard. */
export async function pasteImages(ctx) {
  if (!navigator.clipboard?.read) { toast(t('insert.pasteUnsupported')); return; }
  let items;
  try { items = await navigator.clipboard.read(); } catch { toast(t('insert.pasteDenied')); return; }
  const blobs = [];
  for (const it of items) {
    const type = it.types.find((x) => x.startsWith('image/'));
    if (type) blobs.push(new File([await it.getType(type)], `incollata.${type.split('/')[1]}`, { type }));
  }
  if (!blobs.length) { toast(t('insert.pasteEmpty')); return; }
  await insertImages(ctx, blobs);
}

// ------------------------------------------------------------------ PDF

/**
 * Adds the pages of a PDF after the current page (or in place of a still-empty only
 * page). storedName: the PDF is already in attachments/ (slides).
 */
export async function insertPdf(ctx, blob, { storedName = null, name = null } = {}) {
  const fileName = name || blob.name || 'documento.pdf';
  let done = busy(t('insert.readingPdf', { name: fileName }));
  try {
    let pdf;
    try {
      pdf = await openPdf(new Uint8Array(await blob.arrayBuffer()));
    } catch (e) {
      throw new Error(e?.name === 'PasswordException' ? t('insert.pdfProtected', { name: fileName }) : t('insert.pdfBroken', { name: fileName }));
    }
    let stored = storedName ? { name: storedName, pending: false } : null;
    if (!stored) {
      done(); done = busy(t('insert.uploadingPdf', { name: fileName }));
      stored = await files.addFile(ctx.doc.id, blob, fileName.replace(/\.pdf$/i, '') + '.pdf');
    }
    const n = pdf.numPages;
    const d = ctx.doc.pages.defaults;
    const pages = [];
    const texts = [];
    for (let i = 0; i < n; i++) {
      if (i % 10 === 0) { done(); done = busy(t('insert.pdfProgress', { i: i + 1, n })); }
      const size = await pageSizeMm(pdf, i);
      pages.push({
        id: newPageId(), size: { preset: 'pdf', widthMm: size.widthMm, heightMm: size.heightMm },
        orientation: size.widthMm > size.heightMm ? 'landscape' : 'portrait',
        background: { ...structuredClone(d.background), type: 'blank', paperColor: 'white' },
        pdf: { file: stored.name, pageIndex: i }, inkRevision: 0, objects: [],
      });
      texts.push({ pageIndex: i, text: await pageText(pdf, i).catch(() => '') });
    }
    pdf.destroy();
    // A note that is still one empty page: the PDF takes its place.
    const list = ctx.doc.list;
    const replaceEmpty = list.length === 1 && !list[0].pdf && !(list[0].objects || []).length && !ctx.doc.strokes(list[0].id).length;
    const at = replaceEmpty ? 0 : ctx.view.current + 1;
    ctx.doc.transact(() => { list.splice(at, replaceEmpty ? 1 : 0, ...pages); });
    ctx.doc.addPending({ files: stored.pending, pdfText: { [stored.name]: texts } });
    ctx.afterPages(at);
    toast(t('insert.pdfAdded', { n }), { duration: 2500 });
    return pages;
  } catch (e) {
    toastError(e);
    return null;
  } finally {
    done();
  }
}

/** Slides: converted to PDF by the server (LibreOffice), then added like a PDF. */
export async function insertSlides(ctx, blob) {
  const fileName = blob.name || 'slide.pptx';
  let done = busy(t('insert.uploadingSlides', { name: fileName }));
  try {
    if (ctx.doc.localOnly) await ctx.doc.save();   // the note must exist on the server
    let stored;
    try {
      stored = await files.upload(ctx.doc.id, blob, fileName);
    } catch (e) {
      throw e.status === 0 || e.status === 404 ? new Error(t('insert.slidesNeedServer')) : e;
    }
    done(); done = busy(t('insert.converting', { name: fileName }));
    const res = await request('POST', '/convert/pptx', { noteId: ctx.doc.id, name: stored }, { timeoutMs: 180000 });
    done(); done = () => {};
    const pdfBlob = await files.getFile(ctx.doc.id, res.name);
    return insertPdf(ctx, pdfBlob, { storedName: res.name, name: res.name });
  } catch (e) {
    toastError(e);
    return null;
  } finally {
    done();
  }
}

/** Dropped or pasted files: each goes where it belongs. */
export async function insertFiles(ctx, list) {
  const images = list.filter(isImage);
  if (images.length) await insertImages(ctx, images);
  for (const f of list) {
    if (isPdf(f)) await insertPdf(ctx, f);
    else if (isSlides(f)) await insertSlides(ctx, f);
    else if (!isImage(f)) toast(t('insert.unsupported', { name: f.name }), { duration: 3500 });
  }
}
