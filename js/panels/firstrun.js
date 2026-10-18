// First launch on a device: only its name (recorded in notes and in conflict copies).
import { h } from '../dom.js';
import { t } from '../i18n.js';
import * as prefs from '../prefs.js';
import { openPanel } from '../ui/panel.js';
import { icon } from '../icons.js';

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
        msg, go,
      ],
    });
  });
}
