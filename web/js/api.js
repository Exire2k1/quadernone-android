// Thin client for /api. Adds the token and device headers, turns errors into
// ApiFailure with an Italian message, and reports reachability to listeners.
import * as prefs from './prefs.js';
import { t } from './i18n.js';

export class ApiFailure extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;   // 0 = network error / server unreachable
    this.code = code;
    this.extra = extra;
  }
}

const listeners = new Set();
/** fn('online' | 'offline' | 'unauthorized') after every request. */
export const onReachability = (fn) => listeners.add(fn);
const report = (state) => listeners.forEach((fn) => fn(state));

export async function request(method, path, body, { token, base, timeoutMs = 20000 } = {}) {
  const headers = {
    'X-Quadernone-Token': token ?? prefs.get('token'),
    'X-Quadernone-Device': prefs.get('deviceName') || 'Sconosciuto',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch((base ?? prefs.serverBase()) + '/api' + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal, cache: 'no-store',
    });
  } catch {
    report('offline');
    throw new ApiFailure(0, 'offline', t('errors.offline'));
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON (e.g. proxy error page) */ }
  // The service worker answers with 503 + offline:true when it served nothing from the network.
  if (res.status === 503 && data?.offline) {
    report('offline');
    throw new ApiFailure(0, 'offline', t('errors.offline'));
  }
  if (res.status === 401) {
    report('unauthorized');
    throw new ApiFailure(401, data?.error?.code || 'unauthorized', t('errors.unauthorized'));
  }
  // A copy the service worker served from its cache because the server was unreachable.
  report(res.headers.get('X-Quadernone-Offline') === '1' ? 'offline' : 'online');
  if (!res.ok) {
    const e = data?.error || {};
    const msg = e.message || (res.status === 404 ? t('errors.notFound') : t('errors.generic'));
    throw new ApiFailure(res.status, e.code || 'error', msg, e);
  }
  return data;
}

export const api = {
  health: (base) => request('GET', '/health', undefined, { base }),
  tree: () => request('GET', '/tree', undefined, { timeoutMs: 10000 }),
  changes: (since) => request('GET', `/changes?since=${since}`),
  createFolder: (parentId, name) => request('POST', '/folders', { parentId, name }),
  updateFolder: (id, patch) => request('PATCH', `/folders/${id}`, patch),
  folderCount: (id) => request('GET', `/folders/${id}/count`),
  deleteFolder: (id) => request('DELETE', `/folders/${id}`),
  createNote: (folderId, title, pageDefaults, id) => request('POST', '/notes', { folderId, title, pageDefaults, ...(id ? { id } : {}) }),
  getNote: (id, opts) => request('GET', `/notes/${id}`, undefined, opts),
  saveNote: (id, baseRevision, data) => request('PUT', `/notes/${id}`, { baseRevision, ...data }),
  moveNote: (id, folderId) => request('PATCH', `/notes/${id}/move`, { folderId }),
  deleteNote: (id) => request('DELETE', `/notes/${id}`),
  trash: () => request('GET', '/trash'),
  restore: (trashId) => request('POST', `/trash/${trashId}/restore`),
  deleteForever: (trashId) => request('DELETE', `/trash/${trashId}`),
  emptyTrash: () => request('DELETE', '/trash'),
  settings: () => request('GET', '/settings'),
  saveSettings: (s) => request('PUT', '/settings', s),
};
