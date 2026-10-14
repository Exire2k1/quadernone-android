// DOM for a text object on a page. Positions and sizes are in mm and follow the
// zoom through the --s custom property set by the page view.
import { blocksToHtml, htmlToBlocks, PT_MM } from './textmodel.js';

export function createTextEl(obj, inkColor) {
  const el = document.createElement('div');
  el.className = 'obj obj-text';
  el.dataset.objId = obj.id;
  const content = document.createElement('div');
  content.className = 'tb-content';
  content.spellcheck = true;
  content.lang = 'it';
  el.append(content);
  applyTextStyle(el, obj, inkColor);
  content.innerHTML = blocksToHtml(obj.blocks);
  return el;
}

export function applyTextStyle(el, obj, inkColor) {
  const st = obj.style || {};
  el.style.setProperty('--x', obj.x);
  el.style.setProperty('--y', obj.y);
  el.style.setProperty('--w', obj.w);
  el.style.setProperty('--fs', ((st.sizePt || 12) * PT_MM).toFixed(4));
  el.style.setProperty('--rot', (obj.rotation || 0) + 'deg');
  el.style.color = st.color || inkColor;
  el.style.textAlign = st.align || 'left';
  el.style.zIndex = String(10 + (obj.z || 0));
}

/** Reads the edited content back. */
export function readBlocks(el) {
  return htmlToBlocks(el.querySelector('.tb-content'));
}

/** Content height in mm (the box grows with its text). */
export function measuredHeightMm(el, s) {
  return Math.round((el.querySelector('.tb-content').offsetHeight / s) * 100) / 100;
}
