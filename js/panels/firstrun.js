// First launch on a device: only its name (recorded in notes and in conflict copies).
import { h } from '../dom.js';
import { t } from '../i18n.js';
import * as prefs from '../prefs.js';
import { openPanel } from '../ui/panel.js';
import { icon } from '../icons.js';
import { folderMirror, supported as folderSupported } from '../local/folder.js';

const QUICK = ['tablet', 'lenovo', 'phone', 'pc'];

/** Device-name picker: quick choices plus a custom field. */
export function deviceNameField(initial, onChange) {
  let value = initial || '';
  const custom = h('input.field-input', { type: 'text', maxLength: 40, placeholder: t('firstRun.deviceCustom'), value: QUICK.some((k) => t('devices.' + k) === value) ? '' : value,
    oninput: (e) => { value = e.target.value.trim(); onChange(value); paint(); } });
  const chips = QUICK.map((k) => h('button.seg', { type: 'button', onclick: () => { value = t('devices.' + k); custom.value = ''; onChange(value); paint(); } }, t('devices.' + k)));
  const paint = () => chips.forEach((c, i) => c.classList.toggle('active', t('devices.' + QUICK[i]) === value));
  paint();
  return h('div.field', {}, h('span.field-label', {}, t('firstRun.deviceName')), h('div.segmented.wrap', {}, chips), custom);
}

/** Optional: the folder where notes are also kept as files (an existing one brings them back). */
function folderField() {
  const state = h('p.hint', {}, t('folder.firstRunHint'));
  const btn = h('button.btn', { type: 'button', onclick: async () => {
    try {
      // Device name first: restored notes and the folder record which device wrote them.
      const res = await folderMirror.choose();
      if (!res) return;
      state.textContent = t('folder.firstRunChosen', { name: folderMirror.name }) + (res.restored ? ' · ' + t('folder.restored', { n: res.restored }) : '');
      state.className = 'form-msg ok';
      btn.textContent = t('folder.change');
    } catch (e) { state.textContent = e.message || String(e); state.className = 'form-msg'; }
  } }, icon('folder'), h('span', {}, t('folder.choose')));
  return h('div.field', {}, h('span.field-label', {}, t('folder.firstRun')), h('div.btn-row', {}, btn), state);
}

export function showFirstRun() {
  return new Promise((resolve) => {
    let device = prefs.get('deviceName');
    const msg = h('p.form-msg', { role: 'alert' });
    const go = h('button.btn.primary.wide', { type: 'button', onclick: () => start() }, t('firstRun.test'));

    function start() {
      msg.textContent = '';
      if (!device) { msg.textContent = t('firstRun.needDevice'); return; }
      prefs.set('deviceName', device);
      p.dismissable = true;
      p.close();
      resolve();
    }

    const p = openPanel({
      title: t('firstRun.title'), variant: 'full', dismissable: false, className: 'first-run',
      body: [
        h('div.first-run-mark', {}, icon('notebook')),
        h('p.lead', {}, t('firstRun.intro')),
        deviceNameField(device, (v) => { device = v; }),
        folderSupported ? folderField() : null,
        msg, go,
      ],
    });
  });
}
