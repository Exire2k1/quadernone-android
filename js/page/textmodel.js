// Text boxes are stored as structured blocks (never HTML):
//   blocks: [{ t: 'h1'|'h2'|'h3'|'p'|'ul'|'ol'|'check', done?, runs: [{ text, b, i, u, s, color }] }]
// This module converts blocks <-> the DOM of the contenteditable editor, and lays
// text out for canvas/SVG rendering (thumbnails, cover, previews).

export const PT_MM = 25.4 / 72;           // 1 pt in mm
export const LINE_HEIGHT = 1.35;
export const BLOCK_SCALE = { h1: 1.8, h2: 1.45, h3: 1.2, p: 1, ul: 1, ol: 1, check: 1 };
export const BLOCK_TYPES = ['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'check'];
const LIST_INDENT_EM = 1.5;
export const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';

export const isHeading = (t) => t === 'h1' || t === 'h2' || t === 'h3';

export function emptyBlocks() { return [{ t: 'p', runs: [] }]; }

// ------------------------------------------------------------------ blocks -> DOM

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function runHtml(r) {
  let h = escapeHtml(r.text || '');
  if (!h) return '';
  if (r.color) h = `<font color="${r.color}">${h}</font>`;
  if (r.s) h = `<strike>${h}</strike>`;
  if (r.u) h = `<u>${h}</u>`;
  if (r.i) h = `<i>${h}</i>`;
  if (r.b) h = `<b>${h}</b>`;
  return h;
}

/** HTML for the editor: one <div data-t> per block. */
export function blocksToHtml(blocks) {
  return (blocks?.length ? blocks : emptyBlocks()).map((b) => {
    const inner = (b.runs || []).map(runHtml).join('') || '<br>';
    const done = b.t === 'check' && b.done ? ' data-done="1"' : '';
    return `<div data-t="${BLOCK_TYPES.includes(b.t) ? b.t : 'p'}"${done}>${inner}</div>`;
  }).join('');
}

// ------------------------------------------------------------------ DOM -> blocks

function normColor(c) {
  if (!c) return null;
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toUpperCase();
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (m) return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
  return null;
}

/** Formatting that applies to a node, from its ancestors up to the block element. */
function styleOf(node, blockEl) {
  const st = { b: false, i: false, u: false, s: false, color: null };
  for (let el = node.parentElement; el && el !== blockEl; el = el.parentElement) {
    const tag = el.tagName;
    if (tag === 'B' || tag === 'STRONG') st.b = true;
    if (tag === 'I' || tag === 'EM') st.i = true;
    if (tag === 'U') st.u = true;
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') st.s = true;
    if (!st.color && tag === 'FONT' && el.getAttribute('color')) st.color = normColor(el.getAttribute('color'));
    const css = el.style;
    if (css) {
      if (css.fontWeight === 'bold' || Number(css.fontWeight) >= 600) st.b = true;
      if (css.fontStyle === 'italic') st.i = true;
      if (css.textDecorationLine?.includes('underline') || css.textDecoration?.includes('underline')) st.u = true;
      if (css.textDecorationLine?.includes('line-through') || css.textDecoration?.includes('line-through')) st.s = true;
      if (!st.color && css.color) st.color = normColor(css.color);
    }
  }
  return st;
}

function sameStyle(a, b) {
  return a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s && a.color === b.color;
}

function compactRun(r) {
  const out = { text: r.text };
  for (const k of ['b', 'i', 'u', 's']) if (r[k]) out[k] = true;
  if (r.color) out.color = r.color;
  return out;
}

function runsOf(blockEl) {
  const runs = [];
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    let text = '';
    if (n.nodeType === Node.TEXT_NODE) text = n.nodeValue.replace(/​/g, '');
    else if (n.tagName === 'BR' && n.nextSibling) text = ' '; // soft line break inside a block
    if (!text) continue;
    const st = styleOf(n.nodeType === Node.TEXT_NODE ? n : n, blockEl);
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, st)) last.text += text;
    else runs.push({ text, ...st });
  }
  return runs.map(compactRun);
}

