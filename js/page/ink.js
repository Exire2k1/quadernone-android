// Ink strokes: outlines (perfect-freehand), drawing into canvases, SVG export, hit tests.
// Units are millimetres everywhere; points are [x, y, pressure, t].
import { getStroke } from '../../vendor/perfect-freehand/index.js';

export const PEN_TYPES = ['ballpoint', 'fountain', 'pencil', 'marker'];
export const PT_TO_MM = 25.4 / 72;

const cache = new WeakMap();   // stroke -> { path: Path2D, d: string, bbox: [x0, y0, x1, y1] }

const newHex = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const newStrokeId = () => 'st-' + newHex();

/**
 * Fountain pen: the nib is held at 45°, so strokes along it are thin and across it wide.
 * The direction is measured over ~1 mm on each side (not between neighbouring points, which
 * are a fraction of a millimetre apart and flip at every corner), and the width factor is
 * smoothed, so corners and stroke ends do not produce wedges or blobs.
 */
function directionalPressure(points) {
  const n = points.length;
  const SPAN = 1.0;   // mm
  const f = new Array(n);
  for (let i = 0; i < n; i++) {
    let a = i, b = i;
    while (a > 0 && Math.hypot(points[a][0] - points[i][0], points[a][1] - points[i][1]) < SPAN) a--;
    while (b < n - 1 && Math.hypot(points[b][0] - points[i][0], points[b][1] - points[i][1]) < SPAN) b++;
    const dx = points[b][0] - points[a][0], dy = points[b][1] - points[a][1];
    f[i] = dx || dy ? 0.45 + 0.55 * Math.abs(Math.sin(Math.atan2(dy, dx) - Math.PI / 4)) : 0.72;
  }
  // Light two-way smoothing of the factor.
  for (let k = 0; k < 2; k++) {
    for (let i = 1; i < n; i++) f[i] = f[i - 1] + (f[i] - f[i - 1]) * 0.5;
    for (let i = n - 2; i >= 0; i--) f[i] = f[i + 1] + (f[i] - f[i + 1]) * 0.5;
  }
  return points.map((p, i) => [p[0], p[1], Math.min(1, (p[2] ?? 0.5) * f[i] * 1.25)]);
}

function freehandOptions(stroke, last) {
  const pressure = stroke.pressure !== false;
  const base = { size: stroke.width, smoothing: 0.6, streamline: 0.35, last, simulatePressure: false };
  switch (stroke.tool) {
    case 'fountain': return { ...base, size: stroke.width * 1.6, thinning: pressure ? 0.7 : 0.45, streamline: 0.4 };
    case 'pencil': return { ...base, thinning: pressure ? 0.35 : 0, smoothing: 0.5 };
    case 'marker': return { ...base, thinning: 0, smoothing: 0.7, start: { cap: true }, end: { cap: true } };
    case 'highlighter': return { ...base, thinning: 0, smoothing: 0.7, streamline: 0.5 };
    default: return { ...base, thinning: pressure ? 0.15 : 0 };   // ballpoint: almost uniform
  }
}

/** Outline polygon of a stroke (array of [x, y]). */
export function outline(stroke, last = true) {
  if (stroke.tool === 'highlighter' && stroke.tip === 'chisel') return null;
  let pts = stroke.points;
  if (stroke.tool === 'fountain') pts = directionalPressure(pts);
  else if (stroke.pressure === false) pts = pts.map((p) => [p[0], p[1], 0.5]);
  // perfect-freehand has thresholds in absolute units meant for pixels (it drops the points of
  // the last 3 units of a stroke, offsets a lone point by 1 unit, ...). In millimetres those
  // are huge, so it works in tenths of a millimetre and the outline is scaled back.
  const o = freehandOptions(stroke, last);
  const S = OUTLINE_SCALE;
  const out = getStroke(pts.map((p) => [p[0] * S, p[1] * S, p[2] ?? 0.5]), { ...o, size: o.size * S });
  for (const q of out) { q[0] /= S; q[1] /= S; }
  return out;
}

const OUTLINE_SCALE = 10;

