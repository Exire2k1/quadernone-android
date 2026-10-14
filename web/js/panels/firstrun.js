// First launch on a device: device name, server URL, token. Closes only after a
// successful test of the connection.
import { h } from '../dom.js';
import { t } from '../i18n.js';
import * as prefs from '../prefs.js';
import { api, request } from '../api.js';
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
    const url = h('input.field-input', { type: 'url', value: prefs.serverBase(), inputMode: 'url', autocomplete: 'off' });
    const token = h('input.field-input.mono', { type: 'text', placeholder: t('firstRun.tokenPlaceholder'), autocomplete: 'off', autocapitalize: 'none', spellcheck: false, value: prefs.get('token') || '' });
    const msg = h('p.form-msg', { role: 'alert' });
    const go = h('button.btn.primary.wide', { type: 'button', onclick: () => test() }, t('firstRun.test'));

    async function test() {
      msg.textContent = '';
      if (!device) { msg.textContent = t('firstRun.needDevice'); return; }
      const tok = token.value.trim().toLowerCase().replace(/\s+/g, '');
      if (!tok) { msg.textContent = t('firstRun.needToken'); return; }
      const base = url.value.trim().replace(/\/+$/, '') || location.origin;
      go.disabled = true; go.textContent = t('firstRun.testing');
      try {
        await api.health(base);
        await request('GET', '/settings', undefined, { token: tok, base });
        prefs.update({ deviceName: device, token: tok, serverUrl: base === location.origin ? '' : base });
        p.dismissable = true;
        p.close();
        resolve();
      } catch (e) {
        msg.textContent = e.message;
      } finally {
        go.disabled = false; go.textContent = t('firstRun.test');
      }
    }
    token.addEventListener('keydown', (e) => { if (e.key === 'Enter') test(); });

    const p = openPanel({
      title: t('firstRun.title'), variant: 'full', dismissable: false, className: 'first-run',
      body: [
        h('div.first-run-mark', {}, icon('notebook')),
        h('p.lead', {}, t('firstRun.intro')),
        deviceNameField(device, (v) => { device = v; }),
        h('label.field', {}, h('span.field-label', {}, t('firstRun.serverUrl')), url),
        h('label.field', {}, h('span.field-label', {}, t('firstRun.token')), token),
        msg, go,
      ],
    });
  });
}
