// Device-to-device messaging for the remote control and live script updates.
// Two transports run side by side: Supabase Realtime (any devices in the same library, anywhere)
// and BroadcastChannel (two windows of the same browser, works offline).
import { store, uuid } from './store.js';
import { sync, sb } from './sync.js';

const handlers = new Map();
const seen = new Set();
let bc = null;
let channel = null;
let joined = false;
let retryTimer = null;
let retryDelay = 1500;
let generation = 0;
// Each open window is its own remote endpoint, so two windows of one browser can control each other.
const sessionId = uuid();

function dispatch(msg) {
  if (!msg || !msg.mid || msg.from === sessionId || seen.has(msg.mid)) return;
  seen.add(msg.mid);
  if (seen.size > 600) { const it = seen.values(); for (let i = 0; i < 200; i++) seen.delete(it.next().value); }
  (handlers.get(msg.evt) || []).forEach((fn) => { try { fn(msg.payload, msg.from); } catch (e) { console.error(e); } });
}

export const remote = {
  status: 'local', // local | connecting | online
  id: sessionId,

  on(evt, fn) {
    if (!handlers.has(evt)) handlers.set(evt, new Set());
    handlers.get(evt).add(fn);
  },

  send(evt, payload) {
    const msg = { mid: uuid(), from: sessionId, evt, payload };
    try { if (bc) bc.postMessage(msg); } catch (e) { /* ignore */ }
    if (channel && joined) {
      try { channel.send({ type: 'broadcast', event: 'm', payload: msg }); } catch (e) { /* ignore */ }
    }
  },

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    store.emit('remote-status', s);
  },

  init() {
    if ('BroadcastChannel' in window) {
      bc = new BroadcastChannel('telepathic-remote');
      bc.onmessage = (e) => dispatch(e.data);
    }
    sync.onPushed = (ids) => this.send('changed', { ids });
    this.on('changed', () => sync.schedule(150));
    store.on('library', () => this.connect());
    document.addEventListener('visibilitychange', () => { if (!document.hidden && sync.enabled && !joined) this.connect(); });
    window.addEventListener('online', () => { if (sync.enabled && !joined) this.connect(); });
    this.connect();
  },

  async connect() {
    const gen = ++generation;
    clearTimeout(retryTimer);
    await this.disconnect();
    if (!sync.enabled) { this.setStatus('local'); return; }
    let room;
    let client;
    try { room = await sync.roomName(); client = sb(); } catch (e) { this.setStatus('local'); return; }
    if (gen !== generation) return;
    if (!room) { this.setStatus('local'); return; } // signed in but sync is not available on this account
    this.setStatus('connecting');
    const ch = client.channel(room, { config: { broadcast: { self: false, ack: false } } });
    channel = ch;
    ch.on('broadcast', { event: 'm' }, ({ payload }) => dispatch(payload));
    ch.subscribe((status) => {
      if (gen !== generation) return;
      if (status === 'SUBSCRIBED') {
        joined = true;
        retryDelay = 1500;
        this.setStatus('online');
        store.emit('remote-joined', {});
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        joined = false;
        this.setStatus('connecting');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => this.connect(), retryDelay);
        retryDelay = Math.min(retryDelay * 1.8, 20000);
      }
    });
  },

  async disconnect() {
    joined = false;
    if (channel) {
      const ch = channel;
      channel = null;
      try { await sb().removeChannel(ch); } catch (e) { /* ignore */ }
    }
  },
};
