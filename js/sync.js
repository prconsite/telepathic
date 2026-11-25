// Cloud sync and accounts.
// Two ways to sync, same local-first engine underneath:
//   account  the user signs in with an emailed one-time code and owns one library (this is the product path)
//   key      a library identified by a long random key, joined from other devices with a pairing code (no account)
import { CONFIG } from './config.js';
import { store } from './store.js';

let client = null;
export function sb() {
  if (client) return client;
  if (!window.supabase || !window.supabase.createClient) throw new Error('Cloud library failed to load');
  client = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'telepathic-auth' },
    realtime: { params: { eventsPerSecond: 20 } },
  });
  client.auth.onAuthStateChange((event) => {
    // The server ended the session (signed out elsewhere, account deleted, token revoked).
    if (event === 'SIGNED_OUT' && account.signedIn) account.forget();
  });
  return client;
}

async function rpc(fn, args, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const { data, error } = await sb().rpc(fn, args).abortSignal(ctl.signal);
    if (error) throw new Error(error.message || 'Cloud request failed');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function friendly(error) {
  const msg = String((error && error.message) || error || '');
  if (/rate limit|too many|security purposes/i.test(msg)) return new Error('Too many codes requested. Wait a minute, then try again.');
  if (/expired|invalid|otp/i.test(msg)) return new Error('That code is wrong or has expired. Send a new code and try again.');
  if (/signups? not allowed|disabled/i.test(msg)) return new Error('New accounts are not open yet.');
  if (/fetch|network|load failed|abort/i.test(msg)) return new Error('No connection. Check your internet and try again.');
  return new Error(msg || 'Something went wrong. Try again.');
}

const TRASH_DAYS = 30;

// ---------- account ----------

export const account = {
  info: null,   // last answer from tp_account(): { access, plan, status, current_period_end, ... }
  lastRefresh: 0,

  get email() { return store.meta.accountEmail || null; },
  get signedIn() { return !!store.meta.accountEmail; },
  get hasAccess() { return !!(this.info && this.info.access); },

  async sendCode(email) {
    const { error } = await sb().auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) throw friendly(error);
  },

  async verify(email, code) {
    const { data, error } = await sb().auth.verifyOtp({ email, token: String(code).replace(/\D/g, ''), type: 'email' });
    if (error) throw friendly(error);
    if (!data || !data.session) throw new Error('That code is wrong or has expired. Send a new code and try again.');
    await store.setMeta('accountEmail', (data.user && data.user.email) || email);
    await store.setMeta('libraryKey', null);   // the account library replaces any pairing-code library on this device
    await store.setMeta('lastPull', null);
    await store.markAllDirty();                // scripts already on this device are merged into the account
    await this.refresh(true);
    store.emit('library', {});
    sync.setStatus(this.hasAccess ? 'idle' : 'locked');
    if (this.hasAccess) await sync.now();
  },

  // Ask the server what this account is entitled to. Keeps the last known answer when offline.
  async refresh(force = false) {
    if (!this.signedIn) { this.info = null; return null; }
    if (!force && Date.now() - this.lastRefresh < 15000) return this.info;
    this.lastRefresh = Date.now();
    const before = this.info ? `${this.info.access}:${this.info.room}` : '';
    try {
      this.info = await rpc('tp_account', {});
      await store.setMeta('accountInfo', this.info);
    } catch (e) {
      if (/permission denied|sign_in_required|jwt/i.test(e.message)) {
        let session = null;
        try { session = (await sb().auth.getSession()).data.session; } catch (err) { /* offline */ }
        if (!session) { await this.forget(); return null; }
      }
    }
    store.emit('account', this.info);
    if (this.info && `${this.info.access}:${this.info.room}` !== before) {
      store.emit('library', {});
      if (this.info.access) { sync.setStatus('idle'); sync.schedule(200); } else sync.setStatus('locked');
    }
    return this.info;
  },

  // Local sign-out bookkeeping. Scripts stay on the device.
  async forget() {
    this.info = null;
    await store.setMeta('accountEmail', null);
    await store.setMeta('accountInfo', null);
    await store.setMeta('lastPull', null);
    sync.setStatus(sync.key ? 'idle' : 'off');
    store.emit('account', null);
    store.emit('library', {});
  },

  async signOut() {
    try { await sb().auth.signOut({ scope: 'local' }); } catch (e) { /* offline is fine */ }
    await this.forget();
  },

  // Billing actions run on the server: 'checkout', 'portal' or 'delete_account'.
  async billing(action) {
    const { data, error } = await sb().functions.invoke('billing', { body: { action } });
    if (error) {
      let code = '';
      try { code = (await error.context.json()).error || ''; } catch (e) { /* no body */ }
      if (code === 'billing_not_configured') throw new Error('Subscriptions are not open yet.');
      if (code === 'not_signed_in') throw new Error('Please sign in again.');
      throw new Error(code || 'Could not reach billing. Try again in a moment.');
    }
    return data || {};
  },

  async deleteAccount() {
    await this.billing('delete_account');
    await this.signOut();
  },
};

