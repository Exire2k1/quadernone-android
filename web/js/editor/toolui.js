// Tool options (opened by a second tap on the active tool) and the Colore panel.
// Every control writes straight into `tools` (remembered per device).
import { h, fill } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { toast } from '../ui/toast.js';
import { openPopover, closePopover } from '../ui/popover.js';
import { drawLive, PEN_TYPES } from '../page/ink.js';
import { tools, HIGHLIGHTER_COLORS } from './tools.js';

const SHAPE_MODES = [['auto', 'magic'], ['line', 'line'], ['arrow', 'arrow'], ['rect', 'rect'], ['ellipse', 'ellipse'], ['triangle', 'triangle']];
const HEX_RE = /^#[0-9a-f]{6}$/i;

// ------------------------------------------------------------------ small controls

function segRow(options, value, onPick) {
  return h('div.seg-row', {}, options.map(([v, label, ic]) => h('button.seg' + (v === value ? '.active' : ''), {
    type: 'button', 'aria-pressed': String(v === value), onclick: () => onPick(v),
  }, ic ? icon(ic) : null, label ? h('span', {}, label) : null)));
}

function section(label, ...children) {
  return h('div.opt-section', {}, label ? h('div.opt-label', {}, label) : null, ...children);
}

/** Width slider on a logarithmic scale (fine control at small widths). */
function widthSlider(min, max, value, onInput) {
  const toPos = (v) => Math.round((Math.log(v / min) / Math.log(max / min)) * 1000);
  const fromPos = (p) => Math.round(min * Math.pow(max / min, p / 1000) * 10) / 10;
  const out = h('span.opt-value', {}, fmtPt(value));
  const input = h('input.range', { type: 'range', min: 0, max: 1000, step: 1, value: toPos(value), 'aria-label': t('tools.width') });
  input.addEventListener('input', () => { const v = fromPos(Number(input.value)); out.textContent = fmtPt(v); onInput(v); });
  return { el: h('div.opt-slider', {}, input, out), set(v) { input.value = toPos(v); out.textContent = fmtPt(v); } };
}

const fmtPt = (v) => `${String(Math.round(v * 10) / 10).replace('.', ',')} pt`;

function switchRow(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked, onchange: () => onChange(input.checked) });
  return h('label.switch-row.opt-switch', {}, input, h('span', {}, label));
}

/** Calls onLong after a long press, onTap otherwise. */
function pressable(el, onTap, onLong, ms = 550) {
  let timer = 0, long = false;
  el.addEventListener('pointerdown', () => { long = false; timer = setTimeout(() => { long = true; navigator.vibrate?.(10); onLong(); }, ms); });
  const stop = () => clearTimeout(timer);
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointerleave', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('click', () => { if (!long) onTap(); });
  return el;
}

function swatches(colors, current, onPick, { onLong = null, none = false } = {}) {
  const items = colors.map((c, i) => {
    const b = h('button.swatch.sm' + (c && current && c.toLowerCase() === current.toLowerCase() ? '.active' : ''), {
      type: 'button', style: { background: c }, 'aria-label': c, title: c,
    });
    return onLong ? pressable(b, () => onPick(c), () => onLong(i)) : (b.addEventListener('click', () => onPick(c)), b);
  });
  if (none) items.unshift(h('button.swatch.sm.swatch-none' + (!current ? '.active' : ''), { type: 'button', 'aria-label': t('tools.noFill'), title: t('tools.noFill'), onclick: () => onPick(null) }, icon('close')));
  return h('div.swatches.opt-swatches', {}, items);
}

/** Sample stroke drawn with the current settings of a tool. */
function strokePreview(tool) {
  const W = 232, H = 56;
  const c = h('canvas.opt-preview', { width: W * 2, height: H * 2, style: { width: W + 'px', height: H + 'px' } });
  const draw = () => {
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const k = 2 * 3.78;    // 1 unit = 1 mm at 100 %
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const wMm = W / 3.78, hMm = H / 3.78;
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const u = i / 40;
      pts.push([6 + u * (wMm - 12), hMm / 2 + Math.sin(u * Math.PI * 2) * hMm * 0.22, 0.25 + 0.6 * Math.sin(u * Math.PI), i * 12]);
    }
    const style = tools.strokeStyle(tool);
    const straight = tool === 'highlighter' && tools.s.highlighter.straight;
    drawLive(ctx, { id: 'st-preview0', ...style, points: straight ? [pts[0], [pts.at(-1)[0], pts[0][1], 0.5, 0]] : pts });
  };
  draw();
  return { el: h('div.opt-preview-wrap', {}, c), draw };
}

