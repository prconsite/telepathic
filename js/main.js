// App shell: library, editor, remote control, settings.
import { CONFIG } from './config.js';
import { store } from './store.js';
import { sync, account } from './sync.js';
import { remote } from './remote.js';
import { prompter, MODES } from './prompter.js';
import { importFile } from './importer.js';
import { parseScript, stripMarkup, countWords, fmtDuration, esc, HL } from './markup.js';
import { $, $$, icons, sheet, toast, confirmSheet, promptSheet, menuSheet, debounce, timeAgo, downloadBlob, shareOrDownload } from './ui.js';

const ui = { view: 'library', folder: 'all', query: '', editingId: null, hlSticky: false, previewOn: false, pendingSave: false, target: null };
const HL_COLORS = { y: '#ffe45c', g: '#6ef0a5', b: '#7cc4ff', p: '#ff9fd0', o: '#ffb066', r: '#ff7a72' };

const displayTitle = (s) => (s.title || '').trim() || stripMarkup(s.body).trim().split('\n')[0].slice(0, 60) || 'Untitled';
const snippet = (s) => stripMarkup(s.body.replace(/^\s*#{1,3}\s+.*$/gm, '')).replace(/\s+/g, ' ').trim().slice(0, 140);
const readSecs = (words) => (words / Math.max(40, store.prefs.estimateWpm || 140)) * 60;

function throttle(fn, ms) {
  let last = 0; let timer = null;
  return (...args) => {
    const wait = ms - (Date.now() - last);
    clearTimeout(timer);
    if (wait <= 0) { last = Date.now(); fn(...args); } else timer = setTimeout(() => { last = Date.now(); fn(...args); }, wait);
  };
}

function deviceName() {
  if (store.meta.deviceName) return store.meta.deviceName;
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'PC';
  return 'Browser';
}

// ---------- views ----------

function setView(name) {
  ui.view = name;
  ['library', 'editor', 'remote', 'settings'].forEach((v) => { $(`#view-${v}`).hidden = v !== name; });
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  document.body.classList.toggle('editing', name === 'editor');
  if (name === 'library') renderLibrary();
  if (name === 'settings') renderSettings();
  if (name === 'remote') { renderRemote(true); sayHello(); }
  announce();
}

// ---------- library ----------

function renderSyncChip() {
  const chip = $('#sync-chip');
  const map = {
    off: ['', 'Sync off', 'cloudOff'],
    idle: ['ok', 'Synced', 'cloud'],
    syncing: ['warn', 'Syncing', 'cloud'],
    offline: ['', 'Offline', 'cloudOff'],
    error: ['bad', 'Sync issue', 'cloud'],
    locked: ['warn', 'Plus needed', 'cloud'],
  };
  const [dot, label, ico] = map[sync.status] || map.off;
  chip.innerHTML = `${icons[ico]}<span>${label}</span>${dot ? `<i class="dot ${dot}"></i>` : ''}`;
}

function renderLibrary() {
  if (ui.view !== 'library') return;
  const live = store.list().filter((s) => !(s.settings && s.settings.purged));
  const trash = store.list({ includeDeleted: true }).filter((s) => s.deleted && !(s.settings && s.settings.purged));
  const folders = Array.from(new Set(live.map((s) => s.folder).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const pinned = live.filter((s) => s.pinned);
  if (ui.folder.startsWith('f:') && !folders.includes(ui.folder.slice(2))) ui.folder = 'all';
  if (ui.folder === 'trash' && !trash.length) ui.folder = 'all';
  if (ui.folder === 'pinned' && !pinned.length) ui.folder = 'all';

  const chip = (key, label, count) => `<button type="button" class="chip${ui.folder === key ? ' on' : ''}" data-folder="${esc(key)}" role="tab" aria-selected="${ui.folder === key}">${esc(label)}${count != null ? ` <span style="opacity:.6">${count}</span>` : ''}</button>`;
  $('#folders').innerHTML = [
    chip('all', 'All', live.length),
    pinned.length ? chip('pinned', 'Pinned', pinned.length) : '',
    ...folders.map((f) => chip(`f:${f}`, f, live.filter((s) => s.folder === f).length)),
    trash.length ? chip('trash', 'Trash', trash.length) : '',
  ].join('');

  let rows = ui.folder === 'trash' ? trash : ui.folder === 'pinned' ? pinned : ui.folder.startsWith('f:') ? live.filter((s) => s.folder === ui.folder.slice(2)) : live;
  const q = ui.query.trim().toLowerCase();
  if (q) rows = rows.filter((s) => (s.title + '\n' + s.body).toLowerCase().includes(q));
  rows = rows.slice().sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (a.updated_at < b.updated_at ? 1 : -1));

  const list = $('#script-list');
  if (!rows.length) {
    list.innerHTML = q
      ? `<div class="empty-state"><strong>No matches</strong>Nothing in your scripts contains “${esc(ui.query)}”.</div>`
      : `<div class="empty-state"><strong>No scripts here yet</strong>Tap New script to write one, paste one, or import a Word, PDF or text file.</div>`;
    return;
  }
  list.innerHTML = rows.map((s) => {
    const words = countWords(s.body);
    const meta = [`${words.toLocaleString()} words`, fmtDuration(readSecs(words)), timeAgo(s.updated_at), s.folder].filter(Boolean).join(' · ');
    return `<article class="item" data-id="${s.id}">
      <button type="button" class="item-main" data-a="open">
        <h3>${s.pinned ? icons.pin : ''}<span>${esc(displayTitle(s))}</span></h3>
        <p>${esc(snippet(s)) || 'Empty script'}</p>
        <div class="meta">${esc(meta)}</div>
      </button>
      ${s.deleted ? '' : `<button type="button" class="icon-btn item-play" data-a="play" aria-label="Prompt ${esc(displayTitle(s))}">${icons.play}</button>`}
      <button type="button" class="icon-btn" data-a="more" aria-label="More actions">${icons.more}</button>
    </article>`;
  }).join('');
}

async function itemMenu(id) {
  const s = store.get(id);
  if (!s) return;
  if (s.deleted) {
    const c = await menuSheet({ title: displayTitle(s), items: [
      { label: 'Restore', icon: 'undo', value: 'restore' },
      { label: 'Delete forever', icon: 'trash', value: 'purge', danger: true },
    ] });
    if (c === 'restore') { s.deleted = false; await store.save(s); toast('Restored.'); }
    if (c === 'purge' && await confirmSheet({ title: 'Delete forever?', body: 'This removes the script from every synced device. It cannot be undone.', ok: 'Delete', danger: true })) {
      s.title = ''; s.body = ''; s.settings = { purged: true };
      await store.save(s);
      if (!sync.enabled) await store.purge(s.id);
      renderLibrary();
    }
    return;
  }
  const c = await menuSheet({ title: displayTitle(s), items: [
    { label: 'Prompt', icon: 'play', value: 'play' },
    { label: 'Edit', icon: 'doc', value: 'edit' },
    { label: s.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', value: 'pin' },
    { label: 'Move to folder', icon: 'folder', value: 'folder', detail: s.folder || '' },
    { label: 'Duplicate', icon: 'copy', value: 'dup' },
    ...(CONFIG.preview ? [] : [{ label: 'Share as text', icon: 'share', value: 'share' }]),
    { sep: true },
    { label: 'Delete', icon: 'trash', value: 'delete', danger: true },
  ] });
  if (c === 'play') openPrompter(id);
  else if (c === 'edit') openEditor(id);
  else if (c === 'pin') { s.pinned = !s.pinned; await store.save(s); }
  else if (c === 'folder') await moveToFolder(s);
  else if (c === 'dup') { const copy = store.create({ title: `${displayTitle(s)} copy`, body: s.body, folder: s.folder, settings: { ...(s.settings || {}) } }); await store.save(copy); toast('Duplicated.'); }
  else if (c === 'share') await shareScript(s);
  else if (c === 'delete') await deleteScript(s);
}

async function deleteScript(s) {
  s.deleted = true;
  await store.save(s);
  toast('Moved to Trash. Kept for 30 days.', { action: { label: 'Undo', fn: async () => { s.deleted = false; await store.save(s); } } });
}

async function moveToFolder(s) {
  const folders = Array.from(new Set(store.list().map((x) => x.folder).filter(Boolean))).sort();
  const c = await menuSheet({ title: 'Move to folder', items: [
    { label: 'No folder', value: '__none', active: !s.folder },
    ...folders.map((f) => ({ label: f, icon: 'folder', value: `f:${f}`, active: s.folder === f })),
    { sep: true },
    { label: 'New folder', icon: 'plus', value: '__new' },
  ] });
  if (!c) return;
  let folder = s.folder;
  if (c === '__none') folder = '';
  else if (c === '__new') { const name = await promptSheet({ title: 'New folder', placeholder: 'Folder name', ok: 'Create' }); if (!name) return; folder = name.slice(0, 60); } else folder = c.slice(2);
  s.folder = folder;
  await store.save(s);
}

async function shareScript(s) {
  const name = `${displayTitle(s).replace(/[^\w\- ]+/g, '').trim() || 'Script'}.txt`;
  const r = await shareOrDownload(new Blob([stripMarkup(s.body)], { type: 'text/plain' }), name, displayTitle(s));
  if (r === 'downloaded') toast('Saved to your downloads.');
}

async function newScriptMenu() {
  const c = await menuSheet({ title: 'New script', items: [
    { label: 'Blank script', icon: 'doc', value: 'blank' },
    { label: 'Paste from clipboard', icon: 'clipboard', value: 'paste' },
    { label: 'Import a file', icon: 'upload', value: 'import', detail: CONFIG.preview ? 'Text, PowerPoint or RTF in this preview' : 'Word, PowerPoint, PDF, text, RTF' },
  ] });
  const folder = ui.folder.startsWith('f:') ? ui.folder.slice(2) : '';
  if (c === 'blank') { const s = store.create({ folder }); await store.save(s, { silent: true }); openEditor(s.id, { fresh: true }); }
  else if (c === 'paste') {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (e) { /* permission denied or unsupported */ }
    const s = store.create({ folder, body: (text || '').replace(/\r\n?/g, '\n').trim() });
    await store.save(s, { silent: true });
    openEditor(s.id, { fresh: true });
    if (!text) toast('Tap in the text area, then hold and choose Paste.', { ms: 4500 });
  } else if (c === 'import') $('#file-input').click();
}

async function handleFiles(files) {
  let last = null;
  let restored = 0;
  for (const file of files) {
    try {
      const res = await importFile(file);
      if (res.kind === 'backup') {
        for (const b of res.scripts) {
          if (!b || typeof b.body !== 'string') continue;
          const existing = b.id && store.get(b.id);
          if (existing && existing.updated_at >= (b.updated_at || '')) continue;
          const s = store.create({ title: b.title || '', body: b.body, folder: b.folder || '', pinned: !!b.pinned, settings: b.settings || {} });
          if (b.id && /^[0-9a-f-]{36}$/i.test(b.id)) s.id = b.id;
          await store.save(s, { silent: true });
          restored++;
        }
      } else {
        const folder = ui.folder.startsWith('f:') ? ui.folder.slice(2) : '';
        const s = store.create({ title: res.title, body: res.body, folder });
        await store.save(s, { silent: true });
        last = s;
      }
    } catch (e) {
      console.warn(e);
      toast(`${file.name}: ${e.message || 'could not be imported'}`, { ms: 6000 });
    }
  }
  if (restored) toast(`Restored ${restored} script${restored === 1 ? '' : 's'} from the backup.`);
  if (last && files.length === 1) openEditor(last.id);
  else renderLibrary();
}

// ---------- editor ----------

const ed = {};
let lastSnapshot = 0;

async function saveNow() {
  const s = store.get(ui.editingId);
  if (!s) return;
  const title = ed.title.value;
  const body = ed.body.value;
  ui.pendingSave = false;
  if (s.title === title && s.body === body) { ed.saved.textContent = 'Saved'; return; }
  if (Date.now() - lastSnapshot > 3 * 60 * 1000) { lastSnapshot = Date.now(); await store.addVersion(s); }
  s.title = title;
  s.body = body;
  await store.save(s, { silent: true });
  ed.saved.textContent = 'Saved';
}
const saveSoon = debounce(saveNow, 450);

function updateStats() {
  const words = countWords(ed.body.value);
  const pauses = Array.from(ed.body.value.matchAll(/\[pause\s+(\d+(?:\.\d+)?)\s*s?\]/gi)).reduce((t, m) => t + parseFloat(m[1]), 0);
  ed.stats.textContent = words
    ? `${words.toLocaleString()} words · about ${fmtDuration(readSecs(words) + pauses)} at ${store.prefs.estimateWpm} wpm${pauses ? ` (includes ${fmtDuration(pauses)} of pauses)` : ''}`
    : 'Start typing, paste, or import a file. Everything saves automatically.';
}
const updateStatsSoon = debounce(updateStats, 200);

function onEdit() {
  ui.pendingSave = true;
  ed.saved.textContent = 'Saving…';
  saveSoon();
  updateStatsSoon();
  if (ui.previewOn) renderPreviewSoon();
}

function renderPreview() { ed.preview.innerHTML = parseScript(ed.body.value).html || '<p class="empty">Nothing to preview yet.</p>'; }
const renderPreviewSoon = debounce(renderPreview, 250);

function setPreview(on) {
  ui.previewOn = on;
  ed.body.hidden = on;
  ed.preview.hidden = !on;
  ed.previewBtn.setAttribute('aria-pressed', String(on));
  if (on) renderPreview();
}

function openEditor(id, { fresh = false } = {}) {
  const s = store.get(id);
  if (!s) return;
  ui.editingId = id;
  ui.fresh = fresh;
  ed.title.value = s.title;
  ed.body.value = s.body;
  ed.saved.textContent = 'Saved';
  ui.pendingSave = false;
  lastSnapshot = 0;
  setPreview(false);
  setView('editor');
  updateStats();
  ed.body.scrollTop = 0;
  if (fresh && !s.body) setTimeout(() => ed.title.focus(), 80);
}

async function leaveEditor() {
  saveSoon.cancel();
  await saveNow();
  const s = store.get(ui.editingId);
  if (s && !s.title.trim() && !s.body.trim()) await store.purge(s.id); // never keep an untouched blank
  ui.editingId = null;
  setHl(false);
  setView('library');
}

function insertText(text, selStart = null, selEnd = null) {
  const ta = ed.body;
  ta.focus();
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
  if (!ok) { ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
  if (selStart !== null) ta.setSelectionRange(selStart, selEnd === null ? selStart : selEnd);
}

function wrapSelection(before, after, { collapse = false } = {}) {
  const ta = ed.body;
  const a = ta.selectionStart;
  const b = ta.selectionEnd;
  const v = ta.value;
  const sel = v.slice(a, b);
  // Already wrapped? Then the button takes the formatting off again.
  if (sel && v.slice(a - before.length, a) === before && v.slice(b, b + after.length) === after) {
    ta.setSelectionRange(a - before.length, b + after.length);
    insertText(sel, a - before.length, a - before.length + sel.length);
    return;
  }
  if (sel.length > before.length + after.length && sel.startsWith(before) && sel.endsWith(after) && !sel.includes('\n')) {
    const inner = sel.slice(before.length, sel.length - after.length);
    insertText(inner, a, a + inner.length);
    return;
  }
  if (!sel.trim()) {
    insertText(before + after, a + before.length);
    return;
  }
  const lines = sel.split('\n');
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    const lead = line.match(/^\s*/)[0];
    const trail = line.match(/\s*$/)[0];
    return lead + before + line.slice(lead.length, line.length - trail.length) + after + trail;
  }).join('\n');
  if (collapse) insertText(out, a + out.length);
  else if (lines.length === 1) {
    // keep just the words selected, so pressing the button again removes the formatting
    const lead = sel.match(/^\s*/)[0].length;
    const trail = sel.match(/\s*$/)[0].length;
    insertText(out, a + lead + before.length, a + out.length - trail - after.length);
  } else insertText(out, a, a + out.length);
}

function setHl(on) {
  ui.hlSticky = on;
  ed.hl.setAttribute('aria-pressed', String(on));
  ed.hlColors.hidden = !on;
  if (on) toast('Highlighter is locked on. Select text and it is highlighted. Tap the highlighter again to switch it off.', { ms: 4200 });
}

function toolAction(t) {
  const ta = ed.body;
  if (t === 'preview') { setPreview(!ui.previewOn); return; }
  if (ui.previewOn) setPreview(false);
  if (t === 'bold') wrapSelection('**', '**');
  else if (t === 'italic') wrapSelection('*', '*');
  else if (t === 'underline') wrapSelection('__', '__');
  else if (t === 'note') wrapSelection('[[', ']]');
  else if (t === 'pause') insertText('[pause 2] ');
  else if (t === 'speed') insertText('[speed 120] ');
  else if (t === 'hl') {
    if (ta.selectionStart !== ta.selectionEnd && !ui.hlSticky) wrapSelection(`{${store.prefs.hlStickyColor}}`, '{/}', { collapse: true });
    setHl(!ui.hlSticky);
  } else if (t === 'section') {
    const v = ta.value;
    const start = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let end = v.indexOf('\n', start);
    if (end === -1) end = v.length;
    const line = v.slice(start, end);
    ta.setSelectionRange(start, end);
    const next = /^\s*#{1,3}\s+/.test(line) ? line.replace(/^\s*#{1,3}\s+/, '') : `# ${line}`;
    insertText(next, start + next.length);
  } else if (t === 'clear') {
    if (ta.selectionStart === ta.selectionEnd) { toast('Select the text you want to clear formatting from.'); return; }
    const a = ta.selectionStart;
    const cleaned = ta.value.slice(a, ta.selectionEnd).replace(/\{[ygbpor/]\}/gi, '').replace(/\*\*|__|\*/g, '');
    insertText(cleaned, a, a + cleaned.length);
  }
}

async function editorMenu() {
  const s = store.get(ui.editingId);
  if (!s) return;
  const c = await menuSheet({ title: 'Script', items: [
    { label: 'Version history', icon: 'history', value: 'history' },
    { label: s.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', value: 'pin' },
    { label: 'Move to folder', icon: 'folder', value: 'folder', detail: s.folder || '' },
    { label: 'Duplicate', icon: 'copy', value: 'dup' },
    ...(CONFIG.preview ? [] : [{ label: 'Share as text', icon: 'share', value: 'share' }]),
    { label: 'Formatting help', icon: 'eye', value: 'help' },
    { sep: true },
    { label: 'Delete', icon: 'trash', value: 'delete', danger: true },
  ] });
  if (!c) return;
  saveSoon.cancel();
  await saveNow();
  if (c === 'history') showHistory(s);
  else if (c === 'pin') { s.pinned = !s.pinned; await store.save(s, { silent: true }); toast(s.pinned ? 'Pinned.' : 'Unpinned.'); }
  else if (c === 'folder') { await moveToFolder(s); }
  else if (c === 'dup') { const copy = store.create({ title: `${displayTitle(s)} copy`, body: s.body, folder: s.folder }); await store.save(copy, { silent: true }); openEditor(copy.id); toast('You are now editing the copy.'); }
  else if (c === 'share') await shareScript(s);
  else if (c === 'help') sheet({ title: 'Formatting', html: markupHelp() });
  else if (c === 'delete') { ui.editingId = null; setView('library'); await deleteScript(s); }
}

async function showHistory(s) {
  const local = (await store.versions(s.id)).map((v) => ({ ...v, where: 'This device' }));
  let cloud = [];
  if (sync.enabled) { try { cloud = (await sync.cloudVersions(s.id)).map((v) => ({ ...v, where: 'Cloud' })); } catch (e) { /* offline */ } }
  const seen = new Set([s.body]);
  const all = [...local, ...cloud].sort((a, b) => (new Date(a.saved_at) < new Date(b.saved_at) ? 1 : -1)).filter((v) => { if (seen.has(v.body)) return false; seen.add(v.body); return true; });
  const html = all.length ? all.map((v, i) => `
    <div class="take">
      <div class="row gap"><div class="grow"><strong>${esc(new Date(v.saved_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</strong>
      <div class="muted small">${countWords(v.body).toLocaleString()} words · ${v.where}</div></div>
      <button type="button" class="btn" data-i="${i}">Restore</button></div>
      <p class="muted small">${esc(stripMarkup(v.body).replace(/\s+/g, ' ').trim().slice(0, 160))}</p>
    </div>`).join('')
    : '<p class="muted">No earlier versions yet. Telepathic keeps a restore point every few minutes while you edit, so you can always get old wording back.</p>';
  const sh = sheet({ title: 'Version history', html, wide: true });
  sh.body.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-i]');
    if (!b) return;
    const v = all[+b.dataset.i];
    await store.addVersion(s, { force: true });
    s.body = v.body;
    if (v.title) s.title = v.title;
    await store.save(s, { silent: true });
    if (ui.editingId === s.id) { ed.title.value = s.title; ed.body.value = s.body; updateStats(); if (ui.previewOn) renderPreview(); }
    sh.close();
    toast('Restored. Your previous text was saved as a new restore point.');
  });
}

function markupHelp() {
  return `<div class="kv">
    <kbd># Intro</kbd><span>Section heading you can jump to. Not read aloud.</span>
    <kbd>**bold**</kbd><span>Bold. Also <kbd>*italic*</kbd> and <kbd>__underline__</kbd>.</span>
    <kbd>{y}text{/}</kbd><span>Colour. y yellow, g green, b blue, p pink, o orange, r red.</span>
    <kbd>[pause 3]</kbd><span>Stops scrolling for 3 seconds. <kbd>[pause]</kbd> waits for a tap.</span>
    <kbd>[speed 120]</kbd><span>Changes the reading pace to 120 words a minute from that point on.</span>
    <kbd>[[smile]]</kbd><span>A small note to yourself. Not counted or voice-tracked.</span>
    <kbd>HOST: Hello</kbd><span>A line starting with a NAME: gets its own speaker colour.</span>
    <kbd>---</kbd><span>Divider line.</span>
  </div><p class="muted small">The toolbar buttons add these for you.</p>`;
}

// ---------- prompter glue ----------

async function openPrompter(id, opts = {}) {
  if (ui.view === 'editor' && ui.editingId) { saveSoon.cancel(); await saveNow(); }
  const s = store.get(id);
  if (!s || s.deleted) { toast('That script is not on this device yet.'); return; }
  if (!s.body.trim()) { toast('This script is empty. Add some text first.'); return; }
  prompter.open(id, opts);
}

// ---------- remote control ----------

const devices = new Map();
let lastHello = 0;
let rmSig = '';

const announce = throttle(() => {
  if (Date.now() - lastHello < 20000) remote.send('state', { name: deviceName(), view: prompter.active ? 'prompter' : ui.view, p: prompter.state() });
}, 300);

function sayHello() { remote.send('hello', { name: deviceName() }); }
function sendCmd(a, v) { if (ui.target) remote.send('cmd', { to: ui.target, a, v }); }

function renderRemote(force = false) {
  if (ui.view !== 'remote') return;
  const now = Date.now();
  for (const [id, d] of devices) if (now - d.seen > 9000) devices.delete(id);
  const list = Array.from(devices.entries());
  if (!ui.target || !devices.has(ui.target)) {
    const prompting = list.find(([, d]) => d.p && d.p.open);
    ui.target = prompting ? prompting[0] : list[0] ? list[0][0] : null;
  }
  const conn = $('#rm-conn');
  conn.innerHTML = sync.enabled
    ? `<i class="dot ${remote.status === 'online' ? 'ok' : 'warn'}"></i><span>${remote.status === 'online' ? 'Connected' : 'Connecting'}</span>`
    : '<i class="dot"></i><span>This browser only</span>';
  const body = $('#rm-body');
  const d = ui.target ? devices.get(ui.target) : null;
  const p = d && d.p && d.p.open ? d.p : null;
  const sig = JSON.stringify([list.map(([id, x]) => [id, x.name]), ui.target, p ? [p.scriptId, p.sections, p.mode, p.title] : null, sync.enabled, store.list().length]);

  if (force || sig !== rmSig) {
    rmSig = sig;
    if (!list.length) {
      body.innerHTML = `<div class="card"><h2>No prompter found yet</h2>
        <p>Open Telepathic on the device you read from. This device becomes the remote: play, pause, speed, text size, sections, and even choosing a different script.</p>
        ${sync.enabled
    ? '<p>Both devices must be signed in to the same account (or paired with the same code). Check <strong>Settings</strong> on the other device.</p>'
    : '<p><strong>You are not signed in</strong>, so only two windows of this same browser can see each other. Sign in on both devices in Settings to control your iPad from your iPhone.</p><button type="button" class="btn primary" data-a="goto-settings">Open Settings</button>'}
      </div>`;
      return;
    }
    const chips = list.length > 1 ? `<div class="row gap wrap">${list.map(([id, x]) => `<button type="button" class="chip${id === ui.target ? ' on' : ''}" data-dev="${id}">${esc(x.name)}</button>`).join('')}</div>` : '';
    const scripts = store.list().filter((s) => s.body.trim()).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    const scriptList = `<div class="card"><h2>${p ? 'Switch script' : 'Open a script'} on ${esc(d.name)}</h2>
      <div class="rm-list">${scripts.map((s) => `<button type="button" data-open="${s.id}">${icons.play}<span class="grow">${esc(displayTitle(s))}<br><span class="muted">${fmtDuration(readSecs(countWords(s.body)))}</span></span></button>`).join('') || '<p>No scripts on this device yet.</p>'}</div></div>`;
    if (!p) {
      body.innerHTML = `${chips ? `<div class="card">${chips}</div>` : ''}<div class="card"><h2>${esc(d.name)} is ready</h2><p>Pick a script below and it opens on ${esc(d.name)}.</p></div>${scriptList}`;
    } else {
      body.innerHTML = `${chips ? `<div class="card">${chips}</div>` : ''}
      <div class="card rm-now">
        <div><div class="muted small">${esc(d.name)}</div><h2 id="rm-title">${esc(p.title)}</h2></div>
        <input type="range" id="rm-seek" min="0" max="1000" value="0" aria-label="Position in script">
        <div class="rm-times"><span id="rm-el">0:00</span><span id="rm-status"></span><span id="rm-rem"></span></div>
        <div class="rm-main">
          <button type="button" class="icon-btn" data-c="restart" aria-label="Back to the start">${icons.restart}</button>
          <button type="button" class="icon-btn" data-c="nudge" data-v="-4" aria-label="Back a few lines">${icons.back}</button>
          <button type="button" class="play" id="rm-play" data-c="toggle" aria-label="Play or pause">${icons.play}</button>
          <button type="button" class="icon-btn" data-c="nudge" data-v="4" aria-label="Forward a few lines">${icons.fwd}</button>
          <button type="button" class="icon-btn rec" id="rm-rec" data-c="record" aria-label="Record">${icons.rec}</button>
        </div>
        <div class="rm-grid">
          <div class="stepper"><button type="button" class="icon-btn" data-c="speed" data-v="-1" aria-label="Slower">${icons.minus}</button><div class="label" id="rm-speed"></div><button type="button" class="icon-btn" data-c="speed" data-v="1" aria-label="Faster">${icons.plus}</button></div>
          <div class="stepper"><button type="button" class="icon-btn" data-c="font" data-v="-4" aria-label="Smaller text">${icons.minus}</button><div class="label" id="rm-font"></div><button type="button" class="icon-btn" data-c="font" data-v="4" aria-label="Larger text">${icons.plus}</button></div>
        </div>
        <div class="row gap wrap">
          <button type="button" class="chip" data-a="rm-mode">${icons.sliders}<span id="rm-mode"></span></button>
          <button type="button" class="chip" id="rm-mirror" data-c="flipx">${icons.mirror}<span>Mirror</span></button>
          <button type="button" class="chip" id="rm-flipv" data-c="flipy">${icons.flipV}<span>Flip</span></button>
          <button type="button" class="chip" id="rm-rot" data-c="rotate">${icons.rotate}<span id="rm-rot-label">Rotate</span></button>
          <button type="button" class="chip" data-c="close">${icons.close}<span>Close script</span></button>
        </div>
        ${p.sections.length ? `<div class="rm-list">${p.sections.map((t, i) => `<button type="button" data-c="section" data-v="${i}">${icons.chevR}<span class="grow">${esc(t)}</span></button>`).join('')}</div>` : ''}
      </div>${scriptList}`;
    }
  }
  if (!p) return;
  const set = (id, text) => { const n = $(id, body); if (n && n.textContent !== text) n.textContent = text; };
  const seek = $('#rm-seek', body);
  if (seek && !seek.matches(':active') && document.activeElement !== seek) seek.value = Math.round(p.progress * 1000);
  set('#rm-el', fmtDuration(p.elapsed));
  set('#rm-rem', `-${fmtDuration(p.remaining)}`);
  set('#rm-status', p.status || (p.recording ? 'Recording' : ''));
  const play = $('#rm-play', body);
  if (play && play.dataset.state !== String(p.playing)) { play.dataset.state = String(p.playing); play.innerHTML = p.playing ? icons.pause : icons.play; }
  const speed = $('#rm-speed', body);
  const speedHtml = p.mode === 'timed' ? `${fmtDuration(p.timedSecs)}<small>length</small>` : p.mode === 'voice' || p.mode === 'manual' ? `${MODES[p.mode].short}<small>mode</small>` : `${p.wpm}<small>wpm</small>`;
  if (speed && speed.innerHTML !== speedHtml) speed.innerHTML = speedHtml;
  const font = $('#rm-font', body);
  const fontHtml = `${p.fontSize}<small>text size</small>`;
  if (font && font.innerHTML !== fontHtml) font.innerHTML = fontHtml;
  set('#rm-mode', MODES[p.mode] ? MODES[p.mode].label : p.mode);
  const mir = $('#rm-mirror', body);
  if (mir) mir.classList.toggle('on', !!p.flipX);
  const fv = $('#rm-flipv', body);
  if (fv) fv.classList.toggle('on', !!p.flipY);
  const rt = $('#rm-rot', body);
  if (rt) rt.classList.toggle('on', !!p.rotate);
  set('#rm-rot-label', p.rotate ? `${p.rotate}°` : 'Rotate');
  const rec = $('#rm-rec', body);
  if (rec) rec.classList.toggle('on', !!p.recording);
}

function initRemote() {
  remote.on('hello', () => { lastHello = Date.now(); announce(); });
  remote.on('state', (payload, from) => {
    devices.set(from, { name: (payload && payload.name) || 'Device', view: payload && payload.view, p: payload && payload.p, seen: Date.now() });
    renderRemote();
  });
  remote.on('cmd', (payload) => {
    if (!payload || payload.to !== remote.id) return;
    if (payload.a === 'open') openPrompter(payload.v);
    else prompter.command(payload.a, payload.v);
    setTimeout(announce, 60);
  });
  prompter.onChange = () => announce();
  prompter.onClose = () => { if (ui.view === 'library') renderLibrary(); announce(); };
  setInterval(() => {
    if (prompter.active && prompter.playing) announce();
    if (ui.view === 'remote' && !document.hidden) { sayHello(); renderRemote(); }
  }, 1000);
  store.on('remote-joined', () => { if (ui.view === 'remote') sayHello(); });
  store.on('remote-status', () => renderRemote());

  const body = $('#rm-body');
  body.addEventListener('click', async (ev) => {
    const dev = ev.target.closest('[data-dev]');
    if (dev) { ui.target = dev.dataset.dev; renderRemote(true); return; }
    const open = ev.target.closest('[data-open]');
    if (open) { sendCmd('open', open.dataset.open); toast('Opening on the other device.'); return; }
    const c = ev.target.closest('[data-c]');
    if (c) { sendCmd(c.dataset.c, c.dataset.v !== undefined ? Number(c.dataset.v) : undefined); return; }
    const a = ev.target.closest('[data-a]');
    if (!a) return;
    if (a.dataset.a === 'goto-settings') setView('settings');
    if (a.dataset.a === 'rm-mode') {
      const d = devices.get(ui.target);
      const mode = await menuSheet({ title: 'How should it scroll?', items: Object.entries(MODES).map(([k, m]) => ({ label: m.label, value: k, active: d && d.p && d.p.mode === k })) });
      if (mode) sendCmd('mode', mode);
    }
  });
  body.addEventListener('input', (ev) => { if (ev.target.id === 'rm-seek') sendSeek(ev.target.value / 1000); });
}
const sendSeek = throttle((v) => sendCmd('seek', v), 120);


// ---------- account: sign in, plan, billing ----------

function planLine(info) {
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '');
  if (!info) return 'Checking your account.';
  if (info.plan === 'comp') return 'Complimentary Telepathic Plus: sync, the remote and cloud history are on.';
  if (info.plan === 'included') return 'Sync across your devices, the remote and cloud history are included with your account.';
  if (info.plan === 'plus') {
    if (info.status === 'past_due') return 'Your last payment did not go through. Update your card to keep syncing.';
    if (info.cancel_at_period_end) return `Telepathic Plus, ending on ${day(info.current_period_end)}. Sync keeps working until then.`;
    if (info.status === 'trialing') return `Telepathic Plus free trial. The first payment is on ${day(info.current_period_end)}.`;
    return `Telepathic Plus${info.current_period_end ? `, renews on ${day(info.current_period_end)}` : ''}.`;
  }
  if (info.disputed) return 'Sync is paused because a payment on this account was disputed. Contact support to sort it out.';
  return 'Sync across devices, the remote and cloud history are part of Telepathic Plus. Everything else stays free on this device, and your scripts stay put.';
}

