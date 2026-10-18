// Google Drive access: sign-in with Google Identity Services (token in the browser, no
// server) and the few Drive REST calls the sync needs. Scope drive.file: the app sees only
// the files it created itself, nothing else in the user's Drive.
//
// The OAuth client id is public by design (it identifies the app, it is not a secret): it is
// set in config.js when the app is published (see LEGGIMI.md), or in Impostazioni.
import * as prefs from '../prefs.js';
import { CONFIG } from '../../config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';

export class DriveError extends Error {
  constructor(kind, message, status = 0) {
    super(message);
    this.kind = kind;      // 'auth' | 'offline' | 'notfound' | 'quota' | 'rate' | 'error'
    this.status = status;
  }
}

let gisPromise = null;
function loadGis() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  gisPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gisPromise = null; reject(new DriveError('offline', 'Impossibile contattare Google: controlla la connessione.')); };
    document.head.append(s);
  });
  return gisPromise;
}

class Drive extends EventTarget {
  #tokenClient = null;
  #pending = null;   // { resolve, reject } of the running sign-in

  get clientId() { return (prefs.get('driveClientId') || CONFIG.googleClientId || '').trim(); }
  get configured() { return /\.apps\.googleusercontent\.com$/.test(this.clientId); }
  /** The user linked Drive on this device (the token may still need renewing). */
  get connected() { return !!prefs.get('driveLinked'); }
  get account() { return prefs.get('driveAccount') || null; }
  get token() {
    const tk = prefs.get('driveToken');
    return tk && tk.exp > Date.now() + 60000 ? tk.token : null;
  }
  get ready() { return this.connected && !!this.token; }

  #emit() { this.dispatchEvent(new Event('change')); }

