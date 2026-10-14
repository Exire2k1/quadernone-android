// "Nuova nota": title + format and background, unless "Chiedi alla creazione" is off.
import { h } from '../dom.js';
import { t } from '../i18n.js';
import * as prefs from '../prefs.js';
import { openPanel } from '../ui/panel.js';
import { formatEditor } from './format.js';

/** Resolves to { title, pageDefaults } or null if cancelled. */
export function askNewNote() {
  if (!prefs.get('askOnCreate')) return Promise.resolve({ title: '', pageDefaults: prefs.get('pageDefaults') });
  return new Promise((resolve) => {
    let result = null;
    let defaults = structuredClone(prefs.get('pageDefaults'));
    const title = h('input.field-input', { type: 'text', placeholder: t('newNote.untitled'), maxLength: 200, enterkeyhint: 'done' });
    const submit = () => { result = { title: title.value.trim(), pageDefaults: defaults }; p.close(); };
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const p = openPanel({
      title: t('newNote.title'),
      body: [
        h('label.field', {}, h('span.field-label', {}, t('library.noteTitle')), title),
        formatEditor(defaults, (d) => { defaults = d; }),
      ],
      footer: [
        h('button.btn', { type: 'button', onclick: () => p.close() }, t('common.cancel')),
        h('button.btn.primary', { type: 'button', onclick: submit }, t('newNote.create')),
      ],
      onClose: () => resolve(result),
    });
    setTimeout(() => title.focus(), 80);
  });
}