// ---------- sync ----------

export const sync = {
  status: 'off',        // off | idle | syncing | error | offline | locked
  error: null,
  running: null,
  again: false,
  timer: null,
  onPushed: null,       // set by remote.js to ping other devices

  get key() { return store.meta.libraryKey || null; },
  get mode() { return account.signedIn ? 'account' : this.key ? 'key' : 'off'; },
  get enabled() { return this.mode !== 'off'; },
  get lastSyncAt() { return store.meta.lastSyncAt || null; },

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    store.emit('sync', { status, error });
  },

  async init() {
    account.info = store.meta.accountInfo || null;
    this.setStatus(!this.enabled ? 'off' : account.signedIn && account.info && !account.info.access ? 'locked' : 'idle');
    window.addEventListener('online', () => this.schedule(200));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (account.signedIn) account.refresh(); // picks up a subscription started or cancelled in the browser
      this.schedule(300);
    });
    store.on('dirty', () => this.schedule(2500));
    setInterval(() => { if (!document.hidden) this.schedule(0); }, 60000);
    if (account.signedIn) {
      try { sb(); } catch (e) { /* cloud library missing; stay local */ }
      account.refresh(true);
    }
    if (this.enabled) this.schedule(400);
  },

  // Name of the realtime channel this library's devices share. Unguessable, and never sent in the clear.
  async roomName() {
    if (this.mode === 'account') {
      const room = account.info && account.info.access && account.info.room;
      return room ? 'tp-' + (await sha256Hex('room:' + room)).slice(0, 40) : null;
    }
    if (!this.key) return null;
    return 'tp-' + (await sha256Hex('room:' + this.key)).slice(0, 40);
  },

  // Pairing-code mode: start a brand new library from this device.
  async enable() {
    await store.setMeta('libraryKey', newKey());
    await store.setMeta('lastPull', null);
    await store.markAllDirty();
    this.setStatus('idle');
    store.emit('library', {});
    await this.now();
  },

  // Pairing-code mode: join the library of another device.
  async join(code) {
    const key = await rpc('tp_pair_claim', { p_code: code });
    if (!key) throw new Error('That code is wrong or has expired. Codes last 10 minutes and work once.');
    await store.setMeta('libraryKey', key);
    await store.setMeta('lastPull', null);
    await store.markAllDirty(); // scripts already on this device are merged into the library
    this.setStatus('idle');
    store.emit('library', {});
    await this.now();
  },

  async pairCode() {
    if (!this.key) throw new Error('Turn on sync first');
    const code = await rpc('tp_pair_create', { p_key: this.key });
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  },

  // Pairing-code mode: stop syncing on this device. Scripts stay on the device and in the cloud library.
  async leave() {
    await store.setMeta('libraryKey', null);
    await store.setMeta('lastPull', null);
    this.setStatus(this.enabled ? 'idle' : 'off');
    store.emit('library', {});
  },

  async cloudVersions(scriptId) {
    if (this.mode === 'account') return account.hasAccess ? (await rpc('tp_acct_versions', { p_script_id: scriptId })) || [] : [];
    if (!this.key) return [];
    return (await rpc('tp_versions_list', { p_key: this.key, p_script_id: scriptId })) || [];
  },

  schedule(delay = 1500) {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.now().catch(() => {}); }, delay);
  },

  async now() {
    if (!this.enabled) return;
    if (this.running) { this.again = true; return this.running; }
    this.running = this._run().finally(() => {
      this.running = null;
      if (this.again) { this.again = false; this.schedule(300); }
    });
    return this.running;
  },

  async _run() {
    if (navigator.onLine === false) { this.setStatus('offline'); return; }
    const mode = this.mode;
    const key = this.key;
    const ident = `${mode}:${mode === 'account' ? account.email : key}`;
    if (mode === 'account') {
      if (!account.info) await account.refresh(true);
      if (account.info && !account.info.access) { this.setStatus('locked'); return; }
    }
    const push = (scripts) => (mode === 'account' ? rpc('tp_acct_push', { p_scripts: scripts }, 45000) : rpc('tp_push', { p_key: key, p_scripts: scripts }, 45000));
    const pull = (since) => (mode === 'account' ? rpc('tp_acct_pull', { p_since: since }, 45000) : rpc('tp_pull', { p_key: key, p_since: since }, 45000));
    const still = () => `${this.mode}:${this.mode === 'account' ? account.email : this.key}` === ident;
    this.setStatus('syncing');
    try {
      // 1. push local edits in size-limited batches
      const dirty = store.list({ includeDeleted: true }).filter((s) => s.dirty);
      const pushedIds = [];
      let batch = [];
      let size = 0;
      const flush = async () => {
        if (!batch.length) return;
        const sent = batch.map((s) => ({
          id: s.id, title: s.title, body: s.body, folder: s.folder, pinned: s.pinned,
          settings: s.settings || {}, deleted: s.deleted, updated_at: s.updated_at, created_at: s.created_at,
        }));
        await push(sent);
        for (const s of sent) { await store.markClean(s.id, s.updated_at); pushedIds.push(s.id); }
        batch = []; size = 0;
      };
      for (const s of dirty) {
        const len = (s.body || '').length + 400;
        if (batch.length >= 40 || size + len > 700000) await flush();
        batch.push(s); size += len;
      }
      await flush();
      if (!still()) return;

      // 2. pull what changed elsewhere
      const res = await pull(store.meta.lastPull || null);
      if (!still()) return;
      const changed = [];
      let cursor = store.meta.lastPull || null;
      for (const r of (res && res.scripts) || []) {
        if (await store.applyRemote(r)) changed.push(r.id);
        cursor = r.server_updated_at; // rows arrive ordered by server time, so the last one is the newest
      }
      if (cursor !== (store.meta.lastPull || null)) await store.setMeta('lastPull', cursor);
      await store.setMeta('lastSyncAt', new Date().toISOString());

      // 3. empty the trash of anything deleted more than 30 days ago
      const cutoff = Date.now() - TRASH_DAYS * 86400000;
      for (const s of store.list({ includeDeleted: true })) {
        if (s.deleted && !s.dirty && new Date(s.updated_at).getTime() < cutoff) await store.purge(s.id);
      }

      this.setStatus('idle');
      if (changed.length) store.emit('scripts', { ids: changed, source: 'remote' });
      if (pushedIds.length && this.onPushed) this.onPushed(pushedIds);
    } catch (e) {
      console.warn('sync failed', e);
      const msg = String(e && e.message);
      if (/subscription_required/.test(msg)) {
        await account.refresh(true);
        this.setStatus('locked');
        return;
      }
      if (mode === 'account' && /sign_in_required|permission denied|jwt/i.test(msg)) {
        await account.refresh(true); // clears the account if the session is really gone
        if (account.signedIn) { this.setStatus('error', 'Please sign in again'); this.schedule(30000); }
        return;
      }
      const offline = navigator.onLine === false || /abort|fetch|network|load failed/i.test(msg);
      this.setStatus(offline ? 'offline' : 'error', e && e.message);
      this.schedule(offline ? 15000 : 30000);
    }
  },
};