/** Reads the editor DOM back into blocks. Stray inline content becomes a paragraph. */
export function htmlToBlocks(root) {
  const blocks = [];
  let loose = null;
  for (const child of [...root.childNodes]) {
    if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'DIV' || child.tagName === 'P' || /^H[1-6]$/.test(child.tagName) || child.tagName === 'LI')) {
      loose = null;
      let t = child.dataset?.t;
      if (!BLOCK_TYPES.includes(t)) t = /^H[1-3]$/.test(child.tagName) ? child.tagName.toLowerCase() : 'p';
      const b = { t, runs: runsOf(child) };
      if (t === 'check') b.done = child.dataset.done === '1';
      blocks.push(b);
    } else if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'UL' || child.tagName === 'OL')) {
      loose = null;
      for (const li of child.children) blocks.push({ t: child.tagName === 'OL' ? 'ol' : 'ul', runs: runsOf(li) });
    } else {
      // Text typed directly into the root (before the first block exists).
      if (!loose) { loose = document.createElement('div'); blocks.push(null); loose.idx = blocks.length - 1; }
      loose.append(child.cloneNode(true));
      blocks[loose.idx] = { t: 'p', runs: runsOf(loose) };
    }
  }
  return blocks.length ? blocks : emptyBlocks();
}

export const blocksText = (blocks) => blocks.map((b) => b.runs.map((r) => r.text).join('')).join('\n');
export const isEmptyText = (blocks) => !blocks.some((b) => b.runs.some((r) => r.text.trim()));

// ------------------------------------------------------------------ layout (canvas / SVG)

let measureCtx = null;
const MEASURE_PX_PER_MM = 8; // measuring scale: px per mm

function fontFor(sizeMm, run, heading) {
  const weight = run.b || heading ? 700 : 400;
  return `${run.i ? 'italic ' : ''}${weight} ${(sizeMm * MEASURE_PX_PER_MM).toFixed(2)}px ${FONT_STACK}`;
}

function measure(text, font) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(text).width / MEASURE_PX_PER_MM;
}

/**
 * Lays out a text object. Returns { lines, heightMm } with, per line:
 * { y: baseline (mm, from the box top), sizeMm, segs: [{ x, text, run, sizeMm, heading }], marker }
 * where x is relative to the box left edge.
 */
export function layoutText(obj) {
  const base = (obj.style?.sizePt || 12) * PT_MM;
  const align = obj.style?.align || 'left';
  const lines = [];
  let y = 0;
  let olN = 0;
  for (const b of obj.blocks || []) {
    const sizeMm = base * (BLOCK_SCALE[b.t] || 1);
    const heading = isHeading(b.t);
    const lineH = sizeMm * LINE_HEIGHT;
    const isList = b.t === 'ul' || b.t === 'ol' || b.t === 'check';
    olN = b.t === 'ol' ? olN + 1 : 0;
    const indent = isList ? base * LIST_INDENT_EM : 0;
    const maxW = Math.max(5, obj.w - indent);
    // Tokens keep their run, so formatting survives wrapping.
    const tokens = [];
    for (const run of b.runs || []) for (const part of (run.text || '').split(/(\s+)/)) if (part) tokens.push({ text: part, run });
    let cur = [], curW = 0;
    const blockLines = [];
    const push = () => { blockLines.push({ segs: cur, width: curW }); cur = []; curW = 0; };
    for (const tok of tokens) {
      const font = fontFor(sizeMm, tok.run, heading);
      let w = measure(tok.text, font);
      if (/^\s+$/.test(tok.text) && !cur.length) continue; // no leading spaces on wrapped lines
      if (curW + w > maxW && cur.length) push();
      if (w > maxW) {
        // A single word wider than the box: break it by characters.
        let chunk = '';
        for (const ch of tok.text) {
          const cw = measure(chunk + ch, font);
          if (cw > maxW && chunk) { cur.push({ text: chunk, run: tok.run, w: measure(chunk, font) }); curW += measure(chunk, font); push(); chunk = ''; }
          chunk += ch;
        }
        tok.text = chunk; w = measure(chunk, font);
      }
      cur.push({ text: tok.text, run: tok.run, w });
      curW += w;
    }
    push();
    blockLines.forEach((ln, i) => {
      // Trailing spaces do not count for alignment.
      while (ln.segs.length && /^\s+$/.test(ln.segs[ln.segs.length - 1].text)) ln.width -= ln.segs.pop().w;
      let x = indent;
      if (align === 'center') x = indent + (maxW - ln.width) / 2;
      else if (align === 'right') x = indent + maxW - ln.width;
      const segs = [];
      for (const s of ln.segs) { segs.push({ x, text: s.text, run: s.run, sizeMm, heading }); x += s.w; }
      let marker = null;
      if (i === 0 && isList) {
        marker = b.t === 'ul' ? { kind: 'bullet' } : b.t === 'ol' ? { kind: 'number', text: olN + '.' } : { kind: 'check', done: !!b.done };
        marker.x = 0; marker.sizeMm = sizeMm;
      }
      lines.push({ y: y + sizeMm * 1.02, sizeMm, segs, marker });
      y += lineH;
    });
    if (heading) y += sizeMm * 0.15;
  }
  return { lines, heightMm: y };
}

