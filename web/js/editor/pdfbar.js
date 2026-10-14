// Contextual bar for PDF pages: search in the PDF, go to page N, a blank page after this
// one, export the annotated PDF. Shown while the current page is a PDF page and nothing
// else (text, selection) needs the bar slot.
import { h, iconButton } from '../dom.js';
import { t } from '../i18n.js';
import { openMenu } from '../ui/menu.js';
import { promptDialog } from '../ui/panel.js';
import { toast } from '../ui/toast.js';
import { pageText } from '../page/pdf.js';

const fold = (s) => s.normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase();

/** ctx: { doc, view, pdf (PdfPainter), insertBlankAfter(index), exportPdf() } */
export function createPdfBar(ctx) {
  const label = h('span.pdfbar-label');
  const bar = h('div.textbar.pdfbar', { role: 'toolbar', 'aria-label': t('pdfbar.bar'), hidden: true },
    h('div.tb-group', {}, label),
    h('div.tb-group', {},
      iconButton('search', t('pdfbar.search'), (e) => search(e.currentTarget)),
      iconButton('goto', t('pdfbar.goto'), () => goTo())),
    h('div.tb-group', {},
      iconButton('plus', t('pdfbar.blankAfter'), () => ctx.insertBlankAfter(ctx.view.current)),
      iconButton('exportPdf', t('pdfbar.export'), () => ctx.exportPdf())));
  const texts = new Map();   // "file#index" -> text

  function update(show) {
    const page = ctx.doc.list[ctx.view.current];
    bar.hidden = !show || !page?.pdf;
    if (bar.hidden) return;
    const pdfPages = ctx.doc.list.filter((p) => p.pdf);
    label.textContent = t('pdfbar.label', { n: page.pdf.pageIndex + 1, file: page.pdf.file.replace(/\.pdf$/i, '') , total: pdfPages.length });
  }

  async function textOf(p) {
    const key = `${p.pdf.file}#${p.pdf.pageIndex}`;
    if (!texts.has(key)) {
      const d = await ctx.pdf.doc(p.pdf.file);
      texts.set(key, await pageText(d, p.pdf.pageIndex));
    }
    return texts.get(key);
  }

  async function search(anchor) {
    const q = (await promptDialog({ title: t('pdfbar.search'), label: t('pdfbar.searchLabel'), value: '' }))?.trim();
    if (!q) return;
    const want = fold(q);
    const hits = [];
    const dismiss = toast(t('pdfbar.searching'), { duration: 0 });
    try {
      for (const [i, p] of ctx.doc.list.entries()) {
        if (!p.pdf) continue;
        const text = await textOf(p).catch(() => '');
        const at = fold(text).indexOf(want);
        if (at === -1) continue;
        const snip = text.slice(Math.max(0, at - 30), at + want.length + 40).replace(/\s+/g, ' ');
        hits.push({ i, snip });
        if (hits.length >= 30) break;
      }
    } finally { dismiss(); }
    if (!hits.length) { toast(t('pdfbar.notFound', { q })); return; }
    const r = anchor.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, hits.map((x) => ({
      label: `${t('pages.page', { n: x.i + 1 })} · …${x.snip}…`, icon: 'goto', action: () => ctx.view.scrollToPage(x.i, { smooth: true }),
    })), { title: t('pdfbar.results', { n: hits.length, q }) });
  }

  async function goTo() {
    const n = ctx.doc.list.length;
    const v = await promptDialog({ title: t('pdfbar.goto'), label: t('sel.pageNumber', { n }), value: String(ctx.view.current + 1) });
    const i = Number(v) - 1;
    if (Number.isInteger(i) && i >= 0 && i < n) ctx.view.scrollToPage(i);
  }

  return { el: bar, update };
}
