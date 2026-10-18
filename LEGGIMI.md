# Quadernone Locale

Versione dell'app senza server di casa. Le note sono salvate sul dispositivo, nell'archivio del browser, e funzionano anche senza internet. Google Drive è facoltativo e serve a sincronizzare più dispositivi. Non servono VPN né token.

- Le note hanno lo stesso formato di file della versione server: `meta.json`, `pages.json`, `note.md`, `ink/<pagina>.json`, `previews/*.svg`, `cover.png`, `attachments/…`.
- **Con Drive collegato**, nel tuo Drive compare la cartella `Quadernone`, con dentro le tue cartelle e una cartella per ogni nota, in file leggibili anche senza l'app. L'app usa il permesso `drive.file`: vede solo i file che ha creato lei, non il resto del Drive.
- **Conflitti:** se una nota viene modificata su due dispositivi prima della sincronizzazione, non si perde niente. La versione di un dispositivo diventa una "copia di conflitto", che risolvi dalla Libreria (Tieni l'originale / la copia / Unisci / Tienile entrambe).
- **Backup senza Drive:** Impostazioni › Dati su questo dispositivo › Esporta tutto (.zip).

---

## 1. Pubblicazione su GitHub Pages (una volta sola)

L'app sta nel branch **`pwa`** del repository `Exire2k1/quadernone-android`. Il branch `main` con il progetto APK non è stato toccato.

1. GitHub Pages gratuito funziona solo con repository **pubblici**: **Settings › General › Danger Zone › Change visibility › Make public**. Il codice è pubblico, le note no: restano sui dispositivi e nel Drive di ciascuno. In alternativa serve GitHub Pro.
2. **Settings › Pages › Build and deployment**: Source = *Deploy from a branch*, Branch = **`pwa`**, cartella **`/ (root)`** › **Save**.
3. Dopo 1–2 minuti l'app è su **`https://exire2k1.github.io/quadernone-android/`**. Lo stesso indirizzo compare in alto in Settings › Pages.

## 2. ID client di Google per Drive (una volta sola, circa 5–10 minuti)

Serve solo se vuoi la sincronizzazione con Drive. L'ID client **non è un segreto**: identifica l'app presso Google e non dà accesso a niente.

1. Apri <https://console.cloud.google.com/> › in alto, selettore progetti › **Nuovo progetto**, nome `Quadernone` › Crea.
2. **API e servizi › Libreria** › cerca **Google Drive API** › **Abilita**.
3. **Google Auth Platform** (oppure "Schermata consenso OAuth") › **Inizia**:
   - Nome app: `Quadernone`; email di assistenza: la tua;
   - Pubblico: **Esterno**;
   - Dati di contatto: la tua email › Crea.
4. **Accesso ai dati › Aggiungi o rimuovi ambiti** › cerca `drive.file` (`.../auth/drive.file`) › Aggiorna › Salva.
5. **Pubblico › Pubblica app** (stato "In produzione"). `drive.file` è un ambito non sensibile, quindi non serve la verifica di Google e anche i tuoi amici possono accedere. Se invece la lasci "In test", aggiungi a mano gli account in **Utenti di test**, al massimo 100.
6. **Client › Crea client** › Tipo: **Applicazione web** › Nome: `Quadernone web`:
   - **Origini JavaScript autorizzate** › Aggiungi URI: `https://exire2k1.github.io`, senza `/quadernone` e senza `/` finale;
   - **URI di reindirizzamento**: lascia vuoto;
   - Crea, poi copia l'**ID client**, che finisce con `.apps.googleusercontent.com`.
7. Inserisci l'ID nell'app. Il modo migliore è su GitHub: nel branch `pwa` apri `config.js` › matita (Modifica) › incollalo tra gli apici di `googleClientId: ''` › Commit. In questo modo vale per tutti i dispositivi e per gli amici. In alternativa puoi incollarlo in Impostazioni › Google Drive su ogni dispositivo.

## 3. Installazione sui dispositivi

- **Tablet Samsung e telefono:** apri l'indirizzo in **Chrome** › menu ⋮ › **Installa app** (o "Aggiungi a schermata Home" › Installa).
- **Lenovo / PC:** in Chrome o Edge, icona "Installa" nella barra degli indirizzi.
- Al primo avvio scegli il nome del dispositivo (Tablet, Telefono…). Poi, se vuoi, Impostazioni › Google Drive › **Accedi con Google**.
- Il token di Google dura un'ora. Quando scade, l'indicatore in basso nella Libreria mostra "Tocca per ricollegare Google Drive": un tocco e si riapre la finestra di Google, già compilata. Le note intanto si salvano comunque sul dispositivo.

> **Importante senza Drive:** il browser può cancellare i dati dei siti se il dispositivo resta senza spazio. Un'app installata è protetta. In ogni caso, collega Drive oppure fai ogni tanto **Esporta tutto (.zip)**.

## 4. Portare le note dal server di casa

1. Sul server comprimi la cartella `D:\Quaderno\data` (tasto destro › Comprimi). Lascia fuori `Samsungnotes`, che contiene gli originali `.sdocx` da circa 450 MB: un archivio troppo grande può bloccare il browser del tablet.
2. Nell'app: **Importa › Scegli file…** › il file `.zip` › Importa (oppure Impostazioni › Importa archivio Quadernone). Cartelle, inchiostro, PDF, copertine e cestino vengono ricreati. Le note già presenti, riconosciute dallo stesso id, non vengono toccate.
3. Con Drive collegato, le note importate vanno su Drive e da lì arrivano agli altri dispositivi.

## 5. Aggiornare l'app

Si caricano su GitHub i file cambiati, alzando `VERSION` in `sw.js` e `APP_VERSION` in `js/version.js` (lo stesso numero). I dispositivi si aggiornano da soli al ritorno nella Libreria.

## Differenze dalla versione server

| | Server di casa | Quadernone Locale |
|---|---|---|
| Dove stanno le note | `D:\Quaderno\data` | sul dispositivo (IndexedDB) + Google Drive facoltativo |
| Accesso da fuori casa | Tailscale | nessun requisito |
| Token | sì | no (accesso con Google) |
| Slide `.pptx` | LibreOffice sul server | conversione tramite Google Drive (serve Drive collegato; PDF risultante max 10 MB), oppure inserisci il PDF |
| Suggerimenti AI (pc-anto) | sì | no (le AI leggono `S:\Quaderno`) |
| Copia di sicurezza prima di "Unisci"/"Tieni la copia" | `backup\conflitti` | nel Cestino ("… (prima della risoluzione)") |

## Struttura del codice

Il client è quello della versione server (editor, inchiostro, Libreria, import/export), con questi moduli nuovi o cambiati:

- `js/local/server.js`: le stesse API `/api` del PHP (revisioni, copie di conflitto, cestino, feed, ricerca, conflitti), eseguite nell'app;
- `js/local/disk.js`: l'"hard disk" in IndexedDB (`quadernone-disk`);
- `js/local/intercept.js`: risponde alle `fetch` verso `https://quadernone.local/api/…`;
- `js/local/drive.js`: accesso Google (Google Identity Services) e chiamate REST a Drive;
- `js/local/drivesync.js`: sincronizzazione bidirezionale, con versione `v` per nota e copie di conflitto;
- `js/local/backup.js`: esporta e importa l'archivio `.zip`;
- `config.js`: l'ID client di Google.
