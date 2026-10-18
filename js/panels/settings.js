// Impostazioni: Google Drive, Dati, Dispositivo, Penna, Input, Libreria, Nuove note, Cestino, Info.
import { h } from '../dom.js';
import { t, formatFull, formatBytes } from '../i18n.js';
import * as prefs from '../prefs.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { openPanel, confirmDialog } from '../ui/panel.js';
import { drive } from '../local/drive.js';
import { driveSync } from '../local/drivesync.js';
import * as disk from '../local/disk.js';
import { exportArchive, importArchive } from '../local/backup.js';
import { saveFile } from '../export/pdfexport.js';
import { toast, toastError } from '../ui/toast.js';
import { deviceNameField } from './firstrun.js';
import { formatEditor } from './format.js';
import { APP_VERSION } from '../version.js';
import { tools } from '../editor/tools.js';
import { calibration, resetCalibration } from '../editor/pressure.js';
import { PEN_TYPES } from '../page/ink.js';
import { openPenTest } from './pentest.js';

const group = (title, ...children) => h('section.settings-group', {}, h('h3', {}, title), ...children);
const row = (label, control) => h('label.field', {}, h('span.field-label', {}, label), control);

function select(options, value, onChange) {
  return h('select.field-input', { onchange: (e) => onChange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

export function openSettings({ onSyncNow }) {
  const lastSync = h('span.value', {});
  const driveBox = h('div');
  let deviceName = prefs.get('deviceName');

  // ---- Google Drive
  function renderDrive() {
    lastSync.textContent = driveSync.lastSync ? formatFull(driveSync.lastSync) : t('settings.never');
    const children = [h('p.hint', {}, t('settings.driveIntro'))];
    if (!drive.configured) {
      const field = h('input.field-input.mono', { type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: false,
        placeholder: '1234567890-abc….apps.googleusercontent.com', value: prefs.get('driveClientId') || '',
        onchange: (e) => { prefs.set('driveClientId', e.target.value.trim()); renderDrive(); } });
      children.push(h('p.form-msg', {}, t('settings.driveNotConfigured')),
        row(t('settings.driveClientId'), field), h('p.hint', {}, t('settings.driveClientIdHint')));
    }
    if (drive.configured && !drive.connected) {
      children.push(h('div.btn-row', {}, h('button.btn.primary', { type: 'button', onclick: connect }, t('settings.driveConnect'))));
    }
    if (drive.connected) {
      const acc = drive.account;
      children.push(
        h('div.field.inline', {}, h('span.field-label', {}, t('settings.driveAccount')), h('span.value', {}, acc ? `${acc.name}${acc.email && acc.email !== acc.name ? ` (${acc.email})` : ''}` : '—')),
        h('div.field.inline', {}, h('span.field-label', {}, t('settings.driveStatus')), h('span.value', {}, statusText())),
        h('div.field.inline', {}, h('span.field-label', {}, t('settings.lastSync')), lastSync),
        h('div.btn-row', {},
          h('button.btn', { type: 'button', onclick: async () => { await onSyncNow(); renderDrive(); } }, drive.token ? t('settings.syncNow') : t('settings.driveReconnect')),
          h('button.btn', { type: 'button', onclick: disconnect }, t('settings.driveDisconnect'))));
    }
    driveBox.replaceChildren(...children);
  }

  function statusText() {
    const ds = driveSync;
    if (ds.state === 'auth') return t('sync.auth');
    if (ds.state === 'offline') return ds.pending ? t('sync.offline', { n: ds.pending }) : t('sync.offlineNone');
    if (ds.state === 'error') return t('sync.error', { msg: ds.message });
    if (ds.progress) return t(ds.progress.what === 'up' ? 'sync.up' : 'sync.down', ds.progress);
    if (ds.state === 'syncing') return t('sync.syncing');
    if (ds.pending) return t('sync.pending', { n: ds.pending });
    return t('sync.ok');
  }

  async function connect() {
    try {
      await drive.signIn({ consent: true });
      toast(t('settings.driveConnected'));
      driveSync.syncNow().then(() => store.load()).catch(() => {});
    } catch (e) { toastError(e); }
    renderDrive();
  }

  async function disconnect() {
    if (!await confirmDialog({ title: t('settings.driveDisconnectTitle'), body: t('settings.driveDisconnectBody'), confirmLabel: t('settings.driveDisconnect') })) return;
    drive.signOut();
    renderDrive();
  }

  const onDriveChange = () => { if (driveBox.isConnected) renderDrive(); };
  driveSync.addEventListener('change', onDriveChange);
  drive.addEventListener('change', onDriveChange);
  renderDrive();

  // ---- data on this device
  const usage = h('p.hint', {});
  Promise.all([disk.usage(), navigator.storage?.persisted?.().catch(() => false)]).then(([u, persisted]) => {
    const parts = [];
    if (u?.usage != null) parts.push(t('settings.storageUsed', { used: formatBytes(u.usage), quota: formatBytes(u.quota || 0) }));
    parts.push(persisted ? t('settings.persistent') : t('settings.notPersistent'));
    usage.textContent = parts.join(' ');
  });
  const dataMsg = h('p.form-msg');
  async function doExport(e) {
    const btn = e.currentTarget;
    btn.disabled = true;
    dataMsg.className = 'form-msg';
    try {
      const { blob, notes } = await exportArchive((n) => { dataMsg.textContent = t('settings.exporting', { n }); });
      saveFile(blob, `Quadernone ${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip');
      dataMsg.textContent = t('settings.exported', { n: notes });
      dataMsg.className = 'form-msg ok';
    } catch (err) { dataMsg.textContent = err.message || String(err); }
    btn.disabled = false;
  }
  const picker = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    dataMsg.className = 'form-msg';
    try {
      const res = await importArchive(file, { onProgress: (done, total) => { dataMsg.textContent = t('settings.importing', { done, total }); } });
      if (!res.imported && !res.skipped && !res.failed.length) { dataMsg.textContent = t('settings.importBad'); return; }
      dataMsg.textContent = t('settings.imported', { n: res.imported, skipped: res.skipped }) + (res.failed.length ? ' ' + res.failed.map((f) => `${f.path}: ${f.reason}`).join('; ') : '');
      dataMsg.className = res.failed.length ? 'form-msg' : 'form-msg ok';
      await store.load().catch(() => {});
    } catch (err) { dataMsg.textContent = t('settings.importBad') + ' ' + (err.message || ''); }
  } });

  const retention = h('input.field-input', { type: 'number', min: 1, max: 3650, step: 1, inputMode: 'numeric', value: String(store.serverSettings.trashRetentionDays),
    onchange: async (e) => {
      const n = Math.round(Number(e.target.value));
      try {
        const s = await api.saveSettings({ trashRetentionDays: n });
        store.serverSettings = s;
        toast(t('settings.saved'));
      } catch (err) { toastError(err); e.target.value = String(store.serverSettings.trashRetentionDays); }
    } });

  // Penna: side button, hold threshold, pressure, the pen used when a note opens.
  const holdOut = h('span.value', {}, t('settings.ms', { n: tools.s.holdMs }));
  const hold = h('input.range', { type: 'range', min: 150, max: 800, step: 10, value: tools.s.holdMs,
    oninput: (e) => { tools.set('holdMs', Number(e.target.value)); holdOut.textContent = t('settings.ms', { n: e.target.value }); } });
  const sensOut = h('span.value', {});
  const calInfo = h('p.hint', {});
  const renderSens = () => {
    const v = Number(tools.s.pressureSensitivity) || 0;
    sensOut.textContent = v > 0 ? `+${v}` : String(v);
    const c = calibration();
    calInfo.textContent = c.n ? t('settings.pressureCal', { v: c.ref.toLocaleString('it-IT'), n: c.n }) : t('settings.pressureCalNone');
  };
  const sens = h('input.range', { type: 'range', min: -2, max: 2, step: 0.5, value: tools.s.pressureSensitivity || 0,
    oninput: (e) => { tools.set('pressureSensitivity', Number(e.target.value)); renderSens(); } });
  renderSens();
  const penWidth = h('input.field-input', { type: 'number', min: 0.5, max: 20, step: 0.1, inputMode: 'decimal', value: String(tools.s.pen.widthPt),
    onchange: (e) => {
      const v = Math.min(20, Math.max(0.5, Math.round(Number(String(e.target.value).replace(',', '.')) * 10) / 10 || 1.6));
      e.target.value = String(v);
      tools.update('pen', { widthPt: v });
    } });
  const penColor = h('div.swatches', {});
  const renderPenColor = () => {
    penColor.replaceChildren(...tools.s.quickColors.map((c) => h('button.swatch.sm' + (c.toLowerCase() === tools.s.pen.color.toLowerCase() ? '.active' : ''), {
      type: 'button', style: { background: c }, 'aria-label': c, onclick: () => { tools.update('pen', { color: c }); renderPenColor(); },
    })));
  };
  renderPenColor();
  const fingerHint = h('p.hint', {});
  const renderFingerHint = () => { fingerHint.textContent = t(tools.s.fingerMode === 'both' ? 'settings.fingerBothHint' : 'settings.fingerPenHint'); };
  renderFingerHint();

  const body = [
    group(t('settings.drive'), driveBox),
    group(t('settings.data'),
      usage,
      h('div.btn-row', {}, h('button.btn', { type: 'button', onclick: doExport }, t('settings.exportAll'))),
      h('p.hint', {}, t('settings.exportAllHint')),
      h('div.btn-row', {}, h('button.btn', { type: 'button', onclick: () => picker.click() }, t('settings.importAll')), picker),
      h('p.hint', {}, t('settings.importAllHint')),
      dataMsg),
    group(t('settings.device'),
      deviceNameField(deviceName, (v) => { if (v) { deviceName = v; prefs.set('deviceName', v); } })),
    group(t('settings.pen'),
      h('label.switch-row', {},
        h('input', { type: 'checkbox', checked: tools.s.sideButton, onchange: (e) => tools.set('sideButton', e.target.checked) }),
        h('span', {}, t('settings.sideButton'))),
      h('p.hint', {}, t('settings.sideButtonHint')),
      h('div.btn-row', {}, h('button.btn', { type: 'button', onclick: () => openPenTest() }, t('pentest.open'))),
      h('div.field', {}, h('span.field-label', {}, t('settings.holdMs')), h('div.opt-slider', {}, hold, holdOut)),
      h('label.switch-row', {},
        h('input', { type: 'checkbox', checked: tools.s.pen.pressure, onchange: (e) => tools.update('pen', { pressure: e.target.checked }) }),
        h('span', {}, t('settings.pressure'))),
      h('div.field', {}, h('span.field-label', {}, t('settings.pressureSens')), h('div.opt-slider', {}, sens, sensOut)),
      h('p.hint', {}, t('settings.pressureSensHint')),
      calInfo,
      h('div.btn-row', {}, h('button.btn', { type: 'button', onclick: () => { resetCalibration(); renderSens(); toast(t('settings.pressureReset')); } }, t('settings.pressureRecal'))),
      h('label.switch-row', {},
        h('input', { type: 'checkbox', checked: tools.s.penShapes, onchange: (e) => tools.set('penShapes', e.target.checked) }),
        h('span', {}, t('settings.penShapes'))),
      h('p.hint', {}, t('settings.penShapesHint')),
      row(t('settings.defaultPen'), select(PEN_TYPES.map((k) => [k, t('tools.types.' + k)]), tools.s.pen.type, (v) => tools.update('pen', { type: v }))),
      row(t('settings.defaultWidth'), penWidth),
      h('div.field', {}, h('span.field-label', {}, t('settings.defaultColor')), penColor),
      h('p.hint', {}, t('settings.airCommand')),
      h('p.hint', {}, t('settings.windowsInk'))),
    group(t('settings.input'),
      row(t('settings.fingerMode'), select([['pen', t('tools.fingerPen')], ['both', t('tools.fingerBoth')]], tools.s.fingerMode, (v) => { tools.set('fingerMode', v); renderFingerHint(); })),
      fingerHint,
      h('p.hint', {}, t('settings.gestures'))),
    group(t('settings.library'),
      row(t('settings.defaultView'), select([['grid', t('library.grid')], ['list', t('library.list')]], prefs.get('libraryView'), (v) => { prefs.set('libraryView', v); store.dispatchEvent(new Event('change')); })),
      row(t('settings.defaultSort'), select([['modified', t('library.sortModified')], ['created', t('library.sortCreated')], ['name', t('library.sortName')]], prefs.get('librarySort'), (v) => { prefs.set('librarySort', v); store.dispatchEvent(new Event('change')); }))),
    group(t('settings.newNotes'),
      h('label.switch-row', {},
        h('input', { type: 'checkbox', checked: prefs.get('askOnCreate'), onchange: (e) => prefs.set('askOnCreate', e.target.checked) }),
        h('span', {}, t('settings.askOnCreate'))),
      formatEditor(prefs.get('pageDefaults'), (d) => prefs.set('pageDefaults', d))),
    group(t('settings.trash'), row(t('settings.retention'), retention)),
    group(t('settings.info'),
      h('p', {}, t('settings.version', { v: APP_VERSION })),
      h('div.btn-row', {}, h('button.btn', { type: 'button', onclick: () => checkForUpdate() }, t('settings.update')))),
  ];

  openPanel({ title: t('settings.title'), body, onClose: () => {
    driveSync.removeEventListener('change', onDriveChange);
    drive.removeEventListener('change', onDriveChange);
  } });
}

async function checkForUpdate() {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg) { location.reload(); return; }
  await reg.update();
  if (!reg.waiting && !reg.installing) location.reload();
}
