// Diagnostics for display problems on devices: what kind of device it is (screen, GPU,
// memory), canvases dropped by the browser, script errors, and drawing timings.
// Reports go to the server (tmp\diag.log), a few at a time. Never sends note content.
import * as prefs from './prefs.js';
import { APP_VERSION } from './version.js';

const queue = [];
let timer = 0;
let infoSent = false;

function gpu() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return r || null;
  } catch { return null; }
}

function info() {
  return {
    version: APP_VERSION, ua: navigator.userAgent, dpr: devicePixelRatio,
    screen: `${screen.width}x${screen.height}`, viewport: `${innerWidth}x${innerHeight}`,
    standalone: matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches,
    memoryGB: navigator.deviceMemory ?? null, cores: navigator.hardwareConcurrency ?? null, gpu: gpu(),
  };
}

/** Records an event; sent to the server within a few seconds. */
export function note(type, data = {}) {
  queue.push({ t: new Date().toISOString().slice(11, 23), type, ...data });
  if (queue.length > 200) queue.splice(0, queue.length - 200);
  clearTimeout(timer);
  timer = setTimeout(flush, 3000);
}

export async function flush() {
  clearTimeout(timer);
  if (!queue.length && infoSent) return;
  const events = queue.splice(0, 50);
  const body = { events };
  if (!infoSent) body.info = info();
  try {
    const res = await fetch(prefs.serverBase() + '/api/diag', {
      method: 'POST', keepalive: true, body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'X-Quadernone-Token': prefs.get('token'), 'X-Quadernone-Device': prefs.get('deviceName') },
    });
    if (res.ok) infoSent = true;
    else queue.unshift(...events);
  } catch {
    queue.unshift(...events);   // offline: next time
  }
  if (queue.length) timer = setTimeout(flush, 30000);
}

export function start() {
  addEventListener('error', (e) => note('error', { msg: String(e.message).slice(0, 300), at: `${e.filename?.split('/').pop()}:${e.lineno}` }));
  addEventListener('unhandledrejection', (e) => note('rejection', { msg: String(e.reason?.message || e.reason).slice(0, 300) }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  note('start');
}
