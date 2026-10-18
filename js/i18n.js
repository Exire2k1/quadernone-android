// t('library.newNote', { n: 3 }) -> string from i18n/it.js, with {placeholders} filled in.
import it from '../i18n/it.js';

const strings = it;

export function t(key, params = {}) {
  const v = key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), strings);
  if (typeof v !== 'string') return key;
  return v.replace(/\{(\w+)\}/g, (m, p) => (params[p] !== undefined ? String(params[p]) : m));
}

const dateFmt = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat('it-IT', { dateStyle: 'long', timeStyle: 'short' });

/** "oggi 14:02", "ieri 09:10" or "10 ott 2026". */
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return `${t('dates.today')} ${timeFmt.format(d)}`;
  if (diff === 1) return `${t('dates.yesterday')} ${timeFmt.format(d)}`;
  return dateFmt.format(d);
}

export const formatTime = (d) => timeFmt.format(d);
export const formatFull = (iso) => (iso ? fullFmt.format(new Date(iso)) : '—');

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}
