// Turns user-typed titles into safe folder names (port of lib/Names.php).
//
// Rules: NFC normalisation, characters invalid on Windows/FAT -> "-", no leading dots,
// no trailing dots/spaces, reserved device names get "_", max 80 characters,
// case-insensitive de-duplication with " (2)", " (3)" ...
// The Windows rules stay: the notes folder may be copied to a PC or an SD card.
import { nfc, cpSlice, cpLen, trimChars } from './util.js';

export const MAX_SEGMENT = 80;
/** Names the app itself uses at the top of the data folder. */
export const RESERVED_ROOT = ['_app', '_trash'];

/** Cleans free text (titles, folder names as shown in the app). */
export function cleanTitle(s, max = 200) {
  s = nfc(s);
  s = s.replace(/[\x00-\x1F\x7F]+/gu, ' ');
  s = s.replace(/\s+/gu, ' ').trim();
  return cpSlice(s, 0, max);
}

/** Converts a title into one safe path segment (not yet de-duplicated). */
export function segment(title, fallback) {
  let s = cleanTitle(title, 500);
  s = s.replace(/[<>:"/\\|?*\x00-\x1F]/gu, '-');
  s = trimChars(s, '. ', 'left');
  s = cpSlice(s, 0, MAX_SEGMENT);
  s = trimChars(s, '. ', 'right');
  if (s === '') s = fallback;
  // Reserved device names, also with an extension ("con.txt").
  const dot = s.indexOf('.');
  const parts = dot < 0 ? [s] : [s.slice(0, dot), s.slice(dot + 1)];
  if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu.test(parts[0].trimEnd())) {
    parts[0] = parts[0].trimEnd() + '_';
    s = parts.join('.');
  }
  return s;
}

export const key = (name) => nfc(name).toLowerCase();

/**
 * Returns a segment not used in parentRel (case-insensitive), adding " (2)", " (3)" ...
 * ignore: an existing entry name that may be reused (renaming an item to itself).
 */
export async function unique(fs, parentRel, seg, ignore = null, isRoot = false) {
  const taken = new Set();
  for (const e of await fs.list(parentRel)) {
    if (ignore !== null && e === ignore) continue;
    taken.add(key(e));
  }
  if (isRoot) for (const r of RESERVED_ROOT) taken.add(r);
  if (!taken.has(key(seg))) return seg;
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const base = trimChars(cpSlice(seg, 0, MAX_SEGMENT - cpLen(suffix)), '. ', 'right');
    const cand = base + suffix;
    if (!taken.has(key(cand))) return cand;
  }
}