// ------------------------------------------------------------------ options per tool

function penOptions(rerender, ctx) {
  const p = tools.s.pen;
  const preview = strokePreview('pen');
  const slider = widthSlider(0.5, 20, p.widthPt, (v) => { tools.update('pen', { widthPt: v }); preview.draw(); favRow.querySelectorAll('.fav').forEach((b, i) => b.classList.toggle('active', tools.s.pen.favorites[i] === v)); });
  const favRow = h('div.fav-row', {}, p.favorites.map((w, i) => pressable(
    h('button.fav' + (w === p.widthPt ? '.active' : ''), { type: 'button', title: fmtPt(w) },
      h('span.fav-dot', { style: { width: Math.max(3, Math.min(22, w * 1.6)) + 'px', height: Math.max(3, Math.min(22, w * 1.6)) + 'px', background: p.color } }),
      h('span', {}, fmtPt(w))),
    () => { tools.update('pen', { widthPt: w }); rerender(); },
    () => {
      const favorites = [...tools.s.pen.favorites];
      favorites[i] = tools.s.pen.widthPt;
      tools.update('pen', { favorites });
      toast(t('tools.favSaved'), { duration: 1500 });
      rerender();
    })));
  return [
    preview.el,
    section(null, segRow(PEN_TYPES.map((k) => [k, t('tools.types.' + k)]), p.type, (v) => { tools.update('pen', { type: v }); rerender(); })),
    section(t('tools.width'), slider.el),
    section(t('tools.favorites'), favRow, h('p.hint', {}, t('tools.favHint'))),
    section(t('tools.color'), swatches(tools.s.quickColors, p.color, (c) => { ctx.applyColor(c); rerender(); }),
      h('button.btn.opt-more', { type: 'button', onclick: () => ctx.openColor() }, icon('palette'), h('span', {}, t('tools.moreColors')))),
    switchRow(t('tools.pressure'), p.pressure, (v) => { tools.update('pen', { pressure: v }); preview.draw(); }),
    switchRow(t('settings.penShapes'), tools.s.penShapes, (v) => tools.set('penShapes', v)),
  ];
}

function highlighterOptions(rerender, ctx) {
  const s = tools.s.highlighter;
  const preview = strokePreview('highlighter');
  const slider = widthSlider(4, 40, s.widthPt, (v) => { tools.update('highlighter', { widthPt: v }); preview.draw(); });
  return [
    preview.el,
    section(t('tools.width'), slider.el),
    section(t('tools.color'), swatches(HIGHLIGHTER_COLORS, s.color, (c) => { ctx.applyColor(c); rerender(); })),
    section(t('tools.tip'), segRow([['round', t('tools.round')], ['chisel', t('tools.chisel')]], s.tip, (v) => { tools.update('highlighter', { tip: v }); rerender(); })),
    switchRow(t('tools.straight'), s.straight, (v) => { tools.update('highlighter', { straight: v }); preview.draw(); }),
    h('p.hint', {}, t('tools.underHint')),
  ];
}

function eraserOptions(rerender, ctx) {
  const s = tools.s.eraser;
  const out = h('span.opt-value', {}, `${s.sizeMm} mm`);
  const size = h('input.range', { type: 'range', min: 1, max: 30, step: 1, value: s.sizeMm, 'aria-label': t('tools.size') });
  size.addEventListener('input', () => { tools.update('eraser', { sizeMm: Number(size.value) }); out.textContent = `${size.value} mm`; });
  return [
    section(t('tools.eraserMode'), segRow([['area', t('tools.eraseArea')], ['stroke', t('tools.eraseStroke')]], s.mode, (v) => { tools.update('eraser', { mode: v }); rerender(); })),
    section(t('tools.size'), h('div.opt-slider', {}, size, out)),
    h('p.hint', {}, t('tools.eraserHint')),
    h('button.btn.danger-text.opt-wide', { type: 'button', onclick: () => { closePopover(); ctx.clearPage(); } }, icon('trash'), h('span', {}, t('tools.clearPage'))),
  ];
}

function lassoOptions(rerender) {
  const s = tools.s.lasso;
  return [
    section(t('tools.lassoMode'), segRow([['free', t('tools.free'), 'lasso'], ['rect', t('tools.rectSel'), 'rect']], s.mode, (v) => { tools.update('lasso', { mode: v }); rerender(); })),
    section(t('tools.filter'), segRow([['all', t('tools.all')], ['ink', t('tools.inkOnly')], ['images', t('tools.images')], ['text', t('tools.textOnly')]], s.filter, (v) => { tools.update('lasso', { filter: v }); rerender(); })),
  ];
}

