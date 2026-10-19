// Start-up guard (plain script, runs before the app modules).
// If the app has not started after a few seconds (a module failed to load, an old copy in
// the cache, a browser problem), the screen shows what went wrong instead of staying black,
// with two ways out: reload, or repair the app files. Repair deletes only the cached copy of
// the app (service worker and its cache); notes and settings are never touched.
(function () {
  var errors = [];
  function remember(msg) { if (errors.length < 8) errors.push(String(msg).slice(0, 400)); }
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) { remember('File non caricato: ' + (t.src || t.href)); return; }
    remember((e.message || 'Errore') + (e.filename ? ' — ' + e.filename.split('/').slice(-2).join('/') + ':' + e.lineno : ''));
  }, true);
  window.addEventListener('unhandledrejection', function (e) { remember(e.reason && e.reason.message || e.reason); });

  function started() { return window.__qnBooted || document.querySelector('#screens > *, #overlays > *'); }

  async function repair() {
    try {
      var regs = await navigator.serviceWorker.getRegistrations();
      for (var i = 0; i < regs.length; i++) await regs[i].unregister();
      var keys = await caches.keys();
      for (var j = 0; j < keys.length; j++) if (keys[j].indexOf('qnl-') === 0) await caches.delete(keys[j]);
    } catch (e) { /* nothing more to do */ }
    location.reload();
  }

  function show() {
    if (started() || document.getElementById('qn-boot-error')) return;
    var box = document.createElement('div');
    box.id = 'qn-boot-error';
    box.setAttribute('style', 'position:fixed;inset:0;z-index:9999;overflow:auto;background:#0F1012;color:#E8E6E1;' +
      'font:15px/1.5 system-ui,sans-serif;padding:32px 20px;box-sizing:border-box');
    var details = errors.length ? errors.join('\n') : 'Nessun errore registrato: l\'app non ha finito di caricarsi.';
    box.innerHTML = '<div style="max-width:640px;margin:0 auto">' +
      '<h1 style="font-size:22px;margin:0 0 8px">Quadernone non è partito</h1>' +
      '<p style="color:#B8B5AD;margin:0 0 16px">Le tue note sono al sicuro su questo dispositivo. Prova prima «Ricarica»; se non basta, «Ripara l\'app» scarica di nuovo i file dell\'app (le note non vengono toccate).</p>' +
      '<p style="display:flex;gap:10px;flex-wrap:wrap;margin:0 0 20px">' +
      '<button id="qn-reload" style="font:inherit;padding:10px 18px;border-radius:10px;border:1px solid #3A3B40;background:#1B1C20;color:inherit">Ricarica</button>' +
      '<button id="qn-repair" style="font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#E9A23B;color:#1A1206;font-weight:600">Ripara l\'app</button></p>' +
      '<p style="color:#9A9890;margin:0 0 6px">Dettagli da mandare a chi ti aiuta:</p>' +
      '<pre id="qn-details" style="white-space:pre-wrap;word-break:break-word;background:#1B1C20;border-radius:10px;padding:12px;font-size:12px;color:#CFCBC2;margin:0"></pre></div>';
    document.body.appendChild(box);
    document.getElementById('qn-details').textContent = details + '\n\n' + navigator.userAgent + '\n' + location.href +
      '\nservice worker: ' + (navigator.serviceWorker && navigator.serviceWorker.controller ? 'attivo' : 'no');
    document.getElementById('qn-reload').onclick = function () { location.reload(); };
    document.getElementById('qn-repair').onclick = repair;
  }

  setTimeout(show, 8000);
  window.addEventListener('error', function () { setTimeout(show, 1500); });
})();
