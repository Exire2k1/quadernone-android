// Cerca: titles, text boxes and PDF text of all notes (GET /api/search). Results show
// snippets with the match highlighted; a snippet opens the note at its page.
import { h, fill } from '../dom.js';
import { t, formatFull } from '../i18n.js';
import { request } from '../api.js';
import { store } from '../store.js';
import { openPanel } from '../ui/panel.js';
import { icon } from '../icons.js';

const WHERE = { title: 'search.inTitle', text: 'search.inText', pdf: 'search.inPdf' };

/** folderId: the folder open in the Library (for "Solo questa cartella"), or null. */
export function openSearch({ folderId = null, openNote }) {
  const q = h('input.field-input', { type: 'search', placeholder: t('search.placeholder'), autofocus: true, enterkeyhint: 'search', 'aria-label': t('search.title') });
  const inFolder = h('input', { type: 'checkbox', checked: !!folderId });
  const onlyPdf = h('input', { type: 'checkbox' });
  const from = h('input', { type: 'date', 'aria-label': t('search.from') });
  const to = h('input', { type: 'date', 'aria-label': t('search.to') });
  const count = h('p.search-count');
  const results = h('ul.search-results');
  let seq = 0, timer = 0, target = null;

  const folderName = folderId ? store.folders.get(folderId)?.name : null;
  const filters = h('div.search-filters', {},
    folderId ? h('label', {}, inFolder, `${t('search.thisFolder')} (${folderName})`) : null,
    h('label', {}, onlyPdf, t('search.onlyPdf')),
    h('label', {}, t('search.from'), from),
    h('label', {}, t('search.to'), to));

  const go = (id, page) => { target = { id, page }; p.close(); };

  async function run() {
    const text = q.value.trim();
    const my = ++seq;
    if (!text) { fill(results); count.textContent = ''; return; }
    const params = new URLSearchParams({ q: text });
    if (folderId && inFolder.checked) params.set('folder', folderId);
    if (onlyPdf.checked) params.set('type', 'pdf');
    if (from.value) params.set('from', from.value);
    if (to.value) params.set('to', to.value);
    let data;
    try { data = await request('GET', '/search?' + params); } catch (e) {
      if (my === seq) { fill(results); count.textContent = e.status === 0 ? t('search.offline') : e.message; }
      return;
    }
    if (my !== seq) return;
    count.textContent = data.total ? t('search.results', { n: data.total }) : t('search.none');
    fill(results, data.results.map((r) => {
      const folder = r.folderId ? store.folders.get(r.folderId)?.name : t('views.root');
      const firstPage = r.snippets.find((s) => s.pageIndex != null)?.pageIndex ?? null;
      return h('li.search-hit', {},
        h('button.search-hit-title', { type: 'button', onclick: () => go(r.id, firstPage) },
          icon(r.hasPdf ? 'pdf' : 'notes'), h('span', {}, r.title), h('span.when', {}, `${folder ?? ''} · ${formatFull(r.modified)}`)),
        r.snippets.filter((s) => s.where !== 'title').map((s) => h('button.search-snip', { type: 'button', onclick: () => go(r.id, s.pageIndex) },
          h('span.where', {}, t(WHERE[s.where]) + (s.pageIndex != null ? ' · ' + t('search.page', { n: s.pageIndex + 1 }) : '')),
          s.before, h('mark', {}, s.match), s.after)));
    }));
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(run, 280); };
  q.addEventListener('input', later);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); } });
  for (const el of [inFolder, onlyPdf, from, to]) el.addEventListener('change', run);

  const p = openPanel({
    title: t('search.title'),
    body: [h('div.search-form', {}, q, filters), count, results],
    // Open the note only once the panel is gone (it closes through the history).
    onClose: () => { if (target) openNote(target.id, { page: target.page }); },
  });
}
