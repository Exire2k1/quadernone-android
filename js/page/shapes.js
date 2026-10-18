// Shape objects (vector, editable) and shape recognition from a hand-drawn stroke.
//
// A shape object: { id, type: 'shape', kind, points, stroke: { color, width }, fill,
//                   x, y, w, h (bbox), rotation: 0, z, locked }
// points (page mm): line/arrow [a, b] · triangle [a, b, c] · rect [a, b, c, d] ·
// ellipse [centre, end of axis 1, end of axis 2]. Being points only, every shape follows
// moves, scaling and rotation by transforming its points.

export const SHAPE_KINDS = ['line', 'arrow', 'rect', 'ellipse', 'triangle'];

const r2 = (n) => Math.round(n * 100) / 100;
const newHex = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function makeShape(kind, points, { color, width, fill = null }, z = 1) {
  const obj = { id: 'ob-' + newHex(), type: 'shape', kind, points: points.map(([x, y]) => [r2(x), r2(y)]),
    stroke: { color, width }, fill, rotation: 0, z, locked: false, x: 0, y: 0, w: 0, h: 0 };
  return withBBox(obj);
}

function ellipseParams(points) {
  const [c, a, b] = points;
  return { cx: c[0], cy: c[1], rx: Math.hypot(a[0] - c[0], a[1] - c[1]), ry: Math.hypot(b[0] - c[0], b[1] - c[1]),
    rot: Math.atan2(a[1] - c[1], a[0] - c[0]) };
}

/** Recomputes x, y, w, h from the points. */
export function withBBox(obj) {
  let pts = obj.points;
  if (obj.kind === 'ellipse') {
    const { cx, cy, rx, ry, rot } = ellipseParams(pts);
    const ex = Math.sqrt((rx * Math.cos(rot)) ** 2 + (ry * Math.sin(rot)) ** 2);
    const ey = Math.sqrt((rx * Math.sin(rot)) ** 2 + (ry * Math.cos(rot)) ** 2);
    pts = [[cx - ex, cy - ey], [cx + ex, cy + ey]];
  }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  obj.x = r2(Math.min(...xs)); obj.y = r2(Math.min(...ys));
  obj.w = r2(Math.max(...xs) - obj.x); obj.h = r2(Math.max(...ys) - obj.y);
  return obj;
}

/** Arrow head: two short segments at the end point. */
function arrowHead(a, b, width) {
  const len = Math.max(3, width * 4), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const p1 = [b[0] - len * Math.cos(ang - 0.45), b[1] - len * Math.sin(ang - 0.45)];
  const p2 = [b[0] - len * Math.cos(ang + 0.45), b[1] - len * Math.sin(ang + 0.45)];
  return `M${r2(p1[0])} ${r2(p1[1])}L${r2(b[0])} ${r2(b[1])}L${r2(p2[0])} ${r2(p2[1])}`;
}

/** Path data (ellipses too, as two arcs) for any shape kind. */
export function shapePathD(obj) {
  const p = obj.points;
  const pt = (q) => `${r2(q[0])} ${r2(q[1])}`;
  switch (obj.kind) {
    case 'line': return `M${pt(p[0])}L${pt(p[1])}`;
    case 'arrow': return `M${pt(p[0])}L${pt(p[1])}` + arrowHead(p[0], p[1], obj.stroke.width);
    case 'ellipse': {
      const { cx, cy, rx, ry, rot } = ellipseParams(p);
      const deg = r2(rot * 180 / Math.PI);
      const sx = cx + rx * Math.cos(rot), sy = cy + rx * Math.sin(rot);
      const ox = cx - rx * Math.cos(rot), oy = cy - rx * Math.sin(rot);
      return `M${r2(sx)} ${r2(sy)}A${r2(rx)} ${r2(ry)} ${deg} 1 1 ${r2(ox)} ${r2(oy)}A${r2(rx)} ${r2(ry)} ${deg} 1 1 ${r2(sx)} ${r2(sy)}Z`;
    }
    default: return `M${p.map(pt).join('L')}Z`;   // rect, triangle
  }
}

const isOpen = (kind) => kind === 'line' || kind === 'arrow';

