/** An error answered by the local server: same shape as the PHP server's JSON errors. */
export class ServerError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const notFound = (what = 'note') => new ServerError(404, `${what}_not_found`,
  { note: 'Nota non trovata.', folder: 'Cartella non trovata.', page: 'Pagina non trovata (forse è stata eliminata).',
    attachment: 'Allegato non trovato.', trash: 'Nota non trovata nel cestino.' }[what] || 'Non trovato.');
