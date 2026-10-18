// Editor screen: toolbar, pages, handwriting, text boxes, autosave.
// Toolbar order: Indietro, Annulla, Ripeti, Penna, Evidenziatore, Gomma, Lazo, Forme,
// Testo, Inserisci, Righello, Colore, Modalità dito, Pagine, Formato e sfondo, Zoom, Altro.
// A second tap on the active tool opens its options. On phones the toolbar keeps
// Indietro, Annulla, Ripeti, Penna, Evidenziatore, Gomma, Lazo, Testo; the rest is in Altro.
import { h, iconButton, fill } from '../dom.js';
import { icon } from '../icons.js';
import { t, formatFull, formatBytes } from '../i18n.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { openMenu } from '../ui/menu.js';
import { openPanel, panelOpen, promptDialog, confirmDialog } from '../ui/panel.js';
import { popoverOpenFor } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import * as act from '../library/actions.js';
import { openCoverPanel } from '../panels/cover.js';
import { NoteDoc } from './doc.js';
import { ObjectLayer } from './objects.js';
import { createTextBar } from './textbar.js';
import { openPagesPanel } from './pagespanel.js';
import { openFormatPanel } from './formatpanel.js';
import { PageView } from '../page/pageview.js';
import { pageToSvg } from '../page/svg.js';
import { renderCoverPng } from '../page/thumb.js';
import * as prefs from '../prefs.js';
import * as db from '../local/db.js';
import { fromServer, getNoteWithInk, isPending } from '../local/sync.js';
import { drawStrokes, isHighlighter, geometry } from '../page/ink.js';
import { tools } from './tools.js';
import { InkInput } from './input.js';
import { Selection } from './selection.js';
import { Ruler } from './ruler.js';
import { openToolOptions, openColorPanel, closePopover } from './toolui.js';
import { PdfPainter } from '../page/pdf.js';
import * as inserts from './inserts.js';
import { createPdfBar } from './pdfbar.js';
import { openCropPanel } from './imagecrop.js';
import { hasClipboard } from './selection.js';
import * as files from '../local/files.js';
import { exportNotePdf, pdfName, saveFile } from '../export/pdfexport.js';
import { renderImageCover } from '../page/thumb.js';

