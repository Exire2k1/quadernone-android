// The local server: same routes and answers as the old PHP /api (lib/Api/Api.php), but
// running inside the app on the notes folder of the device. Requests are handled one at a
// time (a single queue replaces the server's file locks).
import { ApiError, assertId } from './util.js';
import { Fs } from './fs.js';
import { Index } from './index.js';
import { Feed } from './feed.js';
import * as Folders from './folders.js';
import * as Notes from './notes.js';
import * as Ink from './ink.js';
import * as Trash from './trash.js';
import * as Attachments from './attachments.js';
import * as Derived from './derived.js';
import * as Search from './search.js';
import * as Config from './config.js';

export const VERSION = '1.0.0';

/**
 * opts.adapter: storage adapter (see fs.js).
 * opts.alwaysScan: rescan the folder on every tree/search request (tests, like the PHP
 *   server); otherwise only at start and after markStale() (app back in the foreground).
 * opts.verifyLookups: re-read meta.json to confirm cached paths (default true).
 */
export function createLocalServer({ adapter, alwaysScan = false, verifyLookups = true, onLog = null } = {}) {
  const logLines = [];
  const ctx = {
    fs: new Fs(adapter),
    feed: new Feed(),
    verifyLookups,
    log(level, msg, data) {
      const line = `${new Date().toISOString()} [${level}] ${msg}${data ? ' ' + safeJson(data) : ''}`;
      logLines.push(line);
      if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
      onLog?.(line);
    },
  };
  ctx.index = new Index(ctx);
  let stale = true;
  let ready = false;
  let queue = Promise.resolve();

  async function freshTree() {
    if (!alwaysScan && !stale) return false;
    const changed = await ctx.index.scan();
    stale = false;
    return changed;
  }

  const routes = [];
  const add = (method, pattern, handler) => {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    routes.push({ method, re, names, handler });
  };

  // ---- tree
  add('GET', '/health', async () => ({ ok: true, app: 'Quadernone', version: VERSION, local: true }));
  add('GET', '/tree', async () => {
    await Trash.purge(ctx);
    if (await freshTree()) ctx.feed.append({ type: 'rescan', kind: 'tree', id: null }, 'Server');
    const c = await ctx.index.load();
    return {
      seq: ctx.feed.currentSeq(),
      folders: Object.entries(c.folders).map(([id, f]) => Folders.toPublic(id, f)),
      notes: Object.entries(c.notes).map(([id, n]) => Notes.summary(id, n)),
      trashCount: (await Trash.list(ctx)).length,
      settings: await Config.settings(ctx),
    };
  });

  // ---- folders
  add('POST', '/folders', async (r) => {
    const b = r.json();
    const [folder, warnings] = await Folders.create(ctx, optId(b.parentId), str(b, 'name'), b.color ?? null, r.device);
    return [201, { folder, warnings, seq: ctx.feed.currentSeq() }];
  });
  add('PATCH', '/folders/{id}', async (r, p) => {
    const [folder, warnings] = await Folders.update(ctx, p.id, r.json(), r.device);
    return { folder, warnings, seq: ctx.feed.currentSeq() };
  });
  add('GET', '/folders/{id}/count', async (r, p) => {
    assertId(p.id);
    return { notes: await Folders.countNotes(ctx, p.id) };
  });
  add('DELETE', '/folders/{id}', async (r, p) => ({ ...(await Folders.remove(ctx, p.id, r.device)), seq: ctx.feed.currentSeq() }));

  // ---- notes
  add('POST', '/notes', async (r) => {
    const b = r.json();
    const [note, warnings] = await Notes.create(ctx, optId(b.folderId), b.title ?? '', b.pageDefaults ?? null,
      r.device, optId(b.id), b.created ?? null, b.modified ?? null);
    return [201, { note, warnings, seq: ctx.feed.currentSeq() }];
  });
  add('GET', '/notes/{id}', async (r, p) => {
    assertId(p.id);
    return Notes.get(ctx, p.id, r.query.get('ink') === '1');
  });
  add('PUT', '/notes/{id}', async (r, p) => ({ ...(await Notes.save(ctx, p.id, r.json(), r.device)), seq: ctx.feed.currentSeq() }));
  add('PUT', '/notes/{id}/previews/{pageId}', async (r, p) => {
    await Derived.savePreview(ctx, p.id, p.pageId, r.raw(8 * 1024 * 1024));
    return { ok: true };
  });
  add('PUT', '/notes/{id}/cover', async (r, p) => {
    await Derived.saveCover(ctx, p.id, r.raw(4 * 1024 * 1024));
    return { ok: true, note: Notes.summary(p.id, await ctx.index.noteEntry(p.id)) };
  });
  add('GET', '/notes/{id}/cover', async (r, p) => ({ bytes: await Derived.readCover(ctx, p.id), type: 'image/png' }));
  add('PUT', '/notes/{id}/pdftext/{file}', async (r, p) => Derived.savePdfText(ctx, p.id, p.file, r.json()));
  add('POST', '/notes/{id}/attachments', async (r, p) => {
    const f = r.form();
    return [201, await Attachments.saveUpload(ctx, p.id, f.file, f.name)];
  });
  add('GET', '/notes/{id}/attachments', async (r, p) => {
    assertId(p.id);
    return { items: await Attachments.list(ctx, p.id) };
  });
  add('GET', '/notes/{id}/attachments/{name}', async (r, p) => Attachments.read(ctx, p.id, p.name));
  add('POST', '/convert/pptx', async () => {
    throw new ApiError(501, 'not_available',
      'Le presentazioni .pptx non si possono convertire sul dispositivo: esportale in PDF da PowerPoint e importa il PDF.');
  });
  add('GET', '/search', async (r) => {
    await freshTree();
    return Search.run(ctx, Object.fromEntries(r.query));
  });
  add('GET', '/notes/{id}/ink/{pageId}', async (r, p) => Ink.get(ctx, p.id, p.pageId));
  add('PUT', '/notes/{id}/ink/{pageId}', async (r, p) => ({ ...(await Ink.save(ctx, p.id, p.pageId, r.json(), r.device)), seq: ctx.feed.currentSeq() }));
  add('POST', '/diag', async (r) => {
    const b = r.json();
    const events = Array.isArray(b.events) ? b.events.slice(0, 50) : [];
    if (b.info) ctx.log('DIAG', 'info', b.info);
    for (const e of events) ctx.log('DIAG', String(e?.type ?? 'event'), e);
    return { ok: true, stored: events.length };
  });
  add('PATCH', '/notes/{id}/move', async (r, p) => {
    const b = r.json();
    if (!Object.hasOwn(b, 'folderId')) throw new ApiError(400, 'bad_request', 'Manca la cartella di destinazione.');
    const [note, warnings] = await Notes.move(ctx, p.id, b.folderId, r.device);
    return { note, warnings, seq: ctx.feed.currentSeq() };
  });
  add('DELETE', '/notes/{id}', async (r, p) => {
    await Trash.trashNote(ctx, p.id, r.device);
    return { ok: true, seq: ctx.feed.currentSeq() };
  });

  // ---- trash
  add('GET', '/trash', async () => {
    await Trash.purge(ctx);
    return { items: await Trash.list(ctx), retentionDays: (await Config.settings(ctx)).trashRetentionDays };
  });
  add('POST', '/trash/{id}/restore', async (r, p) => ({ note: await Trash.restore(ctx, p.id, r.device), seq: ctx.feed.currentSeq() }));
  add('DELETE', '/trash/{id}', async (r, p) => {
    await Trash.deleteForever(ctx, p.id, r.device);
    return { ok: true };
  });
  add('DELETE', '/trash', async (r) => ({ deleted: await Trash.emptyAll(ctx, r.device) }));

  // ---- changes, settings
  add('GET', '/changes', async (r) => {
    const since = r.query.get('since');
    if (typeof since !== 'string' || !/^\d{1,12}$/.test(since)) throw new ApiError(400, 'bad_since', 'Parametro since non valido.');
    return ctx.feed.since(Number(since));
  });
  add('GET', '/settings', async () => Config.settings(ctx));
  add('PUT', '/settings', async (r) => Config.saveSettings(ctx, r.json()));

  function match(method, path) {
    path = '/' + path.replace(/^\/+|\/+$/g, '');
    let allowed = false;
    for (const rt of routes) {
      const m = path.match(rt.re);
      if (!m) continue;
      if (rt.method !== method) { allowed = true; continue; }
      const params = {};
      rt.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return [rt.handler, params];
    }
    if (allowed) throw new ApiError(405, 'method_not_allowed', 'Metodo non consentito per questo indirizzo.');
    throw new ApiError(404, 'not_found', 'Indirizzo API sconosciuto.');
  }

  /**
   * Handles one request.
   * req: { method, path: "/notes/x?ink=1" (without /api), device, body: string | Uint8Array | null, form: { file, name } | null }
   * Returns { status, json } or { status, bytes, type }.
   */
  async function handleNow(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.path, 'http://local');
    const r = {
      query: url.searchParams,
      device: cleanDevice(req.device),
      json() {
        const raw = req.body;
        if (raw === null || raw === undefined || raw === '' || (raw instanceof Uint8Array && raw.length === 0)) return {};
        let v;
        try { v = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch {
          throw new ApiError(400, 'bad_json', 'Il corpo della richiesta non è JSON valido.');
        }
        if (v === null || typeof v !== 'object' || (Array.isArray(v) && v.length)) {
          throw new ApiError(400, 'bad_json', 'Il corpo della richiesta deve essere un oggetto JSON.');
        }
        return Array.isArray(v) ? {} : v;
      },
      raw(max) {
        const b = typeof req.body === 'string' ? new TextEncoder().encode(req.body) : (req.body || new Uint8Array(0));
        if (b.length > max) throw new ApiError(413, 'too_large', 'File troppo grande.');
        return b;
      },
      form: () => req.form || {},
    };
    try {
      const [handler, params] = match(method, url.pathname);
      if (!ready && url.pathname !== '/health') {
        await ctx.index.ensureDirs();
        ready = true;
      }
      const out = await handler(r, params);
      if (Array.isArray(out)) return { status: out[0], json: out[1] };
      if (out && out.bytes instanceof Uint8Array) return { status: 200, bytes: out.bytes, type: out.type };
      return { status: 200, json: out };
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status >= 500) ctx.log('ERROR', `${e.code}: ${e.message}`, { path: url.pathname, method, cause: e.cause?.message });
        return { status: e.status, json: { error: { code: e.code, message: e.message, ...e.extra } } };
      }
      ctx.log('ERROR', 'unhandled: ' + (e?.message || e), { path: url.pathname, stack: String(e?.stack || '').slice(0, 800) });
      return { status: 500, json: { error: { code: 'server_error', message: 'Errore interno. Riprova; se succede ancora, condividi il registro da Impostazioni.' } } };
    }
  }

  function handle(req) {
    const p = queue.then(() => handleNow(req));
    queue = p.catch(() => {});
    return p;
  }

  return {
    handle,
    ctx,
    /** The app came back to the foreground: files may have been changed by another app. */
    markStale() { stale = true; },
    log: () => logLines.slice(),
  };
}

function optId(v) {
  if (v === null || v === undefined || v === '' || v === 'root') return null;
  if (typeof v !== 'string') throw new ApiError(400, 'bad_id', 'Identificativo non valido.');
  assertId(v);
  return v;
}

function str(b, key) {
  const v = b[key] ?? '';
  if (typeof v !== 'string') throw new ApiError(400, 'bad_request', `Il campo ${key} deve essere testo.`);
  return v;
}

function cleanDevice(d) {
  d = String(d ?? '').replace(/[\x00-\x1F\x7F]+/gu, '').trim();
  return d === '' ? 'Sconosciuto' : [...d].slice(0, 40).join('');
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}
