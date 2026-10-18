// Paper and procedural backgrounds (blank, lined, grid, dotted), drawn from pages.json
// values in millimetres. Shared by the live page canvas, thumbnails, cover and SVG previews.

export const PAPER = { white: '#FFFFFF', ivory: '#F6F0E1', sand: '#F4E4D7', grey: '#D9DADC', dark: '#24262A' };
const DARK_LINE = '#5B6270';
const LINE_MM = 0.2;        // line thickness
const DOT_MM = 0.45;        // dot diameter

export const paperFill = (bg) => PAPER[bg.paperColor] || PAPER.white;
export const lineColor = (bg) => (bg.paperColor === 'dark' ? DARK_LINE : bg.lineColor);
/** Default ink/text colour that reads well on this paper. */
export const defaultInk = (bg) => (bg?.paperColor === 'dark' ? '#ECECEC' : '#1A1A1A');

/** Line positions in mm along an axis of length len (lines start one spacing from the edge). */
function positions(len, spacing) {
  const out = [];
  for (let p = spacing; p < len - 0.01; p += spacing) out.push(p);
  return out;
}

/**
 * Draws the background of the region [y0, y0 + hMm] of a page into ctx.
 * ctx is set up so 1 unit = 1 mm from the top-left of the region.
 */
export function drawBackground(ctx, page, y0 = 0, hMm = page.size.heightMm) {
  const bg = page.background;
  const w = page.size.widthMm;
  ctx.fillStyle = paperFill(bg);
  ctx.fillRect(0, 0, w, hMm);
  if (bg.type === 'blank') return;
  const s = bg.spacingMm;
  ctx.fillStyle = ctx.strokeStyle = lineColor(bg);
  if (bg.type === 'lined' || bg.type === 'grid') {
    ctx.lineWidth = LINE_MM;
    ctx.beginPath();
    for (const y of positions(page.size.heightMm, s)) {
      if (y < y0 - 1 || y > y0 + hMm + 1) continue;
      ctx.moveTo(0, y - y0); ctx.lineTo(w, y - y0);
    }
    if (bg.type === 'grid') {
      for (const x of positions(w, s)) { ctx.moveTo(x, 0); ctx.lineTo(x, hMm); }
    }
    ctx.stroke();
  } else if (bg.type === 'dotted') {
    const r = DOT_MM / 2;
    for (const y of positions(page.size.heightMm, s)) {
      if (y < y0 - 1 || y > y0 + hMm + 1) continue;
      for (const x of positions(w, s)) { ctx.beginPath(); ctx.arc(x, y - y0, r, 0, Math.PI * 2); ctx.fill(); }
    }
  }
}

/** The same background as SVG markup (units: mm). */
export function backgroundSvg(page) {
  const bg = page.background;
  const w = page.size.widthMm, h = page.size.heightMm;
  const parts = [`<rect width="${w}" height="${h}" fill="${paperFill(bg)}"/>`];
  if (bg.type === 'blank') return parts.join('');
  const s = bg.spacingMm, c = lineColor(bg);
  const r2 = (n) => Math.round(n * 100) / 100;
  if (bg.type === 'lined' || bg.type === 'grid') {
    let d = positions(h, s).map((y) => `M0 ${r2(y)}H${w}`).join('');
    if (bg.type === 'grid') d += positions(w, s).map((x) => `M${r2(x)} 0V${h}`).join('');
    parts.push(`<path d="${d}" stroke="${c}" stroke-width="${LINE_MM}" fill="none"/>`);
  } else {
    // A pattern keeps dotted previews small.
    parts.push(`<defs><pattern id="dots" x="${s / 2}" y="${s / 2}" width="${s}" height="${s}" patternUnits="userSpaceOnUse"><circle cx="${s / 2}" cy="${s / 2}" r="${DOT_MM / 2}" fill="${c}"/></pattern></defs>`,
      `<rect width="${w}" height="${h}" fill="url(#dots)"/>`);
  }
  return parts.join('');
}
