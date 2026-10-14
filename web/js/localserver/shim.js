// Connects the app to the local server: every fetch() to /api/... on this origin is
// answered by the local server instead of the network. The rest of the app keeps calling
// the same /api addresses it used with the old PHP server.

/** Reads a fetch body into what the local server expects. */
async function readBody(body) {
  if (body === null || body === undefined) return { body: null, form: null };
  if (typeof body === 'string') return { body, form: null };
  if (body instanceof FormData) {
    const form = {};
    for (const [k, v] of body.entries()) {
      if (v instanceof Blob) form[k] = { name: v.name || 'file', bytes: new Uint8Array(await v.arrayBuffer()) };
      else form[k] = v;
    }
    return { body: null, form };
  }
  if (body instanceof Blob) return { body: new Uint8Array(await body.arrayBuffer()), form: null };
  if (body instanceof ArrayBuffer) return { body: new Uint8Array(body), form: null };
  if (ArrayBuffer.isView(body)) return { body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), form: null };
  return { body: String(body), form: null };
}

function headerOf(headers, name) {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const k = Object.keys(headers).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? headers[k] : null;
}

export function installShim(server, { deviceName = () => '' } = {}) {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return original(input, init);
    const method = (init.method || req?.method || 'GET').toUpperCase();
    const { body, form } = await readBody(init.body ?? (req && method !== 'GET' ? await req.blob() : null));
    const device = headerOf(init.headers || req?.headers, 'X-Quadernone-Device') || deviceName();
    const r = await server.handle({ method, path: url.pathname.slice(4) + url.search, device, body, form });
    if (r.json !== undefined) {
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    return new Response(r.bytes, { status: r.status, headers: { 'Content-Type': r.type || 'application/octet-stream' } });
  };
}