/** Chisel highlighter: a flat nib swept along the path, as quads (filled nonzero = their union). */
function chiselQuads(stroke) {
  const w = stroke.width, ang = -Math.PI / 6;
  const vx = Math.cos(ang + Math.PI / 2) * w / 2, vy = Math.sin(ang + Math.PI / 2) * w / 2;
  const tx = Math.cos(ang) * w * 0.08, ty = Math.sin(ang) * w * 0.08;
  const quads = [];
  const pts = stroke.points;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
    quads.push([
      [a[0] - vx - tx, a[1] - vy - ty], [a[0] + vx - tx, a[1] + vy - ty],
      [b[0] + vx + tx, b[1] + vy + ty], [b[0] - vx + tx, b[1] - vy + ty],
    ]);
  }
  return quads;
}

const r2 = (n) => Math.round(n * 100) / 100;

function outlineToD(poly) {
  if (!poly || poly.length < 2) return '';
  // Quadratic curves through the midpoints: smooth edges at any zoom.
  let d = `M${r2(poly[0][0])} ${r2(poly[0][1])}Q`;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    d += `${r2(x0)} ${r2(y0)} ${r2((x0 + x1) / 2)} ${r2((y0 + y1) / 2)} `;
  }
  return d + 'Z';
}

const boxes = new WeakMap();   // stroke -> bbox from its points (no outline needed)

/** Bounding box [x0, y0, x1, y1] of a stroke, padded by its width (cached, cheap). */
export function quickBBox(stroke) {
  let b = boxes.get(stroke);
  if (b) return b;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of stroke.points) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  const pad = stroke.width * 1.2;
  b = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  boxes.set(stroke, b);
  return b;
}

/** Path data + bbox for a finished stroke (cached). */
export function geometry(stroke) {
  let g = cache.get(stroke);
  if (g) return g;
  let d;
  if (stroke.tool === 'highlighter' && stroke.tip === 'chisel') {
    d = chiselQuads(stroke).map((q) => `M${q.map((p) => `${r2(p[0])} ${r2(p[1])}`).join('L')}Z`).join('');
  } else {
    d = outlineToD(outline(stroke));
  }
  g = { d, path: new Path2D(d), bbox: quickBBox(stroke) };
  cache.set(stroke, g);
  return g;
}

/** Path for a stroke still being drawn (not cached). */
export function livePath(stroke) {
  if (stroke.tool === 'highlighter' && stroke.tip === 'chisel') {
    return new Path2D(chiselQuads(stroke).map((q) => `M${q.map((p) => `${p[0]} ${p[1]}`).join('L')}Z`).join(''));
  }
  return new Path2D(outlineToD(outline(stroke, false)));
}

/** SVG markup for a stroke still being drawn (pencil grain only appears once committed). */
export function liveSvg(stroke) {
  const d = stroke.tool === 'highlighter' && stroke.tip === 'chisel'
    ? chiselQuads(stroke).map((q) => `M${q.map((p) => `${r2(p[0])} ${r2(p[1])}`).join('L')}Z`).join('')
    : outlineToD(outline(stroke, false));
  const op = stroke.tool === 'highlighter' ? Math.min(stroke.opacity ?? 0.35, 0.6) : (stroke.opacity ?? 1);
  return `<path d="${d}" fill="${stroke.color}"${op < 1 ? ` fill-opacity="${op}"` : ''}/>`;
}

export const isHighlighter = (s) => s.tool === 'highlighter';

// ------------------------------------------------------------------ drawing

const grain = new Map();   // colour -> CanvasPattern (pencil texture)

function pencilPattern(ctx, color) {
  let pat = grain.get(color);
  if (pat) return pat;
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const g = c.getContext('2d');
  g.fillStyle = color;
  const img = g.getImageData(0, 0, 48, 48);
  const n = parseInt(color.slice(1), 16);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = n >> 16; img.data[i + 1] = (n >> 8) & 255; img.data[i + 2] = n & 255;
    img.data[i + 3] = 140 + Math.random() * 115;   // uneven graphite
  }
  g.putImageData(img, 0, 0);
  pat = ctx.createPattern(c, 'repeat');
  pat.setTransform(new DOMMatrix().scale(0.06));   // ~3 mm tile in mm space
  grain.set(color, pat);
  return pat;
}

