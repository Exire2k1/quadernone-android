// Shared helpers of the local server (the JavaScript port of the old PHP server in lib/).
// Everything here runs both in the app (WebView) and in Node (tests).

/** An error that becomes a JSON response {"error": {"code", "message", ...extra}} with an HTTP status. */
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Local time as ISO 8601 with offset, like PHP date('c'): 2026-10-14T14:05:09+02:00 */
export function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export const now = () => isoLocal();

/** date('Y-m-d H-i') */
export function stampMinute(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

/** date('YmdHis') */
export function stampCompact(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** date('Y-m-d His') */
export function stampSpaced(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function hex(bytes) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export const uuid = () => crypto.randomUUID();

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const LOOSE_ID_RE = /^[0-9a-f-]{36}$/;

export function assertId(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new ApiError(400, 'bad_id', 'Identificativo non valido.');
}

// ---- strings, counted in code points like PHP's mb_* functions

export const nfc = (s) => String(s).normalize('NFC');
export const cpLen = (s) => [...s].length;
export const cpSlice = (s, start, len) => {
  const a = [...s];
  return a.slice(start, len === undefined ? undefined : start + len).join('');
};

/** PHP trim()/rtrim()/ltrim() with an explicit character list. */
export function trimChars(s, chars, side = 'both') {
  let a = 0, b = s.length;
  if (side !== 'right') while (a < b && chars.includes(s[a])) a++;
  if (side !== 'left') while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** PHP is_array() on decoded JSON: objects and lists. */
export const isArr = (v) => v !== null && typeof v === 'object';
export const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---- JSON files

const enc = new TextEncoder();
const dec = new TextDecoder();
export const toBytes = (s) => enc.encode(s);
export const toText = (b) => dec.decode(b);

/** Pretty JSON + newline, as the PHP server wrote it (JSON_PRETTY_PRINT). */
export const prettyJson = (v) => JSON.stringify(v, null, 4) + '\n';

/** Short stable hash (FNV-1a, 40 bits as 10 hex chars), used where PHP used md5 for a version tag. */
export function shortHash(s) {
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 10);
}