/** SVG element markup, in page mm. */
export function shapeSvg(obj) {
  const fill = !isOpen(obj.kind) && obj.fill ? obj.fill : 'none';
  return `<path d="${shapePathD(obj)}" fill="${fill}" stroke="${obj.stroke.color}" stroke-width="${obj.stroke.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** Draws into a canvas whose unit is 1 mm. */
export function drawShape(ctx, obj) {
  const path = new Path2D(shapePathD(obj));
  ctx.save();
  if (!isOpen(obj.kind) && obj.fill) { ctx.fillStyle = obj.fill; ctx.fill(path); }
  ctx.strokeStyle = obj.stroke.color;
  ctx.lineWidth = obj.stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();
}

/** DOM element for the page: an inline SVG sized to the shape's bbox (follows --s). */
export function createShapeEl(obj) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.classList.add('obj', 'obj-shape');
  el.dataset.objId = obj.id;
  updateShapeEl(el, obj);
  return el;
}

export function updateShapeEl(el, obj) {
  const pad = obj.stroke.width * 3 + 2;
  const x = obj.x - pad, y = obj.y - pad, w = obj.w + pad * 2, h = obj.h + pad * 2;
  el.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  el.style.setProperty('--x', x); el.style.setProperty('--y', y);
  el.style.setProperty('--w', w); el.style.setProperty('--h', h);
  el.style.zIndex = String(10 + (obj.z || 0));
  el.innerHTML = shapeSvg(obj);
}

export function transformShape(obj, m, widthScale = 1) {
  const out = { ...obj, stroke: { ...obj.stroke, width: r2(obj.stroke.width * widthScale) } };
  out.points = obj.points.map(([x, y]) => { const q = m.transformPoint({ x, y }); return [r2(q.x), r2(q.y)]; });
  return withBBox(out);
}

/** Shape points for "insert" mode: dragged from a to b. */
export function shapeFromDrag(kind, a, b) {
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]), x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  switch (kind) {
    case 'line': case 'arrow': return [a, b];
    case 'rect': return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    case 'triangle': return [[(x0 + x1) / 2, y0], [x1, y1], [x0, y1]];
    default: { const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; return [[cx, cy], [x1, cy], [cx, y1]]; }
  }
}

// ------------------------------------------------------------------ recognition

function hull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const area = (poly) => Math.abs(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

/** Minimum-area bounding rectangle of a convex hull (rotating calipers). */
function minRect(h) {
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of h) {
      const x = p[0] * c - p[1] * s, y = p[0] * s + p[1] * c;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const ar = (x1 - x0) * (y1 - y0);
    if (!best || ar < best.area) best = { area: ar, ang, x0, y0, x1, y1 };
  }
  const { ang, x0, y0, x1, y1 } = best;
  const c = Math.cos(ang), s = Math.sin(ang);
  const back = ([x, y]) => [x * c - y * s, x * s + y * c];
  return { ...best, corners: [back([x0, y0]), back([x1, y0]), back([x1, y1]), back([x0, y1])], w: x1 - x0, h: y1 - y0 };
}

function maxTriangle(h) {
  const pts = h.length > 40 ? h.filter((_, i) => i % Math.ceil(h.length / 40) === 0) : h;
  let best = null, bestA = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
    const a = area([pts[i], pts[j], pts[k]]);
    if (a > bestA) { bestA = a; best = [pts[i], pts[j], pts[k]]; }
  }
  return { tri: best, area: bestA };
}

/** Rotates a rectangle/ellipse so it is axis-aligned when it is nearly so. */
function snapAngle(ang) {
  const deg = ((ang * 180 / Math.PI) % 90 + 90) % 90;
  return deg < 7 || deg > 83;
}

/**
 * Recognises a line, rectangle, ellipse/circle or triangle in a hand-drawn stroke.
 * Returns { kind, points } or null if nothing fits well enough.
 */
export function recognize(rawPoints) {
  const pts = rawPoints.map((p) => [p[0], p[1]]);
  if (pts.length < 3) return null;
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (len < 6) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const chord = Math.hypot(last[0] - first[0], last[1] - first[1]);
  if (chord / len > 0.92) return { kind: 'line', points: [first, last] };
  const h = hull(pts);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (chord > len * 0.2 || chord > size * 0.3) return null;   // open curve: not a closed shape
  if (h.length < 3) return null;
  const aHull = area(h);
  const mr = minRect(h);
  const tri = maxTriangle(h);
  const fillRect = aHull / mr.area;
  if (tri.area / aHull > 0.86 && fillRect < 0.72) return { kind: 'triangle', points: tri.tri };
  if (fillRect > 0.86) {
    let corners = mr.corners;
    if (snapAngle(mr.ang)) {
      const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    }
    return { kind: 'rect', points: corners };
  }
  const ellipseArea = Math.PI * mr.w * mr.h / 4;
  if (Math.abs(aHull / ellipseArea - 1) < 0.16) {
    const cx = (mr.corners[0][0] + mr.corners[2][0]) / 2, cy = (mr.corners[0][1] + mr.corners[2][1]) / 2;
    let rx = mr.w / 2, ry = mr.h / 2, ang = mr.ang;
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.12) { rx = ry = (rx + ry) / 2; ang = 0; }   // a circle
    else if (snapAngle(ang)) ang = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
    return { kind: 'ellipse', points: [[cx, cy], [cx + rx * Math.cos(ang), cy + rx * Math.sin(ang)], [cx - ry * Math.sin(ang), cy + ry * Math.cos(ang)]] };
  }
  return null;
}