function accountCards() {
  const signInCard = `
    <div class="card"><h2>Your account</h2>
      <p>Sign in to keep the same scripts on every device, use one device as a remote for another, and keep cloud version history. There is no password: you get a 6-digit code by email.</p>
      <button type="button" class="btn primary block" data-a="sign-in">${icons.cloud}<span>Sign in or create an account</span></button>
    </div>`;
  if (account.signedIn) {
    const info = account.info;
    const access = !!(info && info.access);
    const statusText = { idle: 'Up to date.', syncing: 'Syncing now.', offline: 'Offline. Changes are saved on this device and sync when you are back online.', error: `Could not sync${sync.error ? `: ${sync.error}` : ''}. It retries by itself.` }[sync.status] || '';
    return `
    <div class="card" id="account-card"><h2>Signed in</h2>
      <p><strong>${esc(account.email)}</strong></p>
      <p id="plan-line">${esc(planLine(info))}</p>
      ${access ? `<p>${esc(statusText)}${sync.lastSyncAt ? ` Last synced ${esc(timeAgo(sync.lastSyncAt))}.` : ''}</p>` : ''}
      ${info && info.plan === 'none' && !info.disputed ? `<button type="button" class="btn primary block" data-a="plus-start">${info.had_subscription ? 'Subscribe again' : 'Get Telepathic Plus'}</button>` : ''}
      ${info && info.plan === 'plus' ? '<button type="button" class="btn block" data-a="plus-manage">Manage billing</button>' : ''}
      <div class="row gap">${access ? '<button type="button" class="btn grow" data-a="sync-now">Sync now</button>' : ''}<button type="button" class="btn ghost grow" data-a="sign-out">Sign out</button></div>
      <button type="button" class="btn ghost block small" data-a="account-delete">Delete my account</button>
    </div>`;
  }
  if (sync.key) {
    const statusText = { idle: 'Up to date.', syncing: 'Syncing now.', offline: 'Offline. Changes are saved on this device and sync when you are back online.', error: `Could not sync${sync.error ? `: ${sync.error}` : ''}. It retries by itself.` }[sync.status] || '';
    return `
    <div class="card"><h2>Pairing-code sync is on</h2>
      <p>${esc(statusText)}${sync.lastSyncAt ? ` Last synced ${esc(timeAgo(sync.lastSyncAt))}.` : ''}</p>
      <button type="button" class="btn primary block" data-a="sync-code">${icons.plus}<span>Add another device</span></button>
      <div class="row gap"><button type="button" class="btn grow" data-a="sync-now">Sync now</button><button type="button" class="btn ghost grow" data-a="sync-leave">Stop syncing here</button></div>
    </div>${signInCard}`;
  }
  return signInCard + (CONFIG.pairing ? `
    <div class="card"><h2>Sync without an account</h2>
      <p>Link your own devices with a one-time pairing code instead. Your scripts already save on this device either way.</p>
      <div class="row gap"><button type="button" class="btn grow" data-a="sync-on">Start pairing</button><button type="button" class="btn grow" data-a="sync-join">I have a code</button></div>
    </div>` : '');
}

