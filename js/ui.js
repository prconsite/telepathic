// Small UI toolkit: icons, sheets, toasts, dialogs. No dependencies.
import { esc } from './markup.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const P = (d, extra = '') => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
export const icons = {
  play: `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><rect x="5.5" y="4" width="4.5" height="16" rx="1.2"/><rect x="14" y="4" width="4.5" height="16" rx="1.2"/></svg>`,
  restart: P('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>'),
  back: P('<path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/>'),
  fwd: P('<path d="M13 17l5-5-5-5"/><path d="M6 17l5-5-5-5"/>'),
  minus: P('<path d="M5 12h14"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  close: P('<path d="M6 6l12 12M18 6L6 18"/>'),
  chevL: P('<path d="M15 5l-7 7 7 7"/>'),
  chevR: P('<path d="M9 5l7 7-7 7"/>'),
  mirror: P('<path d="M12 3v18"/><path d="M8 7l-5 5 5 5V7z"/><path d="M16 7l5 5-5 5V7z"/>'),
  flipV: P('<path d="M3 12h18"/><path d="M7 8l5-5 5 5H7z"/><path d="M7 16l5 5 5-5H7z"/>'),
  rotate: P('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>'),
  cc: P('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 10.5a2 2 0 1 0 0 3M16.5 10.5a2 2 0 1 0 0 3"/>'),
  list: P('<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'),
  camera: P('<path d="M15 10l5.5-3v10L15 14"/><rect x="2.5" y="6" width="12.5" height="12" rx="2.5"/>'),
  mic: P('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
  sliders: P('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>'),
  more: P('<path d="M5 12h.01M12 12h.01M19 12h.01"/>', 'stroke-width="3"'),
  trash: P('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
  pin: P('<path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4-1-6z"/>'),
  folder: P('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>'),
  search: P('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  share: P('<path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>'),
  history: P('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4.5l3 2"/>'),
  cloud: P('<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 10.5 3.75 3.75 0 0 1 17.5 18H7z"/>'),
  cloudOff: P('<path d="M7 18a4.5 4.5 0 0 1-.6-8.96M9.5 6.2A6 6 0 0 1 18 10.5 3.75 3.75 0 0 1 19.6 17M3 3l18 18M7 18h9"/>'),
  remote: P('<rect x="7" y="2.5" width="10" height="19" rx="3"/><circle cx="12" cy="8" r="2"/><path d="M12 14h.01M12 17.5h.01"/>'),
  doc: P('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  gear: P('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  copy: P('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  upload: P('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>'),
  clipboard: P('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 11h6M9 15h4"/>'),
  highlighter: P('<path d="M9 14l-4 4v2h4l2-2"/><path d="M9 14l8-9 4 4-9 8-3-3z"/>'),
  check: P('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  undo: P('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  eye: P('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  flipCam: P('<path d="M4 8h3l2-3h6l2 3h3v11H4V8z"/><path d="M9.5 14a2.5 2.5 0 0 0 4.6 1.2M14.5 13a2.5 2.5 0 0 0-4.6-1.2"/>'),
  rec: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="currentColor"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>`,
};

let toastTimer = null;
export function toast(msg, { ms = 2600, action = null } = {}) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.classList.remove('show'); action.fn(); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? Math.max(ms, 5000) : ms);
}

// Bottom sheet. Returns { el, body, close }.
export function sheet({ title = '', html = '', clear = false, onClose = null, wide = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `sheet-backdrop${clear ? ' clear' : ''}`;
  wrap.innerHTML = `
    <div class="sheet${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head">
        <h2>${esc(title)}</h2>
        <button type="button" class="icon-btn sheet-x" aria-label="Close">${icons.close}</button>
      </div>
      <div class="sheet-body">${html}</div>
    </div>`;
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    wrap.classList.remove('show');
    setTimeout(() => wrap.remove(), 180);
    if (onClose) onClose(result);
  };
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  $('.sheet-x', wrap).onclick = () => close();
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('show'));
  return { el: wrap, body: $('.sheet-body', wrap), close };
}

export function confirmSheet({ title, body = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const s = sheet({
      title,
      html: `${body ? `<p class="muted">${esc(body)}</p>` : ''}
        <div class="row gap">
          <button type="button" class="btn ghost grow" data-a="no">${esc(cancel)}</button>
          <button type="button" class="btn ${danger ? 'danger' : 'primary'} grow" data-a="yes">${esc(ok)}</button>
        </div>`,
      onClose: (r) => resolve(!!r),
    });
    $('[data-a=no]', s.el).onclick = () => s.close(false);
    $('[data-a=yes]', s.el).onclick = () => s.close(true);
  });
}

export function promptSheet({ title, value = '', placeholder = '', ok = 'Save', hint = '', code = false }) {
  return new Promise((resolve) => {
    const s = sheet({
      title,
      html: `${hint ? `<p class="muted">${esc(hint)}</p>` : ''}
        <input class="field${code ? ' code' : ''}" type="text" autocomplete="off" autocorrect="off" spellcheck="false" autocapitalize="${code ? 'characters' : 'sentences'}" value="${esc(value)}" placeholder="${esc(placeholder)}">
        <div class="row gap"><button type="button" class="btn primary grow" data-a="ok">${esc(ok)}</button></div>`,
      onClose: (r) => resolve(r === undefined ? null : r),
    });
    const input = $('input', s.el);
    setTimeout(() => { input.focus(); input.select(); }, 60);
    const done = () => s.close(input.value.trim());
    $('[data-a=ok]', s.el).onclick = done;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
  });
}

export function menuSheet({ title, items }) {
  return new Promise((resolve) => {
    const s = sheet({
      title,
      html: `<div class="menu">${items.map((it, i) => it.sep ? '<div class="menu-sep"></div>' : `
        <button type="button" class="menu-item${it.danger ? ' danger' : ''}${it.active ? ' active' : ''}" data-i="${i}">
          ${it.icon ? icons[it.icon] : '<span class="menu-spacer"></span>'}<span class="grow">${esc(it.label)}</span>${it.detail ? `<span class="muted">${esc(it.detail)}</span>` : ''}${it.active ? icons.check : ''}
        </button>`).join('')}</div>`,
      onClose: (r) => resolve(r === undefined ? null : r),
    });
    $$('.menu-item', s.el).forEach((b) => { b.onclick = () => s.close(items[+b.dataset.i].value); });
  });
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
  wrapped.flush = (...args) => { if (t) { clearTimeout(t); t = null; fn(...args); } };
  wrapped.cancel = () => { clearTimeout(t); t = null; };
  return wrapped;
}

export function timeAgo(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} hr ago`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Share a file through the system share sheet (Save Video, AirDrop, Files) or fall back to a download.
export async function shareOrDownload(blob, filename, title) {
  try {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}
