# Vendored libraries

Copied into the app so it works offline; never loaded from a CDN.

| Library | Version | File | Licence | Used for |
|---|---|---|---|---|
| perfect-freehand | 1.2.2 | `perfect-freehand/index.js` (npm `dist/esm/index.mjs`, renamed to .js for the server MIME type) | MIT (Steve Ruiz) | Pressure-sensitive stroke outlines |
| pdf.js (pdfjs-dist) | 4.10.38 | `pdfjs/pdf.min.js`, `pdfjs/pdf.worker.min.js` (npm `build/*.min.mjs`, renamed to .js for the server MIME type), `pdfjs/cmaps/`, `pdfjs/standard_fonts/` | Apache-2.0 (Mozilla) | PDF pages as backgrounds, text extraction |
| pdf-lib | 1.17.1 | `pdf-lib/pdf-lib.esm.min.js` | MIT (Andrew Dillon) | PDF export with the original pages embedded as vectors |
| JSZip | 3.10.1 | `jszip/jszip.min.js` (UMD: sets `JSZip` on the global object) | MIT or GPLv3 (Stuart Knightley) — used under MIT | .zip import and multi-note export |