function signInFlow() {
  const s = sheet({ title: 'Sign in', html: '' });
  const okEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  let email = '';
  const showError = (msg) => { const n = $('.form-error', s.body); if (n) { n.textContent = msg; n.hidden = !msg; } };
  const busy = (btn, label) => { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = label; };
  const idle = (btn) => { btn.disabled = false; btn.textContent = btn.dataset.label; };

  const stepEmail = () => {
    s.body.innerHTML = `
      <p class="muted">Enter your email and we will send you a 6-digit code. New here? The same step creates your account.</p>
      <input class="field" id="si-email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="you@example.com" value="${esc(email)}" aria-label="Email address">
      <p class="form-error" role="alert" hidden></p>
      <button type="button" class="btn primary block" id="si-send">Email me a code</button>`;
    const input = $('#si-email', s.body);
    const btn = $('#si-send', s.body);
    setTimeout(() => input.focus(), 60);
    const send = async () => {
      email = input.value.trim().toLowerCase();
      if (!okEmail(email)) { showError('Enter a valid email address.'); return; }
      showError('');
      busy(btn, 'Sending');
      try { await account.sendCode(email); stepCode(); } catch (e) { idle(btn); showError(e.message); }
    };
    btn.onclick = send;
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') send(); });
  };

  const stepCode = () => {
    s.body.innerHTML = `
      <p class="muted">We sent a code to <strong>${esc(email)}</strong>. It can take a minute. Check your spam folder if it does not arrive.</p>
      <input class="field code" id="si-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="000000" aria-label="6-digit code">
      <p class="form-error" role="alert" hidden></p>
      <button type="button" class="btn primary block" id="si-verify">Sign in</button>
      <div class="row gap"><button type="button" class="btn ghost grow" id="si-resend">Send a new code</button><button type="button" class="btn ghost grow" id="si-back">Change email</button></div>`;
    const input = $('#si-code', s.body);
    const btn = $('#si-verify', s.body);
    setTimeout(() => input.focus(), 60);
    const verify = async () => {
      const code = input.value.replace(/\D/g, '');
      if (code.length < 6) { showError('Enter the 6-digit code from the email.'); return; }
      showError('');
      busy(btn, 'Signing in');
      try {
        await account.verify(email, code);
        s.close();
        toast(account.hasAccess ? 'Signed in. Your scripts are syncing.' : 'Signed in.');
        renderSettings();
      } catch (e) { idle(btn); showError(e.message); }
    };
    btn.onclick = verify;
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') verify(); });
    input.addEventListener('input', () => { if (input.value.replace(/\D/g, '').length === 6 && !btn.disabled) verify(); });
    $('#si-back', s.body).onclick = stepEmail;
    $('#si-resend', s.body).onclick = async (ev) => {
      const b = ev.currentTarget;
      busy(b, 'Sending');
      try { await account.sendCode(email); showError(''); toast('New code sent.'); } catch (e) { showError(e.message); }
      idle(b);
    };
  };
  stepEmail();
}

