// App settings stored with the notes: _app/settings.json (port of the settings part of Config.php).
import { ApiError, isInt } from './util.js';

const FILE = '_app/settings.json';
export const DEFAULT_TRASH_DAYS = 30;

export async function settings(ctx) {
  const s = (await ctx.fs.readJson(FILE)) ?? {};
  let days = Math.trunc(Number(s.trashRetentionDays ?? DEFAULT_TRASH_DAYS));
  if (!Number.isFinite(days)) days = DEFAULT_TRASH_DAYS;
  return { trashRetentionDays: Math.max(1, Math.min(3650, days)) };
}

export async function saveSettings(ctx, input) {
  const s = await settings(ctx);
  if (Object.hasOwn(input, 'trashRetentionDays')) {
    const d = input.trashRetentionDays;
    if (!isInt(d) || d < 1 || d > 3650) {
      throw new ApiError(400, 'bad_settings', 'I giorni di conservazione devono essere tra 1 e 3650.');
    }
    s.trashRetentionDays = d;
  }
  await ctx.fs.writeJson(FILE, { version: 1, ...s });
  return s;
}
