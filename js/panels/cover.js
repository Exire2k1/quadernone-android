// Copertina: automatic (first page), an image (from the note or a new one), or colour +
// icon, with a live preview. apply(cover): how to save it (the editor saves through the
// open note; the Library through the API, then uploads cover.png for an image cover).
import { h, fill } from '../dom.js';
import { t } from '../i18n.js';
import { icon, COVER_ICONS } from '../icons.js';
import { openPanel } from '../ui/panel.js';
import { toastError } from '../ui/toast.js';
import { request } from '../api.js';
import * as prefs from '../prefs.js';
import * as files from '../local/files.js';
import { renderCover, COVER_COLORS } from '../library/cover.js';
import { setCover } from '../library/actions.js';
import { renderImageCover } from '../page/thumb.js';
import { pickFiles } from '../editor/inserts.js';

const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif)$/i;

/** Saves an image cover from the Library: meta first, then the cover.png made from it. */
async function applyFromLibrary(note, cover) {
  await setCover(note, cover);
  if (cover.mode !== 'image') return;
  try {
    const png = await renderImageCover(await files.imageBitmap(note.id, cover.image));
    await fetch(`${prefs.serverBase()}/api/notes/${note.id}/cover`, {
      method: 'PUT', body: png,
      headers: { 'Content-Type': 'image/png', 'X-Quadernone-Token': prefs.get('token'), 'X-Quadernone-Device': prefs.get('deviceName') },
    });
  } catch { /* the editor regenerates it next time */ }
}

export function openCoverPanel(note, { apply = null } = {}) {
  const cur = note.cover || { mode: 'auto' };
  const c = { mode: ['preset', 'image'].includes(cur.mode) ? cur.mode : 'auto', color: cur.color || COVER_COLORS[0], icon: cur.icon || 'book', image: cur.image || null };
  const preview = h('div.cover-preview');
  const controls = h('div');
  let images = null;   // attachment names (loaded when the image tab is opened)

  async function loadImages() {
    try {
      const res = await request('GET', `/notes/${note.id}/attachments`);
      // Display copies (img-x-view.jpg) stand for their originals.
      images = res.items.filter((n) => IMAGE_RE.test(n));
      const views = new Set(images.filter((n) => /-view\.[a-z]+$/i.test(n)));
      images = images.filter((n) => views.has(n) || !images.some((v) => views.has(v) && v.startsWith(n.replace(/\.[^.]+$/, '') + '-view')));
    } catch { images = c.image ? [c.image] : []; }
    render();
  }

  async function addImage() {
    const [f] = await pickFiles({ accept: 'image/*' });
    if (!f) return;
    try {
      const name = await files.upload(note.id, f, `cover-${files.randomTag()}.${(/\.([a-z0-9]+)$/i.exec(f.name)?.[1] || 'jpg').toLowerCase()}`);
      images = [...(images || []), name];
      c.image = name;
      render();
    } catch (e) { toastError(e); }
  }

  function render() {
    const shown = c.mode === 'preset' ? { mode: 'preset', color: c.color, icon: c.icon } : { mode: 'auto' };
    fill(preview, renderCover({ title: note.title, cover: shown, hasCoverImage: c.mode === 'image' ? false : note.hasCoverImage, id: note.id, coverVersion: note.coverVersion }));
    if (c.mode === 'image' && c.image) {
      const img = h('img.cover-img.loaded', { alt: '' });
      files.objectUrl(note.id, c.image).then((u) => { img.src = u; }).catch(() => {});
      fill(preview, h('div.cover.cover-auto.has-img', {}, img));
    }
    fill(controls,
      h('div.segmented', { role: 'radiogroup' },
        ['auto', 'image', 'preset'].map((m) => h(`button.seg${c.mode === m ? '.active' : ''}`, { type: 'button', onclick: () => { c.mode = m; if (m === 'image' && !images) loadImages(); render(); } }, t('cover.' + m)))),
      c.mode === 'auto' ? h('p.hint', {}, t('cover.autoHint'))
        : c.mode === 'image' ? [
          h('p.hint', {}, t('cover.imageHint')),
          images === null ? h('p.hint', {}, t('common.loading'))
            : images.length ? h('div.cover-images', {}, images.map((name) => {
              const im = h('img', { alt: '' });
              files.objectUrl(note.id, name).then((u) => { im.src = u; }).catch(() => {});
              return h(`button${c.image === name ? '.active' : ''}`, { type: 'button', 'aria-label': name, onclick: () => { c.image = name; render(); } }, im);
            })) : h('p.hint', {}, t('cover.noImages')),
          h('button.btn', { type: 'button', onclick: addImage }, icon('image'), h('span', {}, t('cover.pickFile'))),
        ]
          : [
            h('div.field', {}, h('span.field-label', {}, t('cover.color')),
              h('div.swatches', {}, COVER_COLORS.map((col) => h(`button.swatch${c.color === col ? '.active' : ''}`, {
                type: 'button', style: { background: col }, 'aria-label': col, onclick: () => { c.color = col; render(); },
              })))),
            h('div.field', {}, h('span.field-label', {}, t('cover.icon')),
              h('div.icon-grid', {}, COVER_ICONS.map((ic) => h(`button.icon-pick${c.icon === ic ? '.active' : ''}`, {
                type: 'button', 'aria-label': ic, onclick: () => { c.icon = ic; render(); },
              }, icon(ic))))),
          ]);
  }
  if (c.mode === 'image') loadImages();
  render();
  const p = openPanel({
    title: t('cover.title'),
    body: h('div.cover-panel', {}, preview, controls),
    footer: [
      h('button.btn', { type: 'button', onclick: () => p.close() }, t('common.cancel')),
      h('button.btn.primary', { type: 'button', onclick: async () => {
        const cover = c.mode === 'preset' ? { mode: 'preset', color: c.color, icon: c.icon, image: null }
          : c.mode === 'image' && c.image ? { mode: 'image', color: null, icon: null, image: c.image }
            : { mode: 'auto', color: null, icon: null, image: null };
        p.close();
        if (apply) apply(cover); else await applyFromLibrary(note, cover);
      } }, t('cover.apply')),
    ],
  });
}