// After the Stripe page sends the user back, wait for the payment confirmation to land on the account.
async function confirmSubscription() {
  toast('Thank you. Confirming your subscription.', { ms: 4000 });
  for (let i = 0; i < 8; i++) {
    const info = await account.refresh(true);
    if (info && info.plan === 'plus') { toast('Telepathic Plus is active. Your scripts are syncing.', { ms: 5000 }); renderSettings(); return; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  toast('Your payment is still being confirmed. Sync switches on by itself as soon as it clears.', { ms: 7000 });
}

// ---------- settings ----------

function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
}

function renderSettings() {
  if (ui.view !== 'settings') return;
  const on = sync.enabled;
  const syncCard = accountCards();
  const statusText = { idle: 'Up to date', syncing: 'Syncing now', offline: 'Offline. Changes are saved on this device and will sync when you are back online.', error: `Could not sync${sync.error ? `: ${sync.error}` : ''}. It will retry by itself.`, off: '' }[sync.status] || '';
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const previewCard = `<div class="card"><h2>This is a preview</h2><p>You are looking at Telepathic inside Claude, where the network, camera and microphone are switched off. Scripts, editing, scrolling, mirroring and display settings all work here. The Mirror, Flip and Rotate buttons work here too. <strong>Voice follow, recording, cloud sync, the remote between devices, file sharing and Add to Home Screen</strong> need the microphone, camera or network, so they switch on once the app is live at its own web address.</p></div>`;
  const installCard = isStandalone() ? '' : `
    <div class="card"><h2>Install on this device</h2>
      ${iOS ? `<ol class="steps"><li>Open this page in <strong>Safari</strong>.</li><li>Tap the <strong>Share</strong> button.</li><li>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li></ol><p>It then opens full screen like any other app and works offline.</p>`
    : `<p>Use your browser's <strong>Install app</strong> or <strong>Add to Home Screen</strong> option. It then opens in its own window and works offline.</p>`}
    </div>`;
  $('#st-body').innerHTML = `
    ${CONFIG.preview ? previewCard : syncCard + installCard}
    <div class="card"><h2>This device</h2>
      <div class="row gap"><div class="grow"><strong>${esc(deviceName())}</strong><p>The name other devices see in Remote.</p></div><button type="button" class="btn" data-a="device-name">Rename</button></div>
      <label class="ctl"><span class="ctl-label">Reading pace for time estimates<output id="st-wpm-out">${store.prefs.estimateWpm} wpm</output></span>
      <input type="range" id="st-wpm" min="90" max="220" step="5" value="${store.prefs.estimateWpm}"></label>
    </div>
${CONFIG.preview ? '' : `    <div class="card"><h2>Backup</h2>
      <p>Save every script into one file you control, or restore from one.</p>
      <div class="row gap"><button type="button" class="btn grow" data-a="backup-export">${icons.share}<span>Export all</span></button><button type="button" class="btn grow" data-a="backup-import">${icons.upload}<span>Restore</span></button></div>
    </div>`}
    <div class="card"><h2>Keyboard, clicker and pedal</h2>
      <p>Any Bluetooth keyboard, presentation clicker or page-turn pedal works while prompting. A game controller works too: the main button plays and pauses, the direction pad changes speed and position, and the shoulder buttons jump between sections.</p>
      <div class="kv">
        <kbd>Space</kbd><span>Play or pause (also Enter, Page Down)</span>
        <kbd>↑ ↓</kbd><span>Faster, slower</span>
        <kbd>← →</kbd><span>Back or forward a few lines (also Page Up)</span>
        <kbd>[ ]</kbd><span>Previous, next section</span>
        <kbd>+ −</kbd><span>Text size</span>
        <kbd>M V O</kbd><span>Mirror, flip top-to-bottom, rotate</span>
        <kbd>R</kbd><span>Back to the start</span>
        <kbd>Esc</kbd><span>Close the prompter</span>
      </div>
    </div>
    <div class="card"><h2>Formatting</h2>${markupHelp()}</div>
    <div class="card"><h2>About</h2><p>Telepathic ${esc(CONFIG.version)}. No subscription, no ads, no script limits. Scripts live on this device${on ? ' and in your private cloud library' : ''}.</p></div>`;
}

async function settingsAction(a) {
  try {
    if (a === 'sign-in') { signInFlow(); return; }
    if (a === 'sign-out') {
      if (await confirmSheet({ title: 'Sign out?', body: 'Your scripts stay on this device. Sync and the remote stop until you sign in again.', ok: 'Sign out' })) await account.signOut();
    } else if (a === 'plus-start' || a === 'plus-manage') {
      const r = await account.billing(a === 'plus-start' ? 'checkout' : 'portal');
      if (r.url) { location.assign(r.url); return; }
    } else if (a === 'account-delete') {
      if (await confirmSheet({ title: 'Delete your account?', body: 'This cancels any subscription and permanently deletes your account and its cloud copy of your scripts. Scripts already on this device stay here. This cannot be undone.', ok: 'Delete account', danger: true })) {
        await account.deleteAccount();
        toast('Your account was deleted.');
      }
    } else if (a === 'sync-on') {
      await sync.enable();
      if (sync.status === 'error' || sync.status === 'offline') toast(sync.status === 'offline' ? 'Sync is on. It will upload when you are online.' : `Sync is on, but the cloud did not answer: ${sync.error || 'unknown error'}`, { ms: 6000 });
      else toast('Sync is on. Tap Add another device to connect your iPad or iPhone.', { ms: 5000 });
    } else if (a === 'sync-join') {
      const code = await promptSheet({ title: 'Join with a code', placeholder: 'XXXX-XXXX', ok: 'Join', code: true, hint: 'On the device that already has your scripts: Settings → Add another device.' });
      if (!code) return;
      await sync.join(code);
      toast('Joined. Your scripts are syncing now.');
    } else if (a === 'sync-code') {
      const code = await sync.pairCode();
      sheet({ title: 'Add another device', html: `<div class="bigcode">${esc(code)}</div>
        <ol class="steps"><li>Open Telepathic on the other device.</li><li>Go to <strong>Settings → I have a code from another device</strong>.</li><li>Type this code. It works once and expires in 10 minutes.</li></ol>
        <p class="muted small">Anyone with a valid code can read this library, so only share it with your own devices.</p>` });
    } else if (a === 'sync-now') {
      await sync.now();
      toast(sync.status === 'idle' ? 'Everything is up to date.' : 'Could not reach the cloud. It will retry by itself.');
    } else if (a === 'sync-leave') {
      if (await confirmSheet({ title: 'Stop syncing on this device?', body: 'Your scripts stay on this device and in the cloud library. You will need a new code from another device to rejoin.', ok: 'Stop syncing', danger: true })) await sync.leave();
    } else if (a === 'device-name') {
      const name = await promptSheet({ title: 'Device name', value: deviceName(), placeholder: 'Studio iPad' });
      if (name) await store.setMeta('deviceName', name.slice(0, 40));
    } else if (a === 'backup-export') {
      const scripts = store.list().map(({ dirty, ...rest }) => rest);
      const blob = new Blob([JSON.stringify({ app: 'telepathic', exported_at: new Date().toISOString(), scripts }, null, 2)], { type: 'application/json' });
      const r = await shareOrDownload(blob, `telepathic-backup-${new Date().toISOString().slice(0, 10)}.json`, 'Telepathic backup');
      if (r === 'downloaded') toast('Backup saved to your downloads.');
    } else if (a === 'backup-import') {
      $('#file-input').click();
    }
  } catch (e) {
    console.warn(e);
    toast(e.message || 'Something went wrong.', { ms: 6000 });
  }
  renderSettings();
}

// ---------- boot ----------

const SAMPLE = `# Welcome
Welcome to Telepathic. Tap the screen to pause, and tap again to keep going.

Drag with one finger to move the text. Pinch with two fingers to change the size.

[pause 2] That was a two second pause. You add one with the **Pause** button in the editor.

# Make it yours
Use **bold** for the words you want to hit, and {y}colour{/} for the lines you must not miss.
[[Notes like this stay small and are never read aloud.]]

HOST: Lines that start with a name get their own colour.
GUEST: That makes two-person scripts easy to follow.

# Go hands free
Open Display to switch on Follow my voice, so the script keeps pace with you instead of the other way round.

Tap Mirror if you are reading through teleprompter glass. Tap Camera to record yourself while you read.

That is everything. Delete this script whenever you like.`;

async function boot() {
  await store.init();

  // icons into static markup
  $$('[data-ico]').forEach((n) => { n.innerHTML = icons[n.dataset.ico] || ''; });
  $('#search-ico').innerHTML = icons.search;
  $('#new-ico').innerHTML = icons.plus;
  $('#ed-back').innerHTML = icons.chevL;
  $('#ed-more').innerHTML = icons.more;
  $('#ed-prompt-ico').innerHTML = icons.play;
  $('#ed-hl').innerHTML = icons.highlighter;
  $('#p-close').innerHTML = icons.close;
  $('#p-restart').innerHTML = icons.restart;
  $('#p-back').innerHTML = icons.back;
  $('#p-fwd').innerHTML = icons.fwd;
  $('#p-minus').innerHTML = icons.minus;
  $('#p-plus').innerHTML = icons.plus;
  $('#p-rec').innerHTML = icons.rec;

  Object.assign(ed, {
    title: $('#ed-title'), body: $('#ed-body'), saved: $('#ed-saved'), stats: $('#ed-stats'), preview: $('#ed-preview'),
    previewBtn: $('#ed-preview-btn'), hl: $('#ed-hl'), hlColors: $('#ed-hl-colors'),
  });

  if (!store.meta.seeded) {
    if (!store.list({ includeDeleted: true }).length) {
      const s = store.create({ title: 'Start here', body: SAMPLE });
      await store.save(s, { silent: true });
    }
    await store.setMeta('seeded', true);
  }

  prompter.mount();

  // tabs
  $('#tabs').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-view]'); if (b) setView(b.dataset.view); });

  // library
  $('#search').addEventListener('input', (ev) => { ui.query = ev.target.value; renderLibrary(); });
  $('#folders').addEventListener('click', (ev) => { const b = ev.target.closest('[data-folder]'); if (b) { ui.folder = b.dataset.folder; renderLibrary(); } });
  $('#script-list').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-a]');
    if (!btn) return;
    const id = btn.closest('.item').dataset.id;
    const s = store.get(id);
    if (btn.dataset.a === 'open') { if (s && s.deleted) itemMenu(id); else openEditor(id); }
    else if (btn.dataset.a === 'play') openPrompter(id);
    else if (btn.dataset.a === 'more') itemMenu(id);
  });
  $('#new-btn').addEventListener('click', newScriptMenu);
  $('#sync-chip').addEventListener('click', () => setView('settings'));
  $('#file-input').addEventListener('change', async (ev) => { const files = Array.from(ev.target.files || []); ev.target.value = ''; if (files.length) await handleFiles(files); });

  // editor
  ed.title.addEventListener('input', onEdit);
  ed.body.addEventListener('input', onEdit);
  $('#ed-back').addEventListener('click', leaveEditor);
  $('#ed-more').addEventListener('click', editorMenu);
  $('#ed-prompt').addEventListener('click', () => openPrompter(ui.editingId));
  $('#ed-tools').addEventListener('pointerdown', (ev) => { if (ev.target.closest('button')) ev.preventDefault(); }); // keep the text selection
  $('#ed-tools').addEventListener('click', (ev) => {
    const c = ev.target.closest('[data-hl]');
    if (c) { store.setPrefs({ hlStickyColor: c.dataset.hl }); $$('#ed-hl-colors button').forEach((b) => b.classList.toggle('on', b === c)); return; }
    const b = ev.target.closest('button[data-t]');
    if (b) toolAction(b.dataset.t);
  });
  ed.hlColors.innerHTML = Object.keys(HL).map((k) => `<button type="button" data-hl="${k}" class="${store.prefs.hlStickyColor === k ? 'on' : ''}" style="background:${HL_COLORS[k]}" aria-label="${HL[k]} highlighter"></button>`).join('');
  document.addEventListener('selectionchange', debounce(() => {
    if (!ui.hlSticky || document.activeElement !== ed.body || ui.view !== 'editor') return;
    if (ed.body.selectionStart !== ed.body.selectionEnd) wrapSelection(`{${store.prefs.hlStickyColor}}`, '{/}', { collapse: true });
  }, 600));

  // settings
  $('#st-body').addEventListener('click', (ev) => { const b = ev.target.closest('[data-a]'); if (b) settingsAction(b.dataset.a); });
  $('#st-body').addEventListener('input', (ev) => {
    if (ev.target.id === 'st-wpm') { store.prefs.estimateWpm = Number(ev.target.value); $('#st-wpm-out').textContent = `${ev.target.value} wpm`; store.setMeta('prefs', store.meta.prefs); }
  });

  // never lose typing
  const flush = () => { if (ui.editingId && ui.pendingSave) { saveSoon.cancel(); saveNow(); } };
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);

  // data changes
  store.on('scripts', (info) => {
    if (ui.view === 'library') renderLibrary();
    if (ui.view === 'remote') renderRemote(true);
    const ids = (info && info.ids) || (info && info.id ? [info.id] : []);
    if (info && info.source === 'remote') {
      if (prompter.active && ids.includes(prompter.script.id)) prompter.refreshScript();
      if (ui.view === 'editor' && ids.includes(ui.editingId) && !ui.pendingSave) {
        const s = store.get(ui.editingId);
        if (s && s.deleted) { ui.editingId = null; setView('library'); toast('This script was deleted on another device.'); } else if (s) { ed.title.value = s.title; ed.body.value = s.body; updateStats(); if (ui.previewOn) renderPreview(); }
      }
    }
  });
  store.on('sync', () => { renderSyncChip(); if (ui.view === 'settings') renderSettings(); });
  store.on('library', () => { renderSyncChip(); if (ui.view === 'settings') renderSettings(); });
  store.on('account', () => { if (ui.view === 'settings' && !document.querySelector('.sheet-backdrop')) renderSettings(); });

  if (CONFIG.preview) { $('#sync-chip').hidden = true; $('#tabs [data-view=remote]').hidden = true; }
  await sync.init();
  const billingReturn = () => {
    const back = location.hash === '#billing-done' || new URLSearchParams(location.search).get('billing') === 'done';
    if (!back) return;
    history.replaceState(null, '', location.pathname);
    if (account.signedIn) confirmSubscription();
  };
  window.addEventListener('hashchange', billingReturn);
  billingReturn();
  remote.init();
  initRemote();
  renderSyncChip();
  setView('library');

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') && !window.__TP_NO_SW__ && !CONFIG.preview) {
    try {
      const hadController = !!navigator.serviceWorker.controller;
      await navigator.serviceWorker.register('sw.js');
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController) toast('Telepathic was updated.', { action: { label: 'Reload', fn: () => location.reload() } });
      });
    } catch (e) { /* offline support unavailable */ }
  }

  window.__tp = { store, sync, account, remote, prompter, ui };
  document.documentElement.dataset.ready = '1';
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<p style="padding:24px">Telepathic could not start: ${esc(e.message || e)}. Reload the page.</p>`);
});
