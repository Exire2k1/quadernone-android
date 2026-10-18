// Client for /api. In Quadernone Locale the "server" runs inside the app (local/server.js):
// requests are plain function calls, errors become ApiFailure with the same Italian
// messages as the home-server version. The few modules that build URLs themselves
// (covers, previews) go through the fetch interceptor in local/intercept.js.
import * as prefs from './prefs.js';
import { t } from './i18n.js';
import { handle } from './local/server.js';

export class ApiFailure extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;   // 0 = network error (never for the local server)
    this.code = code;
    this.extra = extra;
  }
}

const listeners = new Set();
/** fn('online' | 'offline' | 'unauthorized') after every request. */
export const onReachability = (fn) => listeners.add(fn);
const report = (state) => listeners.forEach((fn) => fn(state));

export const device = () => prefs.get('deviceName') || 'Questo dispositivo';

/** One API call. body: a plain object (JSON-like), or { blob, name } for attachments. */
export async function request(method, path, body) {
  try {
    const res = await handle(method, path, body, { device: device() });
    report('online');
    return res;
  } catch (e) {
    if (e instanceof ApiFailure) throw e;
    if (e?.status) throw new ApiFailure(e.status, e.code || 'error', e.message || t('errors.generic'), e.extra || {});
    // Storage errors (quota, browser bugs): never silent.
    console.error(e);
    const quota = e?.name === 'QuotaExceededError';
    throw new ApiFailure(500, quota ? 'quota' : 'local_error', quota ? t('errors.quota') : t('errors.local', { msg: e?.message || String(e) }));
  }
}

export const api = {
  health: () => request('GET', '/health'),
  tree: () => request('GET', '/tree'),
  changes: (since) => request('GET', `/changes?since=${since}`),
  createFolder: (parentId, name) => request('POST', '/folders', { parentId, name }),
  updateFolder: (id, patch) => request('PATCH', `/folders/${id}`, patch),
  folderCount: (id) => request('GET', `/folders/${id}/count`),
  deleteFolder: (id) => request('DELETE', `/folders/${id}`),
  createNote: (folderId, title, pageDefaults, id) => request('POST', '/notes', { folderId, title, pageDefaults, ...(id ? { id } : {}) }),
  getNote: (id) => request('GET', `/notes/${id}`),
  saveNote: (id, baseRevision, data) => request('PUT', `/notes/${id}`, { baseRevision, ...data }),
  moveNote: (id, folderId) => request('PATCH', `/notes/${id}/move`, { folderId }),
  deleteNote: (id) => request('DELETE', `/notes/${id}`),
  trash: () => request('GET', '/trash'),
  restore: (trashId) => request('POST', `/trash/${trashId}/restore`),
  deleteForever: (trashId) => request('DELETE', `/trash/${trashId}`),
  emptyTrash: () => request('DELETE', '/trash'),
  settings: () => request('GET', '/settings'),
  suggestions: () => request('GET', '/suggestions'),
  acceptSuggestion: (noteId) => request('POST', `/suggestions/${noteId}/accept`, {}),
  dismissSuggestion: (noteId) => request('POST', `/suggestions/${noteId}/dismiss`, {}),
  conflicts: () => request('GET', '/conflicts'),
  resolveConflict: (copyId, action) => request('POST', `/conflicts/${copyId}/resolve`, { action }),
  saveSettings: (s) => request('PUT', '/settings', s),
};
