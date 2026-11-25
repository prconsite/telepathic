// Local-first storage. IndexedDB when available, memory otherwise. Everything the app needs works offline.

const DB_NAME = 'telepathic';
const DB_VERSION = 1;

export const DEFAULT_PREFS = {
  mode: 'wpm',          // wpm | timed | voice | pace | manual
  wpm: 140,
  timedSecs: 120,
  fontSize: 0,          // 0 = pick a sensible size for this screen on first run
  lineHeight: 1.35,
  width: 90,            // % of screen used by text
  align: 'left',
  font: 'system',
  caps: false,
  weight: 600,
  theme: 'white',
  textColor: '#ffffff',
  bgColor: '#000000',
  flipX: false,
  flipY: false,
  rotate: 0,            // 0 | 90 | 180 | 270, for rigs that hold the device sideways or upside down
  lastMode: 'wpm',
  fps: 30,
  guide: 'arrow',       // none | line | arrow | band
  guidePos: 32,         // % from top
  countdown: 3,
  loop: false,
  dimSpoken: true,
  areaHeight: 100,      // % of screen height used by the text (shrink to keep eyes near the lens)
  showClock: false,
  // voice
  lang: '',
  micSensitivity: 55,
  // camera
  cameraOn: false,
  facing: 'user',
  quality: '1080',
  overlayOpacity: 55,
  hlStickyColor: 'y',
  estimateWpm: 140,
};

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

class Store {
  constructor() {
    this.db = null;
    this.scripts = new Map();
    this.meta = {};
    this.listeners = new Map();
    this.memVersions = [];
  }

  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt).add(fn);
    return () => this.listeners.get(evt).delete(fn);
  }
  emit(evt, data) { (this.listeners.get(evt) || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }

  async init() {
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('scripts')) db.createObjectStore('scripts', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
          if (!db.objectStoreNames.contains('versions')) {
            const v = db.createObjectStore('versions', { keyPath: 'vid', autoIncrement: true });
            v.createIndex('script', 'scriptId');
          }
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('blocked'));
      });
      const tx = this.db.transaction(['scripts', 'meta']);
      const [scripts, keys, vals] = await Promise.all([
        req(tx.objectStore('scripts').getAll()),
        req(tx.objectStore('meta').getAllKeys()),
        req(tx.objectStore('meta').getAll()),
      ]);
      scripts.forEach((s) => this.scripts.set(s.id, s));
      keys.forEach((k, i) => { this.meta[k] = vals[i]; });
    } catch (e) {
      console.warn('IndexedDB unavailable, using memory only', e);
      this.db = null;
    }
    this.meta.prefs = { ...DEFAULT_PREFS, ...(this.meta.prefs || {}) };
    if (!this.meta.deviceId) await this.setMeta('deviceId', uuid());
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  get prefs() { return this.meta.prefs; }

  async setPrefs(patch) {
    this.meta.prefs = { ...this.meta.prefs, ...patch };
    await this.setMeta('prefs', this.meta.prefs);
    this.emit('prefs', patch);
  }

  async setMeta(key, value) {
    this.meta[key] = value;
    if (!this.db) return;
    try {
      const tx = this.db.transaction('meta', 'readwrite');
      if (value === undefined || value === null) tx.objectStore('meta').delete(key);
      else tx.objectStore('meta').put(value, key);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch (e) { console.warn('meta write failed', e); }
  }

  async _put(script) {
    this.scripts.set(script.id, script);
    if (!this.db) return;
    const tx = this.db.transaction('scripts', 'readwrite');
    tx.objectStore('scripts').put(script);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }

  list({ includeDeleted = false } = {}) {
    return Array.from(this.scripts.values()).filter((s) => includeDeleted || !s.deleted);
  }
  get(id) { return this.scripts.get(id) || null; }

  create(fields = {}) {
    const now = new Date().toISOString();
    return {
      id: uuid(), title: '', body: '', folder: '', pinned: false, settings: {}, deleted: false,
      created_at: now, updated_at: now, dirty: true, ...fields,
    };
  }

  // Save a local edit. Stamps the edit time and marks the script for upload.
  async save(script, { silent = false } = {}) {
    script.updated_at = new Date().toISOString();
    script.dirty = true;
    await this._put(script);
    if (!silent) this.emit('scripts', { id: script.id, source: 'local' });
    this.emit('dirty', script.id);
    return script;
  }

  // Apply a script that arrived from the cloud.
  async applyRemote(remote) {
    const local = this.scripts.get(remote.id);
    if (local && local.dirty && new Date(local.updated_at) >= new Date(remote.updated_at)) return false;
    if (local && !local.dirty && new Date(local.updated_at) >= new Date(remote.updated_at)) return false;
    if (local && local.body !== remote.body && local.body.trim()) await this.addVersion(local);
    await this._put({
      id: remote.id, title: remote.title || '', body: remote.body || '', folder: remote.folder || '',
      pinned: !!remote.pinned, settings: remote.settings || {}, deleted: !!remote.deleted,
      created_at: remote.created_at, updated_at: new Date(remote.updated_at).toISOString(), dirty: false,
    });
    return true;
  }

  async markClean(id, updatedAt) {
    const s = this.scripts.get(id);
    if (s && s.updated_at === updatedAt) { s.dirty = false; await this._put(s); }
  }

  async markAllDirty() {
    for (const s of this.scripts.values()) { s.dirty = true; await this._put(s); }
  }

  async purge(id) {
    this.scripts.delete(id);
    if (!this.db) return;
    const tx = this.db.transaction('scripts', 'readwrite');
    tx.objectStore('scripts').delete(id);
    await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
  }

  // Restore points: at most one every few minutes per script, newest 25 kept.
  async addVersion(script, { force = false } = {}) {
    const entry = { scriptId: script.id, title: script.title, body: script.body, saved_at: new Date().toISOString() };
    if (!entry.body.trim()) return;
    const existing = await this.versions(script.id);
    if (existing[0] && existing[0].body === entry.body) return;
    if (!force && existing[0] && Date.now() - new Date(existing[0].saved_at).getTime() < 3 * 60 * 1000) return;
    if (!this.db) { this.memVersions.push({ ...entry, vid: this.memVersions.length + 1 }); return; }
    try {
      const tx = this.db.transaction('versions', 'readwrite');
      const os = tx.objectStore('versions');
      os.add(entry);
      existing.slice(24).forEach((v) => os.delete(v.vid));
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch (e) { console.warn('version write failed', e); }
  }

  async versions(scriptId) {
    let rows;
    if (!this.db) rows = this.memVersions.filter((v) => v.scriptId === scriptId);
    else {
      try {
        const tx = this.db.transaction('versions');
        rows = await req(tx.objectStore('versions').index('script').getAll(scriptId));
      } catch (e) { rows = []; }
    }
    return rows.sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1));
  }
}

export const store = new Store();
export { uuid };