  async #client() {
    await loadGis();
    if (!this.#tokenClient || this.#tokenClient.__id !== this.clientId) {
      this.#tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: SCOPE,
        callback: (r) => {
          const p = this.#pending; this.#pending = null;
          if (r.error || !r.access_token) { p?.reject(new DriveError('auth', r.error_description || 'Accesso a Google non riuscito.')); return; }
          prefs.set('driveToken', { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 });
          p?.resolve(r.access_token);
        },
        error_callback: (err) => {
          const p = this.#pending; this.#pending = null;
          const closed = err?.type === 'popup_closed';
          p?.reject(new DriveError('auth', closed ? 'Accesso annullato.' : err?.type === 'popup_failed_to_open'
            ? 'Il browser ha bloccato la finestra di Google: tocca di nuovo il pulsante.' : 'Accesso a Google non riuscito.'));
        },
      });
      this.#tokenClient.__id = this.clientId;
    }
    return this.#tokenClient;
  }

  /**
   * Gets a token. Must run inside a user gesture (a tap) the first time and whenever the
   * hour-long token has expired: Google opens a small window, already filled in after the first time.
   */
  async signIn({ consent = false } = {}) {
    if (!this.configured) throw new DriveError('auth', 'Manca l\'ID client di Google: vedi Impostazioni → Google Drive.');
    const client = await this.#client();
    const token = await new Promise((resolve, reject) => {
      this.#pending?.reject(new DriveError('auth', 'Accesso annullato.'));
      this.#pending = { resolve, reject };
      client.requestAccessToken({ prompt: consent || !this.connected ? 'consent' : '', login_hint: this.account?.email || undefined });
    });
    // Which account: a different one than before means a different Drive (start over).
    const about = await this.json(`${API}/about?fields=user(emailAddress,displayName)`, {}, token);
    const email = about.user?.emailAddress || '';
    if (this.account?.email && this.account.email !== email) this.dispatchEvent(new CustomEvent('accountchange', { detail: { from: this.account.email, to: email } }));
    prefs.update({ driveLinked: true, driveAccount: { email, name: about.user?.displayName || email } });
    this.#emit();
    return token;
  }

  signOut() {
    const tk = prefs.get('driveToken');
    try { if (tk?.token) globalThis.google?.accounts?.oauth2?.revoke?.(tk.token); } catch { /* best effort */ }
    prefs.update({ driveLinked: false, driveToken: null });
    this.#emit();
  }

  // ---------------------------------------------------------------- REST

  async fetch(url, opts = {}, token = this.token) {
    if (!token) throw new DriveError('auth', 'Accesso a Google Drive scaduto: tocca per ricollegarti.');
    let res;
    try {
      res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
    } catch {
      throw new DriveError('offline', 'Google Drive non raggiungibile.');
    }
    if (res.ok) return res;
    let reason = '';
    try { const j = await res.json(); reason = j.error?.errors?.[0]?.reason || j.error?.status || ''; } catch { /* not JSON */ }
    if (res.status === 401) { prefs.set('driveToken', null); this.#emit(); throw new DriveError('auth', 'Accesso a Google Drive scaduto: tocca per ricollegarti.', 401); }
    if (res.status === 404) throw new DriveError('notfound', 'File non trovato su Drive.', 404);
    if (res.status === 403 && /storageQuota|quotaExceeded/i.test(reason)) throw new DriveError('quota', 'Spazio su Google Drive esaurito.', 403);
    if (res.status === 429 || (res.status === 403 && /rate|limit/i.test(reason))) throw new DriveError('rate', 'Google Drive chiede di rallentare: riprovo tra poco.', res.status);
    throw new DriveError('error', `Errore di Google Drive (${res.status}${reason ? ' ' + reason : ''}).`, res.status);
  }

  async json(url, opts = {}, token) { return (await this.fetch(url, opts, token)).json(); }

  /** Every file matching q (all pages). */
  async list(q, fields = 'id,name,parents,appProperties,md5Checksum,size') {
    const out = [];
    let pageToken = '';
    do {
      const u = new URL(`${API}/files`);
      u.searchParams.set('q', q);
      u.searchParams.set('fields', `nextPageToken,files(${fields})`);
      u.searchParams.set('pageSize', '1000');
      u.searchParams.set('spaces', 'drive');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const r = await this.json(u.href);
      out.push(...(r.files || []));
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  get(id, fields = 'id,name,parents,appProperties,trashed') {
    return this.json(`${API}/files/${id}?fields=${encodeURIComponent(fields)}`);
  }

  createFolder(name, parentId, appProperties = {}) {
    return this.json(`${API}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: parentId ? [parentId] : undefined, appProperties }),
    });
  }

  /** Metadata change: name, appProperties, move (addParents/removeParents), trashed. */
  update(id, meta = {}, { addParents, removeParents } = {}) {
    const u = new URL(`${API}/files/${id}`);
    u.searchParams.set('fields', 'id,md5Checksum');
    if (addParents) u.searchParams.set('addParents', addParents);
    if (removeParents) u.searchParams.set('removeParents', removeParents);
    return this.json(u.href, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) });
  }

  trash(id) { return this.update(id, { trashed: true }); }

  async remove(id) { await this.fetch(`${API}/files/${id}`, { method: 'DELETE' }); }

  /** Creates (no id) or replaces (id) a file's content. Resolves to { id, md5Checksum }. */
  async upload({ id = null, name, parentId, blob, mimeType, appProperties }) {
    const type = mimeType || blob.type || 'application/octet-stream';
    if (blob.size > 4 * 1024 * 1024) return this.#resumable({ id, name, parentId, blob, type, appProperties });
    const meta = id ? {} : { name, parents: [parentId], appProperties };
    if (id && name) meta.name = name;
    const boundary = 'qn' + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${type}\r\n\r\n`, blob, `\r\n--${boundary}--`,
    ]);
    const url = id ? `${UPLOAD}/files/${id}?uploadType=multipart&fields=id,md5Checksum` : `${UPLOAD}/files?uploadType=multipart&fields=id,md5Checksum`;
    return this.json(url, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  }

  async #resumable({ id, name, parentId, blob, type, appProperties }) {
    const meta = id ? {} : { name, parents: [parentId], appProperties };
    const url = id ? `${UPLOAD}/files/${id}?uploadType=resumable&fields=id,md5Checksum` : `${UPLOAD}/files?uploadType=resumable&fields=id,md5Checksum`;
    const start = await this.fetch(url, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type }, body: JSON.stringify(meta) });
    const session = start.headers.get('Location');
    if (!session) throw new DriveError('error', 'Caricamento su Drive non avviato.');
    return this.json(session, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
  }

  async download(id) { return (await this.fetch(`${API}/files/${id}?alt=media`)).blob(); }

  /**
   * .pptx → PDF without a server: Drive converts the upload to Google Slides, exports it
   * as PDF, then the temporary copy is deleted.
   */
  async pptxToPdf(blob, name, parentId) {
    // The metadata mimeType asks Drive to convert; the media part keeps the .pptx type.
    const tmp = await this.#convertUpload(blob, name, parentId);
    try {
      const res = await this.fetch(`${API}/files/${tmp.id}/export?mimeType=application/pdf`);
      return await res.blob();
    } catch (e) {
      if (e.status === 403) throw new DriveError('error', 'Presentazione troppo grande per la conversione di Google (massimo 10 MB di PDF): salvala come PDF e inserisci il PDF.');
      throw e;
    } finally {
      this.remove(tmp.id).catch(() => {});
    }
  }

  async #convertUpload(blob, name, parentId) {
    const boundary = 'qn' + Math.random().toString(36).slice(2);
    const meta = { name: `~ conversione ${name}`, parents: [parentId], mimeType: 'application/vnd.google-apps.presentation', appProperties: { qk: 'tmp' } };
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation\r\n\r\n`, blob, `\r\n--${boundary}--`,
    ]);
    return this.json(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  }
}

export const drive = new Drive();
export const FOLDER_MIME = FOLDER;
