// Names, titles and dates, as on the server (lib/Names.php): clean titles, safe file and
// folder names for Drive and zip exports (also valid on Windows), " (2)" de-duplication.
export const UNTITLED = 'Senza titolo';
export const MAX_SEGMENT = 80;

export const nfc = (s) => String(s ?? '').normalize('NFC');

export function cleanTitle(s, max = 200) {
  let out = nfc(s).replace(/[\x00-\x1F\x7F]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...out].slice(0, max).join('');
}

/** One safe path segment (Windows-valid, no leading dots, reserved names fixed). */
export function segment(title, fallback) {
  let s = cleanTitle(title, 500).replace(/[<>:"/\\|?*\x00-\x1F]/g, '-');
  s = s.replace(/^[. ]+/, '');
  s = [...s].slice(0, MAX_SEGMENT).join('').replace(/[. ]+$/, '');
  if (!s) s = fallback;
  const parts = s.split('.');
  if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(parts[0].trimEnd())) {
    parts[0] = parts[0].trimEnd() + '_';
    s = parts.join('.');
  }
  return s;
}

export const key = (name) => nfc(name).toLocaleLowerCase('it');

/** A name not in `taken` (case-insensitive), adding " (2)", " (3)" ... */
export function unique(name, taken) {
  const set = new Set([...taken].map(key));
  if (!set.has(key(name))) return name;
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const dot = name.lastIndexOf('.');
    // Keep a file extension at the end ("foto (2).jpg").
    const [stem, ext] = dot > 0 && /^\.[a-z0-9]{1,8}$/i.test(name.slice(dot)) ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    const base = [...stem].slice(0, MAX_SEGMENT - suffix.length - ext.length).join('').replace(/[. ]+$/, '');
    const cand = base + suffix + ext;
    if (!set.has(key(cand))) return cand;
  }
}

/** A safe attachment name that keeps its extension. */
export function attachmentName(wanted) {
  const base = nfc(String(wanted || 'file').split(/[\\/]/).pop());
  const dot = base.lastIndexOf('.');
  let ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (!/^[a-z0-9]{1,8}$/.test(ext)) ext = '';
  const stem = [...segment(dot > 0 ? base.slice(0, dot) : base, 'file')].slice(0, 100).join('');
  return ext ? `${stem}.${ext}` : stem;
}

export const now = () => new Date().toISOString();

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const newPageId = () => 'pg-' + hex(4);
export const uuid = () => crypto.randomUUID();
export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/.test(s);

/** Lower case without accents (search). */
export const fold = (s) => String(s).normalize('NFD').replace(/\p{Mn}+/gu, '').toLocaleLowerCase('it');
