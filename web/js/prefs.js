// Per-device preferences in localStorage. Every access is guarded: storage can be
// unavailable (private mode, cleared site data), and the app must still run.
const KEY = 'quadernone.prefs.v1';

const DEFAULTS = {
  deviceName: 'Questo dispositivo',
  serverUrl: '',
  token: '',
  syncIntervalSec: 30,
  libraryView: 'grid',          // grid | list
  librarySort: 'modified',      // modified | created | name
  askOnCreate: true,
  pageDefaults: {
    size: { preset: 'A4', widthMm: 210, heightMm: 297 },
    orientation: 'portrait',
    background: { type: 'lined', spacingMm: 8, lineColor: '#A9BCD6', paperColor: 'white' },
  },
  expandedFolders: [],
  lastView: { kind: 'all', id: null },
  feedSeq: null,
  lastSync: null,
};

let cache = null;

function load() {
  if (cache) return cache;
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { stored = {}; }
  cache = { ...structuredClone(DEFAULTS), ...stored };
  return cache;
}

export function get(key) { return load()[key]; }

export function set(key, value) {
  load()[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* keep in memory only */ }
  if (key === 'token' || key === 'deviceName') window.dispatchEvent(new Event('qn-auth-changed'));
}

export function update(patch) { for (const [k, v] of Object.entries(patch)) set(k, v); }

export const isConfigured = () => true;

export const serverBase = () => (get('serverUrl') || location.origin).replace(/\/+$/, '');
