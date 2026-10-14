// Note covers: "preset" (colour + icon + title) or "auto" (the first page, cover.png).
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { lazyCover } from './coverimages.js';

export const COVER_COLORS = ['#3B6EA8', '#2F8F83', '#5C8A3A', '#B8862B', '#C0603A', '#A8434F', '#8A4E9C', '#5B5FB0', '#4A5560', '#2B2D31'];

/** Text colour that stays readable on a cover colour. */
function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#1A1A1A' : '#FFFFFF';
}

export function renderCover(note, { small = false } = {}) {
  const c = note.cover || { mode: 'auto' };
  if (c.mode === 'preset' && c.color) {
    return h(`div.cover.cover-preset${small ? '.small' : ''}`, { style: { background: c.color, color: inkFor(c.color) } },
      h('div.cover-spine'),
      c.icon ? icon(c.icon, 'cover-icon') : null,
      small ? null : h('div.cover-label', {}, note.title));
  }
  // auto: the first page (cover.png), or until it exists a sheet with the title on it
  if (note.hasCoverImage && note.id && note.coverVersion) {
    const img = h('img.cover-img', { alt: '', decoding: 'async', draggable: false });
    lazyCover(img, note.id, note.coverVersion);
    return h(`div.cover.cover-auto.has-img${small ? '.small' : ''}`, {}, img);
  }
  return h(`div.cover.cover-auto${small ? '.small' : ''}`, {},
    small ? null : h('div.cover-paper-title', {}, note.title));
}
