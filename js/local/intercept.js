// Answers fetch() calls to the local server's address (prefs.serverBase()) inside the app,
// so modules written for the home server (covers, previews, slides) keep working unchanged.
// Every other request goes to the network as usual.
import { handle } from './server.js';
import * as prefs from '../prefs.js';

export const LOCAL_BASE = 'https://quadernone.local';

const realFetch = globalThis.fetch.bind(globalThis);

async function bodyOf(init, contentType) {
  const b = init?.body;
  if (b == null) return undefined;
  if (typeof FormData !== 'undefined' && b instanceof FormData) return { blob: b.get('file'), name: b.get('name') || b.get('file')?.name };
  if (typeof b === 'string') return /json/i.test(contentType) ? JSON.parse(b) : b;
  if (b instanceof Blob) return b;
  if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new Blob([b], { type: contentType || '' });
  return b;
}

function json(status, data) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

async function localFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  const path = url.pathname.replace(/^\/api/, '') + url.search;
  try {
    const res = await handle((init.method || 'GET').toUpperCase(), path, await bodyOf(init, headers.get('Content-Type') || ''),
      { device: headers.get('X-Quadernone-Device') || prefs.get('deviceName') || 'Questo dispositivo' });
    if (res?.__blob) return new Response(res.__blob, { status: 200, headers: { 'Content-Type': res.__blob.type || 'application/octet-stream' } });
    return json(200, res ?? {});
  } catch (e) {
    return json(e?.status || 500, { error: { code: e?.code || 'local_error', message: e?.message || String(e), ...(e?.extra || {}) } });
  }
}

export function install() {
  if (globalThis.fetch.__quadernone) return;
  const wrapped = (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (href && href.startsWith(LOCAL_BASE + '/')) {
      const req = typeof input === 'object' && !(input instanceof URL) ? input : null;
      return localFetch(new URL(href), init || (req ? { method: req.method, headers: req.headers, body: req.body } : {}));
    }
    return realFetch(input, init);
  };
  wrapped.__quadernone = true;
  globalThis.fetch = wrapped;
}
