// End-to-end check of the app in Chromium with the local server (no PHP, no network):
// first start, new note, handwriting with a pen, save, reload, note and ink still there,
// image attachment, search, trash. Screenshots in the folder given as argument.
//   node tools/serve.mjs 8090 & node tools/ui-smoke.mjs http://127.0.0.1:8090 /tmp/shots
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [base = 'http://127.0.0.1:8090', shots = '/tmp/qn-shots'] = process.argv.slice(2);
mkdirSync(shots, { recursive: true });
// UTF-8 locale: without it Chromium on Linux mangles non-ASCII file names in its private storage.
const browser = await chromium.launch({ env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('request', (r) => { if (r.url().includes('/api/')) errors.push('network request to ' + r.url()); });

let ok = 0, ko = 0;
const check = (label, cond, extra = '') => {
  if (cond) { ok++; console.log('✓ ' + label); } else { ko++; console.log('✗ ' + label + (extra ? ' — ' + extra : '')); }
};
const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch('/api' + p, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [method, path, body]);

await page.goto(base + '/');
await page.waitForSelector('.lib-main', { timeout: 15000 });
check('library opens without first-run (no server, no token)', !(await page.$('.first-run')));
await page.screenshot({ path: `${shots}/1-library-empty.png` });

// New note through the UI.
await page.click('button.fab');
await page.waitForTimeout(400);
const create = await page.$('text=Crea nota');
if (create) await create.click();
await page.waitForSelector('.editor', { timeout: 15000 });
await page.waitForTimeout(1200);
check('editor opens on the new note', /\/nota\/[0-9a-f-]{36}/.test(page.url()));
const noteId = page.url().match(/nota\/([0-9a-f-]{36})/)[1];

// Draw a stroke with a pen pointer in the middle of the page.
const box = await page.locator('.editor-stage').boundingBox();
const cdp = await context.newCDPSession(page);
const x0 = box.x + box.width / 2 - 100, y0 = box.y + 250;
const pen = (type, x, y, pressure) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force: pressure });
await pen('mousePressed', x0, y0, 0.5);
for (let i = 1; i <= 30; i++) await pen('mouseMoved', x0 + i * 7, y0 + Math.sin(i / 4) * 30, 0.5);
await pen('mouseReleased', x0 + 210, y0, 0);
await page.waitForTimeout(3500);   // autosave: 0.5 s local, 1.5 s to the local server
await page.screenshot({ path: `${shots}/2-editor-stroke.png` });

const n = await api('GET', `/notes/${noteId}?ink=1`);
const strokes = Object.values(n.json?.ink || {}).reduce((s, p) => s + p.strokes.length, 0);
check('stroke saved into the note folder (ink/<page>.json)', strokes === 1, `strokes=${strokes}`);

// Title rename through the editor title field.
const title = await page.$('.editor input');
if (title) {
  await title.fill('Prova APK');
  await title.press('Enter');
  await page.waitForTimeout(2500);
}
const n2 = await api('GET', `/notes/${noteId}`);
check('rename saved (folder renamed on disk)', n2.json?.path === 'Prova APK', `path=${n2.json?.path}`);

// Back to the library, reload the whole app: everything must still be there (stored in files).
await page.goBack();
await page.waitForTimeout(1500);
await page.reload();
await page.waitForSelector('.lib-main', { timeout: 15000 });
await page.waitForTimeout(800);
const tree = await api('GET', '/tree');
check('after reload the note is still in the library', tree.json?.notes?.some((x) => x.id === noteId && x.title === 'Prova APK'));
check('cover generated after closing the note', tree.json?.notes?.find((x) => x.id === noteId)?.hasCoverImage === true);
await page.screenshot({ path: `${shots}/3-library-after-reload.png` });

// Folder, move, search, trash, restore through the API the app uses.
const f = await api('POST', '/folders', { name: 'Università' });
check('folder created', f.status === 201, JSON.stringify(f));
const mv = await api('PATCH', `/notes/${noteId}/move`, { folderId: f.json.folder.id });
check('note moved into the folder', mv.json?.note?.folderId === f.json.folder.id);
const s = await api('GET', '/search?q=prova');
check('search finds the note', s.json?.total === 1);
const del = await api('DELETE', `/notes/${noteId}`);
const tr = await api('GET', '/trash');
check('note in the trash', del.status === 200 && tr.json?.items?.length === 1);
const rs = await api('POST', `/trash/${tr.json.items[0].trashId}/restore`);
check('note restored', rs.status === 200);

// Image attachment through the same upload the editor uses.
const up = await page.evaluate(async (id) => {
  const c = document.createElement('canvas'); c.width = 40; c.height = 30;
  c.getContext('2d').fillRect(0, 0, 20, 20);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const { upload } = await import('/js/local/files.js');
  return upload(id, blob, 'disegno.png');
}, noteId);
check('attachment stored', up === 'disegno.png', up);

// The app reopens the note from disk with its ink.
await page.goto(`${base}/nota/${noteId}`);
await page.waitForSelector('.editor', { timeout: 15000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${shots}/4-reopened.png` });
const files = await page.evaluate(async () => {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('quadernone-data');
  const out = [];
  async function walk(d, pre) {
    for await (const [name, h] of d.entries()) {
      out.push(pre + name + (h.kind === 'directory' ? '/' : ''));
      if (h.kind === 'directory') await walk(h, pre + name + '/');
    }
  }
  await walk(root, '');
  return out.sort();
});
console.log('  files:\n    ' + files.join('\n    '));
check('note folder has meta.json, pages.json, note.md, ink, cover', ['meta.json', 'pages.json', 'note.md', 'cover.png'].every((x) => files.some((p) => p.endsWith('Prova APK/' + x))) && files.some((p) => /Prova APK\/ink\/pg-[0-9a-f]{8}\.json$/.test(p)));

const realErrors = errors.filter((e) => !/favicon/.test(e));
check('no script errors and no network /api requests', realErrors.length === 0, realErrors.join(' | '));
console.log(`\n${ok}/${ok + ko} ok`);
await browser.close();
process.exit(ko ? 1 : 0);