function shapeOptions(rerender, ctx) {
  const s = tools.s.shape;
  const slider = widthSlider(0.5, 20, s.widthPt, (v) => tools.update('shape', { widthPt: v }));
  return [
    section(t('tools.shapeMode'), h('div.shape-grid', {}, SHAPE_MODES.map(([k, ic]) => h('button.icon-pick' + (s.mode === k ? '.active' : ''), {
      type: 'button', title: t('tools.shapes.' + k), 'aria-label': t('tools.shapes.' + k), onclick: () => { tools.update('shape', { mode: k }); rerender(); },
    }, icon(ic)))), h('p.hint', {}, s.mode === 'auto' ? t('tools.autoHint') : t('tools.dragHint'))),
    section(t('tools.width'), slider.el),
    section(t('tools.color'), swatches(tools.s.quickColors, s.color, (c) => { ctx.applyColor(c); rerender(); })),
    section(t('tools.fill'), swatches(tools.s.quickColors, s.fill, (c) => { tools.update('shape', { fill: c }); rerender(); }, { none: true })),
  ];
}

const BUILDERS = { pen: penOptions, highlighter: highlighterOptions, eraser: eraserOptions, lasso: lassoOptions, shape: shapeOptions };

/**
 * Opens the options of a tool under its button.
 * ctx: { applyColor(c), openColor(), clearPage() }
 */
export function openToolOptions(tool, anchor, ctx) {
  const build = BUILDERS[tool];
  if (!build) return;
  const body = h('div.opt-body');
  const rerender = () => fill(body, build(rerender, ctx));
  rerender();
  openPopover(anchor, [h('div.opt-title', {}, t('tools.' + tool)), body], { className: 'tool-options' });
}

// ------------------------------------------------------------------ Colore

/**
 * Colour panel: 10 quick colours (long press = replace with the current colour), last 5
 * used, hex / system picker, eyedropper.
 * ctx: { applyColor(c), eyedrop() }
 */
export function openColorPanel(anchor, ctx) {
  const body = h('div.opt-body');
  const pick = (c) => { if (c) { ctx.applyColor(c); rerender(); } };
  const rerender = () => {
    const cur = tools.color;
    const hex = h('input.field-input.mono.hex-input', { type: 'text', value: cur.toUpperCase(), maxLength: 7, spellcheck: false, 'aria-label': t('tools.hex'), enterkeyhint: 'done' });
    const native = h('input.native-color', { type: 'color', value: cur.toLowerCase(), 'aria-label': t('tools.custom') });
    // Applied on 'change' only (Enter or leaving the field): re-rendering from a keydown
    // would remove the focused field and fire a second 'change' while it is removed.
    const applyHex = () => {
      let v = hex.value.trim();
      if (!v.startsWith('#')) v = '#' + v;
      if (!HEX_RE.test(v)) { hex.classList.add('invalid'); return; }
      if (v.toUpperCase() !== cur.toUpperCase()) queueMicrotask(() => pick(v.toUpperCase()));
    };
    hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); hex.blur(); } });
    hex.addEventListener('input', () => hex.classList.remove('invalid'));
    hex.addEventListener('change', applyHex);
    native.addEventListener('change', () => pick(native.value.toUpperCase()));
    fill(body,
      h('div.color-current', {}, h('span.color-big', { style: { background: cur } }), h('span.mono', {}, cur.toUpperCase())),
      section(t('tools.quickColors'), swatches(tools.s.quickColors, cur, pick, {
        onLong: (i) => {
          const q = [...tools.s.quickColors];
          q[i] = tools.color;
          tools.set('quickColors', q);
          toast(t('tools.replaced'), { duration: 1500 });
          rerender();
        },
      }), h('p.hint', {}, t('tools.quickHint'))),
      tools.s.recentColors.length ? section(t('tools.recent'), swatches(tools.s.recentColors, cur, pick)) : null,
      section(t('tools.custom'), h('div.color-custom', {}, native, hex,
        h('button.icon-btn', { type: 'button', title: t('tools.eyedropper'), 'aria-label': t('tools.eyedropper'), onclick: () => { closePopover(); ctx.eyedrop(); } }, icon('eyedropper')))),
    );
  };
  rerender();
  openPopover(anchor, [h('div.opt-title', {}, t('tools.color')), body], { className: 'tool-options color-panel' });
}

export { closePopover };
