// Formato e sfondo: size, orientation, background, spacing, line colour, paper colour,
// for this page or the whole note. Content is never touched: objects keep their mm positions.
import { h } from '../dom.js';
import { t } from '../i18n.js';
import { openPanel } from '../ui/panel.js';
import { formatEditor, resolveSize } from '../panels/format.js';
import { INFINITE_MARGIN_MM } from './objects.js';

export function openFormatPanel({ doc, view, onApplied }) {
  const page = doc.list[view.current] || doc.list[0];
  let settings = { size: { ...page.size }, orientation: page.orientation, background: { ...page.background } };
  if (settings.size.preset === 'pdf') settings.size = { ...doc.pages.defaults.size };
  let scope = 'page';

  const scopeEl = h('div.segmented', { role: 'radiogroup' });
  const paintScope = () => scopeEl.replaceChildren(...[['page', t('format.thisPage')], ['all', t('format.allPages')]].map(([v, label]) =>
    h(`button.seg${scope === v ? '.active' : ''}`, { type: 'button', onclick: () => { scope = v; paintScope(); } }, label)));
  paintScope();

  const apply = () => {
    doc.change(() => {
      const targets = scope === 'all' ? doc.list : [page];
      for (const pg of targets) applyTo(pg, settings);
      if (scope === 'all') doc.pages.defaults = structuredClone({ size: resolveSize(settings.size, settings.orientation), orientation: settings.orientation, background: settings.background });
    });
    onApplied();
    p.close();
  };

  const p = openPanel({
    title: t('format.title'),
    body: [
      h('div.field', {}, h('span.field-label', {}, t('format.applyTo')), scopeEl),
      formatEditor(settings, (d) => { settings = d; }),
    ],
    footer: [
      h('button.btn', { type: 'button', onclick: () => p.close() }, t('common.cancel')),
      h('button.btn.primary', { type: 'button', onclick: apply }, t('format.apply')),
    ],
  });
}

/** Applies size/orientation/background to one page. PDF pages keep their own size. */
export function applyTo(pg, settings) {
  pg.background = structuredClone(settings.background);
  if (pg.size.preset === 'pdf') return;
  pg.orientation = settings.orientation;
  if (settings.size.preset === 'infinite') {
    const bottom = Math.max(0, ...(pg.objects || []).map((o) => o.y + (o.h || 0)));
    const keep = pg.size.preset === 'infinite' ? pg.size.heightMm : 297;
    pg.size = { preset: 'infinite', widthMm: settings.size.widthMm || 210, heightMm: Math.max(keep, Math.ceil((bottom + INFINITE_MARGIN_MM) / 10) * 10) };
  } else {
    pg.size = resolveSize(settings.size, settings.orientation);
  }
}