/** Width in mm of a laid-out segment. */
export const segWidth = (s) => measure(s.text, fontFor(s.sizeMm, s.run, s.heading));

/** Draws a laid-out text object into a canvas context whose unit is 1 mm. */
export function drawText(ctx, obj, defaultColor) {
  const { lines } = layoutText(obj);
  const color = obj.style?.color || defaultColor;
  ctx.save();
  ctx.translate(obj.x, obj.y);
  if (obj.rotation) { ctx.translate(obj.w / 2, (obj.h || 0) / 2); ctx.rotate(obj.rotation * Math.PI / 180); ctx.translate(-obj.w / 2, -(obj.h || 0) / 2); }
  ctx.textBaseline = 'alphabetic';
  for (const ln of lines) {
    if (ln.marker) drawMarker(ctx, ln, color);
    for (const s of ln.segs) {
      const weight = s.run.b || s.heading ? 700 : 400;
      // Canvas fonts need px: draw at 10x and scale down (fractional px sizes are unreliable).
      ctx.save();
      ctx.scale(0.1, 0.1);
      ctx.font = `${s.run.i ? 'italic ' : ''}${weight} ${(s.sizeMm * 10).toFixed(2)}px ${FONT_STACK}`;
      ctx.fillStyle = s.run.color || color;
      ctx.fillText(s.text, s.x * 10, ln.y * 10);
      ctx.restore();
      if (s.run.u || s.run.s) {
        const w = segWidth(s);
        ctx.fillStyle = s.run.color || color;
        const th = Math.max(0.15, s.sizeMm * 0.06);
        if (s.run.u) ctx.fillRect(s.x, ln.y + s.sizeMm * 0.12, w, th);
        if (s.run.s) ctx.fillRect(s.x, ln.y - s.sizeMm * 0.3, w, th);
      }
    }
  }
  ctx.restore();
}

function drawMarker(ctx, ln, color) {
  const m = ln.marker, sz = m.sizeMm;
  ctx.fillStyle = ctx.strokeStyle = color;
  if (m.kind === 'bullet') {
    ctx.beginPath(); ctx.arc(m.x + sz * 0.45, ln.y - sz * 0.32, sz * 0.13, 0, Math.PI * 2); ctx.fill();
  } else if (m.kind === 'number') {
    ctx.save(); ctx.scale(0.1, 0.1);
    ctx.font = `400 ${(sz * 10).toFixed(2)}px ${FONT_STACK}`;
    ctx.fillText(m.text, m.x * 10, ln.y * 10);
    ctx.restore();
  } else {
    const b = sz * 0.72, top = ln.y - sz * 0.72;
    ctx.lineWidth = Math.max(0.15, sz * 0.07);
    ctx.strokeRect(m.x + sz * 0.05, top, b, b);
    if (m.done) {
      ctx.beginPath();
      ctx.moveTo(m.x + sz * 0.18, top + b * 0.52); ctx.lineTo(m.x + sz * 0.36, top + b * 0.78); ctx.lineTo(m.x + sz * 0.7, top + b * 0.2);
      ctx.stroke();
    }
  }
}
