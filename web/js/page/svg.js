// pages -> standalone SVG previews (previews/<pageId>.svg), viewable without the app.
// Units are millimetres. Text uses plain <text> elements so any viewer can show it.
import { backgroundSvg, defaultInk } from './paper.js';
import { layoutText, segWidth, FONT_STACK } from './textmodel.js';
import { strokesSvg } from './ink.js';
import { shapeSvg } from './shapes.js';
import { imageSvg } from './images.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Math.round(v * 100) / 100;

function textObjectSvg(obj, fallbackColor) {
  const color = obj.style?.color || fallbackColor;
  const { lines } = layoutText(obj);
  const out = [];
  const rot = obj.rotation ? ` transform="rotate(${obj.rotation} ${n(obj.x + obj.w / 2)} ${n(obj.y + (obj.h || 0) / 2)})"` : '';
  out.push(`<g${rot}>`);
  for (const ln of lines) {
    const y = n(obj.y + ln.y);
    const m = ln.marker;
    if (m) {
      const x = obj.x + m.x, sz = m.sizeMm;
      if (m.kind === 'bullet') out.push(`<circle cx="${n(x + sz * 0.45)}" cy="${n(obj.y + ln.y - sz * 0.32)}" r="${n(sz * 0.13)}" fill="${color}"/>`);
      else if (m.kind === 'number') out.push(`<text x="${n(x)}" y="${y}" font-size="${n(sz)}" fill="${color}">${esc(m.text)}</text>`);
      else {
        const b = sz * 0.72, top = obj.y + ln.y - sz * 0.72;
        out.push(`<rect x="${n(x + sz * 0.05)}" y="${n(top)}" width="${n(b)}" height="${n(b)}" fill="none" stroke="${color}" stroke-width="${n(Math.max(0.15, sz * 0.07))}"/>`);
        if (m.done) out.push(`<path d="M${n(x + sz * 0.18)} ${n(top + b * 0.52)}L${n(x + sz * 0.36)} ${n(top + b * 0.78)}L${n(x + sz * 0.7)} ${n(top + b * 0.2)}" fill="none" stroke="${color}" stroke-width="${n(Math.max(0.15, sz * 0.07))}"/>`);
      }
    }
    for (const s of ln.segs) {
      if (!s.text.trim()) continue;
      const c = s.run.color || color;
      const attrs = [`x="${n(obj.x + s.x)}"`, `y="${y}"`, `font-size="${n(s.sizeMm)}"`, `fill="${c}"`];
      if (s.run.b || s.heading) attrs.push('font-weight="700"');
      if (s.run.i) attrs.push('font-style="italic"');
      const deco = [s.run.u && 'underline', s.run.s && 'line-through'].filter(Boolean).join(' ');
      if (deco) attrs.push(`text-decoration="${deco}"`);
      // textLength keeps the layout identical to the app even if the viewer's font differs.
      attrs.push(`textLength="${n(segWidth(s))}"`, 'lengthAdjust="spacingAndGlyphs"');
      out.push(`<text ${attrs.join(' ')} xml:space="preserve">${esc(s.text)}</text>`);
    }
  }
  out.push('</g>');
  return out.join('');
}

/** SVG for one page: background, highlighter, objects, handwriting. pageNumber: 1-based. */
export function pageToSvg(page, { title = '', pageNumber = 1, strokes = [] } = {}) {
  const w = page.size.widthMm, h = page.size.heightMm;
  const ink = defaultInk(page.background);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}" font-family='${FONT_STACK}'>`,
    `<title>${esc(title)} — pagina ${pageNumber}</title>`,
    backgroundSvg(page),
  ];
  if (page.pdf) {
    // The PDF page itself is not embedded (megabytes per save): name it instead.
    parts.push(`<text x="6" y="10" font-size="4" fill="#888">PDF: ${esc(page.pdf.file)}, pagina ${page.pdf.pageIndex + 1}</text>`);
  }
  parts.push(strokesSvg(strokes, 'under'));
  const objects = [...(page.objects || [])].sort((a, b) => (a.z || 0) - (b.z || 0));
  for (const o of objects) {
    if (o.type === 'text') parts.push(textObjectSvg(o, ink));
    else if (o.type === 'shape') parts.push(shapeSvg(o));
    else if (o.type === 'image') parts.push(imageSvg(o));
  }
  parts.push(strokesSvg(strokes, 'over'));
  parts.push('</svg>');
  return parts.join('\n');
}
