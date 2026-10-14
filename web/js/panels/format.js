// Page format + background editor, used by "Nuova nota" and Impostazioni > Nuove note.
// Works on a pageDefaults object { size, orientation, background } (see pages.json).
import { h, fill } from '../dom.js';
import { t } from '../i18n.js';
import { PAPER } from '../page/paper.js';

const PRESETS = { A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4] };
const LINE_COLORS = ['#A9BCD6', '#C9C9C9', '#E2B7B7', '#B9D3B0', '#6F7782'];

/** Resolves widthMm/heightMm for the orientation, as the server stores them. */
export function resolveSize(size, orientation) {
  if (PRESETS[size.preset]) {
    let [w, hgt] = PRESETS[size.preset];
    if (orientation === 'landscape') [w, hgt] = [hgt, w];
    return { preset: size.preset, widthMm: w, heightMm: hgt };
  }
  return { ...size };
}

export function describeFormat(d) {
  const size = d.size.preset === 'custom' ? `${d.size.widthMm}×${d.size.heightMm} mm` : t('format.' + d.size.preset);
  return `${size}, ${t('format.' + d.orientation).toLowerCase()}, ${t('format.' + d.background.type).toLowerCase()}`;
}

/** Small swatch that previews a background. */
export function backgroundSwatch(bg, paperColor = 'white') {
  const paper = PAPER[paperColor];
  const line = paperColor === 'dark' ? '#5B6270' : bg.lineColor;
  const s = 8; // preview spacing in px
  const style = { background: paper };
  if (bg.type === 'lined') style.backgroundImage = `repeating-linear-gradient(to bottom, transparent 0 ${s - 1}px, ${line} ${s - 1}px ${s}px)`;
  if (bg.type === 'grid') style.backgroundImage = `repeating-linear-gradient(to bottom, transparent 0 ${s - 1}px, ${line} ${s - 1}px ${s}px), repeating-linear-gradient(to right, transparent 0 ${s - 1}px, ${line} ${s - 1}px ${s}px)`;
  if (bg.type === 'dotted') { style.backgroundImage = `radial-gradient(circle, ${line} 1px, transparent 1.3px)`; style.backgroundSize = `${s}px ${s}px`; }
  return h('span.bg-swatch', { style });
}

export function formatEditor(initial, onChange) {
  const d = structuredClone(initial);
  const root = h('div.format-editor');
  const emit = () => { d.size = resolveSize(d.size, d.orientation); onChange(structuredClone(d)); render(); };

  const seg = (label, options, current, pick) => h('div.field', {},
    h('span.field-label', {}, label),
    h('div.segmented', { role: 'radiogroup', 'aria-label': label }, options.map(([value, text, extra]) =>
      h(`button.seg${value === current ? '.active' : ''}`, { type: 'button', role: 'radio', 'aria-checked': String(value === current), onclick: () => pick(value) }, extra || null, h('span', {}, text)))));

  function render() {
    fill(root, 
      seg(t('format.size'), ['A4', 'A5', 'Letter', 'custom', 'infinite'].map((p) => [p, t('format.' + p)]), d.size.preset, (p) => {
        d.size = p === 'custom' ? { preset: 'custom', widthMm: d.size.widthMm || 210, heightMm: d.size.heightMm || 297 }
          : p === 'infinite' ? { preset: 'infinite', widthMm: 210, heightMm: 297 } : { preset: p };
        emit();
      }),
      d.size.preset === 'custom' ? h('div.field-row', {},
        numField(t('format.widthMm'), d.size.widthMm, 20, 2000, (v) => { d.size.widthMm = v; emit(); }),
        numField(t('format.heightMm'), d.size.heightMm, 20, 2000, (v) => { d.size.heightMm = v; emit(); })) : null,
      d.size.preset === 'infinite' || d.size.preset === 'custom' ? null
        : seg(t('format.orientation'), [['portrait', t('format.portrait')], ['landscape', t('format.landscape')]], d.orientation, (o) => { d.orientation = o; emit(); }),
      seg(t('format.background'), ['blank', 'lined', 'grid', 'dotted'].map((b) => [b, t('format.' + b), backgroundSwatch({ ...d.background, type: b }, d.background.paperColor)]),
        d.background.type, (b) => { d.background.type = b; emit(); }),
      d.background.type === 'blank' ? null : h('div.field', {},
        h('span.field-label', {}, t('format.spacing') + ' — ' + t('format.mm', { n: d.background.spacingMm })),
        h('input.range', { type: 'range', min: 4, max: 15, step: 0.5, value: String(d.background.spacingMm),
          oninput: (e) => { d.background.spacingMm = Number(e.target.value); e.target.previousSibling.textContent = t('format.spacing') + ' — ' + t('format.mm', { n: d.background.spacingMm }); },
          onchange: () => emit() })),
      d.background.type === 'blank' ? null : h('div.field', {},
        h('span.field-label', {}, t('format.lineColor')),
        h('div.swatches', {}, LINE_COLORS.map((c) => h(`button.swatch.sm${d.background.lineColor === c ? '.active' : ''}`, {
          type: 'button', style: { background: c }, 'aria-label': c, onclick: () => { d.background.lineColor = c; emit(); },
        })))),
      seg(t('format.paper'), Object.keys(PAPER).map((p) => [p, t('format.' + p), h('span.paper-dot', { style: { background: PAPER[p] } })]),
        d.background.paperColor, (p) => { d.background.paperColor = p; emit(); }),
    );
  }
  render();
  return root;
}

function numField(label, value, min, max, onSet) {
  return h('label.field', {}, h('span.field-label', {}, label),
    h('input.field-input', { type: 'number', inputMode: 'decimal', min, max, step: 1, value: String(value),
      onchange: (e) => { const v = Math.min(max, Math.max(min, Number(e.target.value) || min)); onSet(v); } }));
}