const newPageId = () => 'pg-' + [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
const newObjId = () => 'ob-' + [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
const mqPhone = matchMedia('(max-width: 599px)');
const TOOL_BUTTONS = [['pen', 'pen'], ['highlighter', 'highlighter'], ['eraser', 'eraser'], ['lasso', 'lasso'], ['shape', 'shapes'], ['text', 'textTool']];
const HINT_AFTER_STROKES = 40;


export function createEditor({ goBack, openNote }) {
  let doc = null, view = null, objects = null, textbar = null;
  let input = null, selection = null, ruler = null, pdf = null, pdfBar = null;
  let penStrokes = 0;
  let openSeq = 0;
  let uploading = Promise.resolve();
  let derivedTimer = 0, lastDerived = 0;
  const DERIVED_EVERY_MS = 30000, DERIVED_IDLE_MS = 5000;
  let listeners = null;   // AbortController for the listeners of the open document

  // ------------------------------------------------------------------ toolbar
  const title = h('input.editor-title', { type: 'text', placeholder: t('editor.titlePlaceholder'), maxLength: 200, 'aria-label': t('library.noteTitle'), enterkeyhint: 'done' });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  title.addEventListener('change', () => {
    if (!doc) return;
    const v = title.value.trim() || t('newNote.untitled');
    title.value = v;
    if (v !== doc.meta.title) doc.setMeta({ title: v });
  });

  const undoBtn = iconButton('undo', t('editor.undo'), () => undo());
  const redoBtn = iconButton('redo', t('editor.redo'), () => redo());
  const toolBtns = {};
  for (const [name, ic] of TOOL_BUTTONS) {
    toolBtns[name] = iconButton(ic, t('tools.' + name), (e) => onToolTap(name, e.currentTarget),
      { class: 'tool' + (name === 'shape' ? ' wide-only' : ''), dataset: { tool: name }, 'aria-pressed': 'false' });
  }
  const insertBtn = iconButton('insert', t('editor.insert'), (e) => insertMenu(e.currentTarget), { class: 'wide-only' });
  const rulerBtn = iconButton('ruler', t('tools.ruler'), () => toggleRuler(), { class: 'wide-only toggle', 'aria-pressed': 'false' });
  const colorBtn = h('button.icon-btn.wide-only.color-btn', { type: 'button', title: t('tools.color'), 'aria-label': t('tools.color'), onclick: (e) => showColors(e.currentTarget) }, h('span.color-dot'));
  const fingerBtn = iconButton('penOnly', t('tools.finger'), () => toggleFinger(), { class: 'wide-only toggle', 'aria-pressed': 'false' });
  const pagesBtn = iconButton('pages', t('editor.pages'), () => showPages(), { class: 'wide-only' });
  const formatBtn = iconButton('format', t('editor.format2'), () => showFormat(), { class: 'wide-only' });
  const zoomBtn = h('button.zoom-btn.wide-only', { type: 'button', title: t('editor.zoom'), onclick: (e) => zoomMenu(e.currentTarget) }, '100%');
  const saveDot = h('span.save-state', { role: 'status' });
  const sep = () => h('span.tb-sep');
  const toolbar = h('header.editor-bar', {},
    iconButton('back', t('common.back'), () => leave()),
    title,
    h('div.tools', {}, undoBtn, redoBtn, sep(),
      ...TOOL_BUTTONS.map(([n]) => toolBtns[n]), sep(),
      insertBtn, rulerBtn, colorBtn, fingerBtn, h('span.tb-sep.wide-only'),
      pagesBtn, formatBtn, zoomBtn),
    saveDot,
    iconButton('more', t('editor.more'), (e) => moreMenu(e.currentTarget)));

  const banner = h('div.conflict-banner', { hidden: true });
  const scroller = h('div.editor-scroll', { tabIndex: -1 });
  const pageIndicator = h('div.page-indicator', { role: 'status' });
  const barSlot = h('div.textbar-slot');
  const stage = h('div.editor-stage', {}, scroller, pageIndicator);
  const root = h('div.editor', {}, toolbar, barSlot, banner, stage);
  tools.addEventListener('change', () => renderTools());

  // ------------------------------------------------------------------ open / close
  /** opts.page: 0-based page to show first (search results). */
  async function open(id, { page = 0 } = {}) {
    const seq = ++openSeq;
    await close();
    fill(scroller);
    banner.hidden = true;
    title.value = store.notes.get(id)?.title || '';
    // Local copy first: if it has changes not yet on the server, it is the newest version.
    // Otherwise ask the server (short timeout) and fall back to the copy on the device.
    db.pin(id);   // its handwriting stays in memory while open (fast saves)
    let rec = await db.getNote(id);
    if (!rec || !isPending(rec)) {
      try {
        rec = fromServer(await getNoteWithInk(id, { timeoutMs: 8000 }));
        await db.putNote(rec);
      } catch (e) {
        if (!rec) {
          const msg = e.status === 0 ? t('errors.notOffline') : e.message;
          toast(msg, { kind: 'error', duration: 7000 });
          fill(scroller, h('p.empty', {}, msg));
          db.unpin(id);
          return;
        }
      }
    }
    if (seq !== openSeq) return;
    doc = new NoteDoc(rec);
    store.openNoteId = id;
    if (isPending(rec)) doc.save();   // changes made offline: send them now
    title.value = doc.meta.title;
    document.title = `${doc.meta.title} · Quadernone`;
    const c = doc.meta.conflictOf;
    if (c) {
      banner.hidden = false;
      fill(banner, icon('alert'), h('span', {}, t('editor.conflictBanner', { device: c.device, date: formatFull(c.time) })));
    }

    const inkOf = (page) => (input ? input.inkFor(page.id) : doc.strokes(page.id));
    pdf = new PdfPainter(id);
    view = new PageView(scroller, {
      paintPdf: (ctx, page, tile, s, dpr, done) => pdf.paint(ctx, page, tile, s, dpr, done),
      mount: (page, layer) => objects.mount(page, layer),
      unmount: (page, layer) => objects.unmount(page, layer),
      drawUnder: (ctx, page, y0, hMm) => drawStrokes(ctx, inkOf(page), 'under', y0, hMm),
      drawOver: (ctx, page, y0, hMm) => drawStrokes(ctx, inkOf(page), 'over', y0, hMm),
      // Handwriting (not highlighter) crossing the mm range [y0, y0 + hMm] of a tile.
      hasOver: (page, y0 = 0, hMm = Infinity) => inkOf(page).some((st) => {
        if (isHighlighter(st)) return false;
        const b = geometry(st).bbox;
        return b[3] >= y0 && b[1] <= y0 + hMm;
      }),
    });
    objects = new ObjectLayer({ doc, view, getTool: () => tools.active });
    textbar = createTextBar(objects);
    objects.addEventListener('editstart', renderUndo);
    objects.addEventListener('editend', renderUndo);
    ruler = new Ruler(stage, view);
    selection = new Selection({ doc, view, getInput: () => input, onImage: (kind, obj) => onImageAction(kind, obj) });
    objects.addEventListener('imagetap', (e) => {
      const { obj, page: pg } = e.detail;
      if (tools.active === 'text') objects.endEdit();
      selection.setSelection(pg.id, new Set(), new Set([obj.id]));
    });
    pdfBar = createPdfBar({
      doc, view, pdf,
      insertBlankAfter: (i) => { pageActions.insertPage(i + 1); view.scrollToPage(i + 1, { smooth: true }); },
      exportPdf: () => exportCurrent(),
    });
    input = new InkInput({
      stage, view, doc, ruler, selection,
      onUndo: () => undo(), onRedo: () => redo(), onPenStroke: (type) => afterPenStroke(type),
    });
    input.addEventListener('penbutton', () => { if (!prefs.get('penButtonSeen')) prefs.set('penButtonSeen', true); });
    selection.addEventListener('change', renderBars);
    fill(barSlot, textbar, pdfBar.el);
    objects.addEventListener('editstart', renderBars);
    objects.addEventListener('editend', renderBars);
    stage.append(selection.bar);   // floats over the page: the page does not jump when selecting
    renderBars();
    listeners = new AbortController();
    const on = { signal: listeners.signal };
    view.addEventListener('pagechange', () => { renderIndicator(); renderBars(); doc.save(); });
    view.addEventListener('zoom', () => { zoomBtn.textContent = view.percent + '%'; prefs.set('zoomMode', view.zoomMode); });
    doc.addEventListener('change', renderUndo, on);
    doc.addEventListener('state', renderSaveState, on);
    doc.addEventListener('saved', (e) => onSaved(e.detail), on);
    doc.addEventListener('restored', (e) => onRestored(e.detail), on);
    doc.addEventListener('conflict', (e) => onConflict(e.detail), on);
    doc.addEventListener('saveerror', (e) => { if (e.detail.status !== 0) toastError(e.detail); }, on);
    view.zoomMode = prefs.get('zoomMode') === 'page' ? 'page' : 'width';
    view.setPages(doc.list);
    view.fit(view.zoomMode, { keep: true });
    view.scrollToPage(Math.min(Math.max(0, page), doc.list.length - 1));
    renderBars();
    if (!tools.isDrawing() && tools.active !== 'text') tools.setActive('pen');
    renderTools();
    renderUndo(); renderSaveState(); renderIndicator();
    // Notes created before phase 2 have no cover yet.
    if (!store.notes.get(id)?.hasCoverImage) queueCover();
  }

  /**
   * Finishes editing. The note is already on the device; the push to the server goes on
   * in the background (offline it waits for the next sync), so leaving never blocks.
   */
  async function close() {
    if (!doc) return;
    objects?.endEdit();
    closePopover();
    const d = doc;
    await d.persist();
    listeners?.abort();
    store.openNoteId = null;
    clearTimeout(derivedTimer); derivedTimer = 0;
    // The PDF renderer stays alive until the cover (which may show a PDF page) is made.
    const painter = pdf;
    pdf = null;
    d.save()
      .then(() => queueDerived(d, painter))
      .finally(() => { painter?.dispose(); d.dispose(); db.unpin(d.id); store.load().catch(() => {}); });
    teardown();
  }

  /** Removes the page view and its input layers (the document itself is handled by the caller). */
  function teardown() {
    selection?.clear();
    selection?.bar.remove();
    input?.dispose();
    ruler?.el.remove();
    view?.dispose();
    pdf?.dispose();
    doc = view = objects = input = selection = ruler = pdf = pdfBar = null;
    fill(barSlot);
    renderTools();
  }

  async function leave() {
    await close();
    goBack();
  }

  // ------------------------------------------------------------------ tools and actions
  function setTool(next) {
    if (next !== 'text') objects?.endEdit();
    if (next !== 'lasso') selection?.clear();
    closePopover();
    tools.setActive(next);
    renderTools();
  }

  function onToolTap(name, btn) {
    if (tools.active !== name) { setTool(name); return; }
    // Second tap on the active tool: its options.
    if (popoverOpenFor(btn)) closePopover();
    else openToolOptions(name, btn, toolCtx);
  }

  const toolCtx = {
    applyColor: (c) => applyColor(c),
    openColor: () => showColors(mqPhone.matches ? toolbar.querySelector('.tools') : colorBtn),
    clearPage: () => clearPage(),
  };

  function applyColor(c) {
    tools.setColor(c);
    if (selection?.active) selection.setColor(c);
  }

  function showColors(anchor) {
    if (popoverOpenFor(anchor)) { closePopover(); return; }
    openColorPanel(anchor, { applyColor, eyedrop });
  }

  /** Eyedropper: the system one where available (Chrome on Windows), else tap a stroke. */
  async function eyedrop() {
    if ('EyeDropper' in window) {
      try {
        const r = await new window.EyeDropper().open();
        applyColor(r.sRGBHex.toUpperCase());
        toast(t('tools.picked'), { duration: 1500 });
      } catch { /* cancelled */ }
      return;
    }
    if (!input) return;
    toast(t('tools.pickHint'), { duration: 4000 });
    input.pickColor = (c) => {
      if (c) { applyColor(c.toUpperCase()); toast(t('tools.picked'), { duration: 1500 }); }
      else toast(t('tools.noColorHere'), { duration: 2500 });
    };
  }

  function toggleRuler() {
    if (!ruler) return;
    ruler.toggle();
    renderTools();
  }

  function toggleFinger() {
    const next = tools.s.fingerMode === 'both' ? 'pen' : 'both';
    tools.set('fingerMode', next);
    toast(t(next === 'both' ? 'tools.fingerOn' : 'tools.fingerOff'), { duration: 2200 });
  }

  async function clearPage() {
    if (!doc) return;
    const i = view.current, page = doc.list[i];
    const ok = await confirmDialog({ title: t('tools.clearTitle', { n: i + 1 }), body: t('tools.clearBody'), confirmLabel: t('tools.clearPage'), danger: true });
    if (!ok || !doc || !doc.list.includes(page)) return;
    selection.clear();
    const changed = doc.transact(() => {
      if (doc.strokes(page.id).length) doc.setInk(page.id, []);
      if ((page.objects || []).some((o) => o.type === 'shape')) page.objects = page.objects.filter((o) => o.type !== 'shape');
    });
    if (changed) {
      view.invalidateInk(page.id);
      view.remountPage(page.id);
      toast(t('tools.cleared'), { duration: 1800 });
    }
  }

  function renderTools() {
    const active = tools.active;
    root.dataset.tool = active;
    for (const [name, btn] of Object.entries(toolBtns)) {
      const on = name === active;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    toolBtns.pen.style.setProperty('--c', tools.s.pen.color);
    toolBtns.highlighter.style.setProperty('--c', tools.s.highlighter.color);
    toolBtns.shape.style.setProperty('--c', tools.s.shape.color);
    colorBtn.querySelector('.color-dot').style.background = tools.color;
    const both = tools.s.fingerMode === 'both';
    fill(fingerBtn, icon(both ? 'hand' : 'penOnly'));
    fingerBtn.title = `${t('tools.finger')}: ${t(both ? 'tools.fingerBoth' : 'tools.fingerPen')}`;
    fingerBtn.setAttribute('aria-label', fingerBtn.title);
    fingerBtn.classList.toggle('active', both);
    fingerBtn.setAttribute('aria-pressed', String(both));
    rulerBtn.classList.toggle('active', !!ruler?.visible);
    rulerBtn.setAttribute('aria-pressed', String(!!ruler?.visible));
    if (active !== 'text' && objects?.editing) objects.endEdit();
  }

  function renderBars() {
    if (!selection) return;
    selection.bar.hidden = !selection.active;
    if (selection.active && objects?.editing) objects.endEdit();
    pdfBar?.update(!selection.active && !objects?.editing);
  }

  /** After ~40 pen strokes without any side-button press: one hint about the button. */
  function afterPenStroke(type) {
    if (type !== 'pen' || prefs.get('penButtonSeen') || prefs.get('hintSideButton')) return;
    if (++penStrokes < HINT_AFTER_STROKES) return;
    prefs.set('hintSideButton', true);
    const ua = navigator.userAgent;
    const key = /Android/i.test(ua) ? 'hints.sideButtonAndroid' : /Windows/i.test(ua) ? 'hints.sideButtonWindows' : 'hints.sideButton';
    toast(t(key), { duration: 15000 });
  }

  function onRestored({ pages, inkPages }) {
    selection?.clear();
    if (pages) {
      view.setPages(doc.list);
      for (const p of doc.list) view.refreshPage(p.id);
      objects.remountAll();
    }
    for (const pid of inkPages) view.invalidateInk(pid);
    renderIndicator();
  }

  function undo() {
    if (!doc) return;
    if (objects.editing) objects.endEdit();
    selection?.clear();
    if (doc.undo()) toast(t('editor.undone'), { duration: 1200 });
  }
  function redo() {
    if (!doc) return;
    if (objects.editing) objects.endEdit();
    selection?.clear();
    doc.redo();
  }

  function renderUndo() {
    undoBtn.disabled = !doc?.undoStack.length && !objects?.editing;
    redoBtn.disabled = !doc?.redoStack.length;
  }

  function renderSaveState() {
    const s = doc?.state || 'saved';
    saveDot.className = 'save-state ' + s;
    saveDot.title = t('editor.state.' + s);
    saveDot.setAttribute('aria-label', saveDot.title);
  }

  function renderIndicator() {
    if (!doc) return;
    pageIndicator.textContent = `${view.current + 1} / ${doc.list.length}`;
  }

  const pageActions = {
    insertPage(index) {
      doc.change(() => {
        const d = doc.pages.defaults;
        doc.list.splice(index, 0, { id: newPageId(), size: structuredClone(d.size), orientation: d.orientation, background: structuredClone(d.background), pdf: null, inkRevision: 0, objects: [] });
      });
      view.setPages(doc.list);
      renderIndicator();
    },
    duplicatePage(index) {
      doc.change(() => {
        const copy = structuredClone(doc.list[index]);
        copy.id = newPageId();
        copy.inkRevision = 0;
        for (const o of copy.objects) o.id = newObjId();
        doc.list.splice(index + 1, 0, copy);
      });
      view.setPages(doc.list);
      renderIndicator();
    },
    deletePage(index) {
      if (doc.list.length < 2) return;
      doc.change(() => { doc.list.splice(index, 1); });
      view.setPages(doc.list);
      renderIndicator();
    },
    reorder(ids) {
      doc.change(() => {
        const byId = new Map(doc.list.map((p) => [p.id, p]));
        doc.list.splice(0, doc.list.length, ...ids.map((id) => byId.get(id)).filter(Boolean));
      });
      view.setPages(doc.list);
      renderIndicator();
    },
  };

  function showPages() {
    objects.endEdit();
    const d = doc, painter = pdf;
    openPagesPanel({ doc, view, onJump: (i) => view.scrollToPage(i), actions: pageActions, extras: (page) => pageExtras(d, page, painter) });
  }

  function showFormat() {
    objects.endEdit();
    openFormatPanel({ doc, view, onApplied: () => { view.setPages(doc.list); for (const p of doc.list) view.refreshPage(p.id); objects.remountAll(); } });
  }

  const insertCtx = () => ({
    doc, view, selection,
    afterPages: (at) => { view.setPages(doc.list); renderIndicator(); view.scrollToPage(at); renderBars(); },
  });

  function insertMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const run = (fn) => async () => { objects.endEdit(); await fn(insertCtx()); };
    openMenu(r.left, r.bottom + 4, [
      { label: t('insert.image'), icon: 'image', action: run(async (c) => {
        const list = await inserts.pickFiles({ accept: 'image/*', multiple: true });
        if (list.length) await inserts.insertImages(c, list);
      }) },
      { label: t('insert.camera'), icon: 'camera', action: run(async (c) => {
        const list = await inserts.pickFiles({ accept: 'image/*', capture: 'environment' });
        if (list.length) await inserts.insertImages(c, list);
      }) },
      { label: t('insert.paste'), icon: 'paste', action: run((c) => inserts.pasteImages(c)) },
      { label: t('insert.pdf'), icon: 'pdf', action: run(async (c) => {
        const [f] = await inserts.pickFiles({ accept: 'application/pdf,.pdf' });
        if (f) await inserts.insertPdf(c, f);
      }) },
      { label: t('insert.slides'), icon: 'slides', action: run(async (c) => {
        const [f] = await inserts.pickFiles({ accept: '.pptx,.ppt,.odp,application/vnd.openxmlformats-officedocument.presentationml.presentation' });
        if (f) await inserts.insertSlides(c, f);
      }) },
      'sep',
      { label: t('pages.insertBefore'), icon: 'plus', action: () => { pageActions.insertPage(view.current); view.scrollToPage(view.current); } },
      { label: t('pages.insertAfter'), icon: 'plus', action: () => { const i = view.current + 1; pageActions.insertPage(i); view.scrollToPage(i); } },
    ], { title: t('editor.insert') });
  }

  // Images: crop and "use as cover" (from the image bar).
  async function onImageAction(kind, obj) {
    if (kind === 'crop') {
      const res = await openCropPanel(obj, doc.id);
      if (res && selection?.image?.id === obj.id) selection.replaceObject(res);
    } else if (kind === 'cover') {
      doc.setMeta({ cover: { mode: 'image', color: null, icon: null, image: obj.view || obj.file } });
      queueCover();
      toast(t('image.coverSet'), { duration: 2000 });
    }
  }

  /** Esporta PDF of the open note. */
  async function exportCurrent() {
    if (!doc) return;
    objects?.endEdit();
    const d = doc;
    const dismiss = toast(t('export.working'), { duration: 0 });
    try {
      const bytes = await exportNotePdf({
        title: d.meta.title, pages: d.list, strokes: (pid) => d.strokes(pid), file: (name) => files.getFile(d.id, name),
      });
      saveFile(bytes, pdfName(d.meta.title));
      toast(t('export.done'), { duration: 2500 });
    } catch (e) {
      toastError(e.status !== undefined ? e : new Error(t('export.failed')));
    } finally { dismiss(); }
  }

  function zoomItems() {
    return [
      { label: t('editor.fitWidth'), icon: 'fitWidth', action: () => view.fit('width') },
      { label: t('editor.fitPage'), icon: 'fitPage', action: () => view.fit('page') },
      { label: '100%', icon: 'zoom', action: () => view.fit('100') },
    ];
  }

  function zoomMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, zoomItems(), { title: t('editor.zoom') + ' · ' + view.percent + '%' });
  }

  function current() {
    return { ...store.notes.get(doc.id), ...doc.meta, folderId: doc.folderId };
  }

  function moreMenu(anchor) {
    if (!doc) return;
    const r = anchor.getBoundingClientRect();
    const n = current();
    const phone = mqPhone.matches;
    openMenu(r.right - 240, r.bottom + 4, [
      phone && { label: t('editor.rename'), icon: 'edit', action: async () => { const v = await renameDialog(); if (v) { title.value = v; doc.setMeta({ title: v }); } } },
      phone && { label: t('tools.shape'), icon: 'shapes', action: () => { if (tools.active === 'shape') openToolOptions('shape', anchor, toolCtx); else setTool('shape'); } },
      phone && { label: t('editor.insert'), icon: 'insert', action: () => insertMenu(anchor) },
      phone && { label: ruler?.visible ? t('tools.rulerHide') : t('tools.ruler'), icon: 'ruler', action: () => toggleRuler() },
      phone && { label: t('tools.color'), icon: 'palette', action: () => openColorPanel(anchor, { applyColor, eyedrop }) },
      phone && { label: `${t('tools.finger')}: ${t(tools.s.fingerMode === 'both' ? 'tools.fingerBoth' : 'tools.fingerPen')}`, icon: tools.s.fingerMode === 'both' ? 'hand' : 'penOnly', action: () => toggleFinger() },
      phone && { label: t('editor.pages'), icon: 'pages', action: () => showPages() },
      phone && { label: t('editor.format2'), icon: 'format', action: () => showFormat() },
      phone && { label: t('editor.zoom') + ' · ' + view.percent + '%', icon: 'zoom', action: () => zoomMenu(anchor) },
      phone && 'sep',
      { label: t('library.cover'), icon: 'cover', action: () => openCoverPanel(n, { apply: (cover) => { doc.setMeta({ cover }); queueCover(); } }) },
      { label: t('library.move'), icon: 'folderMove', action: async () => {
        const target = await act.pickFolder({ currentId: n.folderId });
        if (target !== undefined) { await doc.save(); await act.moveNotes([n], target); doc.folderId = target; }
      } },
      { label: t('export.pdf'), icon: 'exportPdf', action: () => exportCurrent() },
      { label: n.favorite ? t('library.unfavorite') : t('library.favorite'), icon: 'star', action: () => doc.setMeta({ favorite: !n.favorite }) },
      { label: t('editor.info'), icon: 'info', action: () => showInfo() },
      'sep',
      { label: t('common.delete'), icon: 'trash', danger: true, action: async () => {
        await doc.save();
        if (await act.trashNotes([n])) { listeners?.abort(); store.openNoteId = null; db.unpin(doc.id); doc.dispose(); teardown(); goBack(); }
      } },
    ].filter(Boolean));
  }

  function renameDialog() {
    return promptDialog({ title: t('common.rename'), label: t('library.noteTitle'), value: doc.meta.title });
  }

  function showInfo() {
    const m = doc.meta;
    const rowEl = (k, v) => h('div.info-row', {}, h('span.info-k', {}, k), h('span.info-v', {}, v));
    openPanel({
      title: t('info.title'),
      body: h('div.info', {},
        rowEl(t('info.created'), formatFull(m.created)),
        rowEl(t('info.modified'), formatFull(m.modified)),
        rowEl(t('info.lastDevice'), m.lastDevice || '—'),
        rowEl(t('info.pages'), String(doc.list.length)),
        rowEl(t('info.size'), formatBytes(doc.sizeBytes || 0)),
        rowEl(t('info.revision'), String(m.revision)),
        rowEl(t('info.sync'), t('editor.state.' + doc.state)),
        rowEl(t('info.path'), doc.path ? 'Quadernone/' + doc.path : '—')),
    });
  }

  // ------------------------------------------------------------------ after saving
  function onSaved(res) {
    if (res.note) {
      store.notes.set(res.note.id, res.note);
      store.dispatchEvent(new Event('change'));
    }
    if (res.note?.title && document.activeElement !== title) title.value = res.note.title;
    // Previews and cover are rebuilt from the whole page: not after every save (that runs
    // between strokes and slowed writing down) but after a pause in the work (5 s), at most
    // every 30 s, and when the note closes.
    clearTimeout(derivedTimer);
    const wait = Math.max(DERIVED_IDLE_MS, lastDerived + DERIVED_EVERY_MS - Date.now());
    derivedTimer = setTimeout(() => { derivedTimer = 0; lastDerived = Date.now(); queueDerived(doc, pdf); }, wait);
  }

  /** Uploads previews of changed pages and, if the first page changed, the cover. */
  function queueDerived(d, painter) {
    if (!d) return uploading;
    const changed = d.takeChangedPages();
    if (!changed.length) return;
    const firstChanged = changed.some((p) => p.id === d.list[0]?.id);
    uploading = uploading.then(async () => {
      for (const p of changed) {
        const index = d.list.indexOf(p);
        if (index === -1) continue;
        const svg = pageToSvg(p, { title: d.meta.title, pageNumber: index + 1, strokes: d.strokes(p.id) });
        try {
          await rawPut(`/notes/${d.id}/previews/${p.id}`, svg, 'image/svg+xml');
        } catch { d.invalidatePreview(p.id); }
      }
      if (firstChanged) await uploadCover(d, painter);
    });
    return uploading;
  }

  function queueCover() {
    const d = doc, painter = pdf;
    uploading = uploading.then(() => uploadCover(d, painter));
  }

  async function uploadCover(d, painter) {
    if (!d.list[0]) return;
    const mode = d.meta.cover?.mode || 'auto';
    if (mode === 'preset') return;
    try {
      let png;
      if (mode === 'image' && d.meta.cover.image) {
        png = await renderImageCover(await files.imageBitmap(d.id, d.meta.cover.image));
      } else {
        const first = d.list[0];
        png = await renderCoverPng(first, d.strokes(first.id), await pageExtras(d, first, painter));
      }
      const res = await rawPut(`/notes/${d.id}/cover`, png, 'image/png');
      if (res?.note) { store.notes.set(res.note.id, res.note); store.dispatchEvent(new Event('change')); }
    } catch { /* derived file: the next save retries */ }
  }

  /** Decoded images and the PDF render a page needs for a thumbnail or the cover. */
  async function pageExtras(d, page, painter) {
    const images = new Map();
    for (const o of page.objects || []) {
      if (o.type !== 'image') continue;
      try { images.set(o.id, await files.imageBitmap(d.id, o.view || o.file)); } catch { /* missing */ }
    }
    let pdfCanvas = null;
    if (page.pdf && painter && !painter.disposed) { try { pdfCanvas = await painter.low(page); } catch { /* missing */ } }
    return { images, pdf: pdfCanvas };
  }

  async function rawPut(path, body, type) {
    const res = await fetch(prefs.serverBase() + '/api' + path, {
      method: 'PUT', body,
      headers: { 'Content-Type': type, 'X-Quadernone-Token': prefs.get('token'), 'X-Quadernone-Device': prefs.get('deviceName') },
    });
    if (!res.ok) throw new Error('upload ' + res.status);
    return res.json();
  }

  function onConflict(info) {
    toast(t('errors.conflict'), { kind: 'warn', duration: 9000 });
    store.load().catch(() => {});
    if (info?.copyId) openNote(info.copyId, { replace: true });
  }

  // ------------------------------------------------------------------ keyboard
  const KEY_TOOLS = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', t: 'text' };
  document.addEventListener('keydown', (e) => {
    if (!doc || !root.isConnected || root.hidden || panelOpen()) return;
    const inText = e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mod && !inText && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && !inText && k === 'y') { e.preventDefault(); redo(); }
    else if (mod && !inText && k === 'c' && selection?.active) { e.preventDefault(); selection.copy(); }
    else if (mod && !inText && k === 'x' && selection?.active) { e.preventDefault(); selection.cut(); }
    else if (mod && !inText && k === 'v' && hasClipboard()) { e.preventDefault(); const p = doc.list[view.current]; if (p) selection.paste(p.id, 6); }
    else if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); view.setScale(view.s * 1.2); }
    else if (mod && e.key === '-') { e.preventDefault(); view.setScale(view.s / 1.2); }
    else if (mod && e.key === '0') { e.preventDefault(); view.fit('width'); }
    else if (!mod && !inText && !e.altKey && KEY_TOOLS[k]) { e.preventDefault(); setTool(KEY_TOOLS[k]); }
    else if (!inText && (e.key === 'Delete' || e.key === 'Backspace') && selection?.active) { e.preventDefault(); selection.remove(); }
    else if (e.key === 'Escape') {
      if (objects?.editing) { e.preventDefault(); objects.endEdit(); }
      else if (selection?.active) { e.preventDefault(); selection.clear(); }
      else if (input?.pickColor) { input.pickColor = null; }
    }
  });
  // Images and files from the system clipboard (Ctrl+V, or "Incolla" in the system menu).
  document.addEventListener('paste', (e) => {
    if (!doc || !root.isConnected || root.hidden || panelOpen()) return;
    if (e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const list = [...(e.clipboardData?.files || [])];
    if (!list.length) return;
    e.preventDefault();
    inserts.insertFiles(insertCtx(), list);
  });
  // Files dropped on the pages (Lenovo/PC): images where dropped, PDF and slides as pages.
  stage.addEventListener('dragover', (e) => { if (doc && [...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  stage.addEventListener('drop', async (e) => {
    if (!doc || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    const list = [...e.dataTransfer.files];
    const hit = view.pageAt(e.clientX, e.clientY);
    const images = list.filter(inserts.isImage);
    const c = insertCtx();
    if (images.length) await inserts.insertImages(c, images, hit ? { page: hit.page, at: [hit.xMm, hit.yMm] } : {});
    const others = list.filter((f) => !inserts.isImage(f));
    if (others.length) await inserts.insertFiles(c, others);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && doc) { objects?.editing && objects.endEdit(); doc.save(); }
  });

  return { el: root, open, close };
}
