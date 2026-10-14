// note.md: a plain-text mirror of a note, regenerated on every save (port of NoteMarkdown.php).
//
//   # <title>
//   ## Pagina N
//   ![Pagina N](previews/<pageId>.svg)
//   <text boxes converted from blocks to Markdown>
import { cpSlice } from './util.js';

const escapeLine = (s) => s.replace(/[\r\n]/g, ' ');
const escapeInline = (s) => s.replace(/[\r\n]/g, ' ').replace(/([\\`*_~[\]])/g, '\\$1');

function runs(list) {
  let s = '';
  for (const r of list || []) {
    let t = escapeInline(String(r?.text ?? ''));
    if (t === '') continue;
    if (r.s) t = `~~${t}~~`;
    if (r.i) t = `*${t}*`;
    if (r.b) t = `**${t}**`;
    s += t;
  }
  return s;
}

function blocks(list) {
  const lines = [];
  let olN = 0;
  for (const b of list || []) {
    const text = runs(b?.runs);
    const t = b?.t ?? 'p';
    olN = t === 'ol' ? olN + 1 : 0;
    switch (t) {
      case 'h1': lines.push(`### ${text}`); break;
      case 'h2': lines.push(`#### ${text}`); break;
      case 'h3': lines.push(`##### ${text}`); break;
      case 'ul': lines.push(`- ${text}`); break;
      case 'ol': lines.push(`${olN}. ${text}`); break;
      case 'check': lines.push(`- [${b.done ? 'x' : ' '}] ${text}`); break;
      default: lines.push(text);
    }
  }
  return lines.join('\n').trim();
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function build(title, pages) {
  const out = ['# ' + escapeLine(title), ''];
  (pages?.pages || []).forEach((page, i) => {
    const n = i + 1;
    out.push(`## Pagina ${n}`, '', `![Pagina ${n}](previews/${page.id}.svg)`, '');
    const objects = (page.objects || []).filter((o) => (o?.type ?? '') === 'text');
    // Reading order: top to bottom, then left to right.
    objects.sort((a, b) => cmp(a.y ?? 0, b.y ?? 0) || cmp(a.x ?? 0, b.x ?? 0));
    for (const o of objects) {
      const md = blocks(o.blocks);
      if (md !== '') out.push(md, '');
    }
  });
  return out.join('\n');
}

/** First line of real text (not a heading or the preview link), for the Library list view. */
export function snippet(md) {
  if (typeof md !== 'string') return '';
  const lines = md.split('\n');
  for (let i = 0; i < lines.length && i < 400; i++) {
    let line = lines[i].trim();
    if (line === '' || line[0] === '#' || line.startsWith('![')) continue;
    line = line.replace(/^(- \[[ x]\] |- |\d+\. )/, '');
    line = line.replaceAll('**', '').replaceAll('~~', '').replaceAll('\\', '');
    return cpSlice(line, 0, 140);
  }
  return '';
}