function paint(ctx, stroke, path) {
  ctx.globalAlpha = stroke.tool === 'highlighter' ? Math.min(stroke.opacity ?? 0.35, 0.6) : (stroke.opacity ?? 1);
  ctx.fillStyle = stroke.tool === 'pencil' ? pencilPattern(ctx, stroke.color) : stroke.color;
  ctx.fill(path, 'nonzero');
}

/**
 * Draws strokes intersecting the region [y0, y0+h] (mm). ctx: 1 unit = 1 mm, origin at the
 * region top-left. layer: 'under' = highlighter strokes, 'over' = everything else.
 */
export function drawStrokes(ctx, strokes, layer, y0 = 0, h = Infinity) {
  ctx.save();
  ctx.translate(0, -y0);
  for (const s of strokes) {
    if ((layer === 'under') !== isHighlighter(s)) continue;
    const g = geometry(s);
    if (g.bbox[3] < y0 || g.bbox[1] > y0 + h) continue;
    paint(ctx, s, g.path);
  }
  ctx.restore();
}

/** Draws one live stroke. */
export function drawLive(ctx, stroke) {
  ctx.save();
  paint(ctx, stroke, livePath(stroke));
  ctx.restore();
}

/** SVG markup for strokes of one layer. */
export function strokesSvg(strokes, layer) {
  return strokes.filter((s) => (layer === 'under') === isHighlighter(s)).map((s) => {
    const op = s.tool === 'highlighter' ? Math.min(s.opacity ?? 0.35, 0.6) : (s.opacity ?? 1);
    return `<path d="${geometry(s).d}" fill="${s.color}"${op < 1 ? ` fill-opacity="${op}"` : ''}/>`;
  }).join('');
}

// ------------------------------------------------------------------ hit tests / editing

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** True if the stroke passes within r mm of (x, y). */
export function strokeHit(stroke, x, y, r) {
  const b = quickBBox(stroke);   // not geometry(): erasing must not compute outlines
  if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
  const pts = stroke.points, rr = r + stroke.width / 2;
  if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= rr;
  for (let i = 1; i < pts.length; i++) if (distToSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= rr) return true;
  return false;
}

/**
 * Partial eraser: removes the parts of a stroke within r of (x, y) and returns the pieces
 * left (maybe none). Segments near the eraser are first subdivided, so the cut follows the
 * eraser circle even where the pen moved fast and its points are far apart.
 */
export function eraseArea(stroke, x, y, r) {
  if (!strokeHit(stroke, x, y, r)) return [stroke];
  const rr = r + stroke.width / 2;
  const step = Math.max(0.12, rr / 8);
  const src = stroke.points;
  const pts = [src[0]];
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > step && distToSeg(x, y, a[0], a[1], b[0], b[1]) <= rr) {
      const n = Math.ceil(len / step);
      for (let k = 1; k < n; k++) {
        const u = k / n;
        const q = [r2(a[0] + (b[0] - a[0]) * u), r2(a[1] + (b[1] - a[1]) * u)];
        if (a.length > 2) q.push(r2((a[2] ?? 0.5) + ((b[2] ?? 0.5) - (a[2] ?? 0.5)) * u));
        if (a.length > 3) q.push(Math.round((a[3] ?? 0) + ((b[3] ?? 0) - (a[3] ?? 0)) * u));
        pts.push(q);
      }
    }
    pts.push(b);
  }
  const pieces = [];
  let cur = [];
  for (const p of pts) {
    if (Math.hypot(p[0] - x, p[1] - y) <= rr) {
      if (cur.length > 1) pieces.push(cur);
      cur = [];
    } else cur.push(p);
  }
  if (cur.length > 1) pieces.push(cur);
  return pieces.map((p) => ({ ...stroke, id: newStrokeId(), points: p }));
}

/** Applies an affine transform (DOMMatrix, mm) to a stroke; widthScale scales its width. */
export function transformStroke(stroke, m, widthScale = 1) {
  return {
    ...stroke,
    width: Math.round(stroke.width * widthScale * 1000) / 1000,
    points: stroke.points.map((p) => {
      const q = m.transformPoint({ x: p[0], y: p[1] });
      return [r2(q.x), r2(q.y), ...p.slice(2)];
    }),
  };
}

export function strokesBBox(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const b = geometry(s).bbox;
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
  }
  return [x0, y0, x1, y1];
}
