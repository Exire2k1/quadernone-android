// Short messages at the bottom of the screen, optionally with one action.
import { h } from '../dom.js';

let host = null;

export function toast(message, { kind = '', action = null, duration = 4000 } = {}) {
  host ||= document.getElementById('toasts');
  const el = h(`div.toast${kind ? '.' + kind : ''}`, { role: 'status' },
    h('span', {}, message),
    action ? h('button.toast-action', { type: 'button', onclick: () => { action.fn(); dismiss(); } }, action.label) : null);
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  host.append(el);
  if (duration > 0) setTimeout(dismiss, duration);
  return dismiss;
}

/** Shows an ApiFailure (or any error) as an error toast. */
export function toastError(err) {
  toast(err?.message || String(err), { kind: 'error', duration: 6000 });
}
