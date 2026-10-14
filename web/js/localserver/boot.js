// Starts the local server on the right storage and routes /api calls to it.
import { createLocalServer } from './server.js';
import { installShim } from './shim.js';
import { opfsAdapter } from './adapters/opfs.js';

let server = null;

/** Storage: the Android notes folder when available (stage 2), otherwise the browser's private storage. */
async function pickAdapter() {
  const native = globalThis.Capacitor?.isNativePlatform?.() && globalThis.QuadernoneStorage;
  if (native) return globalThis.QuadernoneStorage.adapter();
  try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
  return opfsAdapter();
}

export async function startLocalServer({ deviceName } = {}) {
  if (server) return server;
  const adapter = await pickAdapter();
  server = createLocalServer({ adapter, onLog: (line) => { if (line.includes('[ERROR]')) console.warn(line); } });
  installShim(server, { deviceName });
  // Back in the foreground: another app (file manager, copy from a PC) may have changed the folder.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') server.markStale(); });
  return server;
}

export const localServer = () => server;
