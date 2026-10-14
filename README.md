# Quadernone (Android)

App Android di note scritte a mano, **standalone**: niente server, niente account. Le note
sono file in chiaro nella cartella scelta sul dispositivo (di solito `Documenti/Quadernone`),
nello stesso formato della vecchia versione web servita dal server di casa.

## Com'è fatta

```
web/                    l'app (HTML/CSS/JS moduli ES, nessun build step)
  js/localserver/       il "server locale": la logica del vecchio server PHP portata in JS
    server.js           rotte /api (stesse risposte del PHP), coda unica al posto dei lock
    fs.js               accesso ai file tramite un adattatore
    adapters/opfs.js    adattatore per il browser (sviluppo e test)
    shim.js             intercetta fetch('/api/...') e lo passa al server locale
    boot.js             sceglie l'adattatore e avvia tutto
    index.js feed.js folders.js notes.js pages.js ink.js trash.js
    attachments.js derived.js search.js markdown.js names.js config.js util.js
tools/                  test e strumenti di sviluppo (non finiscono nell'APK)
```

L'interfaccia (editor, libreria, motore pagine, penna) è quella della versione web 0.5.5 e
continua a chiamare gli stessi indirizzi `/api/...`: invece della rete risponde
`js/localserver`, che legge e scrive i file della cartella delle note.

### Formato dei dati (invariato)

```
<cartella delle note>/
  _app/index.json, settings.json      cache e impostazioni (ricostruibili)
  _trash/<id-nota>/                    cestino (nota + trash.json)
  <Cartella>/.folder.json
  <Cartella>/<Titolo nota>/
      meta.json  pages.json  note.md  cover.png  pdftext.json
      ink/<pageId>.json  previews/<pageId>.svg  attachments/<file>
```

Si può copiare una cartella `data` del vecchio server dentro la cartella delle note: l'app
la riconosce alla prima scansione.

## Stato

- [x] **Tappa 1** — server PHP portato in JavaScript, app collegata, prova nel browser.
- [ ] Tappa 2 — progetto Android (Capacitor), cartella `Documenti/Quadernone`, build APK su GitHub Actions.
- [ ] Tappa 3 — adattamento a dispositivi diversi (modalità dito, telefono, log, licenze).
- [ ] Tappa 4 — rifinitura dopo le prove sul tablet; versione per gli amici.
- [ ] Dopo — Google Drive (facoltativo).

## Test

```sh
npm run test:diff   # stesse richieste al vecchio server PHP e al server JS: risposte e file devono coincidere
npm run test:ui     # l'app in Chromium (Playwright): nota, scrittura, salvataggio, ricarica, cestino...
```

`test:diff` richiede PHP 8 e il codice del vecchio server (`lib/` e `app/` di `D:\Quaderno`)
in `$QN_PHP` (vedi `tools/difftest.sh`).
