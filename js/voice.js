// Voice input for the prompter.
//  - SpeechFollower: speech recognition that reports the words it hears, so the script can follow the reader.
//  - LevelMeter: microphone loudness, so the script can scroll while you talk and wait while you don't.
import { normWord } from './markup.js';

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
export const speechSupported = !!SR;

export class SpeechFollower {
  constructor({ lang, onWords, onState }) {
    this.lang = lang || navigator.language || 'en-US';
    this.onWords = onWords;
    this.onState = onState || (() => {});
    this.active = false;
    this.rec = null;
    this.restarts = 0;
    this.lastStart = 0;
  }

  start() {
    if (!SR) throw new Error('Speech recognition is not available in this browser.');
    this.active = true;
    this._begin();
  }

  _begin() {
    if (!this.active) return;
    const rec = new SR();
    this.rec = rec;
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => { this.lastStart = Date.now(); this.onState('listening'); };
    rec.onresult = (e) => {
      // Only the most recent stretch of speech matters for following along.
      let text = '';
      for (let i = Math.max(e.resultIndex, e.results.length - 2); i < e.results.length; i++) text += ' ' + e.results[i][0].transcript;
      const words = text.split(/\s+/).map(normWord).filter(Boolean);
      if (words.length) this.onWords(words.slice(-8));
    };
    rec.onerror = (e) => {
      if (e.error === 'service-not-allowed') {
        // The browser exposes speech recognition but will not run it here (seen in iOS Home Screen apps).
        this.active = false;
        this.onState('unavailable');
      } else if (e.error === 'not-allowed' || e.error === 'audio-capture') {
        this.active = false;
        this.onState('denied');
      } else if (e.error === 'language-not-supported') {
        this.active = false;
        this.onState('unsupported');
      }
    };
    rec.onend = () => {
      if (!this.active) { this.onState('stopped'); return; }
      // Browsers end recognition after silence; quietly start again. Back off if it ends instantly.
      const quick = Date.now() - this.lastStart < 1200;
      this.restarts = quick ? this.restarts + 1 : 0;
      if (this.restarts > 6) { this.active = false; this.onState('failed'); return; }
      setTimeout(() => { try { this._begin(); } catch (err) { this.active = false; this.onState('failed'); } }, quick ? 400 : 60);
    };
    try { rec.start(); } catch (e) { this.active = false; this.onState('failed'); }
  }

  stop() {
    this.active = false;
    if (this.rec) { try { this.rec.onend = null; this.rec.abort(); } catch (e) { /* ignore */ } }
    this.rec = null;
    this.onState('stopped');
  }
}

export class LevelMeter {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.ownStream = false;
    this.analyser = null;
    this.buf = null;
    this.floor = 0.01;
    this.level = 0;
    this.lastVoice = 0;
  }

  // Pass an existing stream (the camera's) to avoid a second microphone prompt.
  async start(existingStream) {
    const hasAudio = existingStream && existingStream.getAudioTracks().length;
    if (hasAudio) this.stream = existingStream;
    else {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      this.ownStream = true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
  }

  // Returns true while the reader is speaking. sensitivity 0..100 (higher = triggers on quieter speech).
  speaking(sensitivity = 55, hangMs = 650) {
    if (!this.analyser) return false;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    this.level = rms;
    // Track the room's noise floor: fall quickly, rise slowly.
    this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.999 + rms * 0.001;
    const factor = 6 - (sensitivity / 100) * 4.5; // 6x floor (strict) .. 1.5x floor (eager)
    const threshold = Math.max(0.008, this.floor * factor);
    const now = performance.now();
    if (rms > threshold) this.lastVoice = now;
    return now - this.lastVoice < hangMs;
  }

  stop() {
    if (this.ownStream && this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null; this.stream = null; this.analyser = null; this.ownStream = false;
  }
}

function similar(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (a.slice(0, 4) === b.slice(0, 4)) return true; // run / running, colour / colours
  if (Math.abs(a.length - b.length) > 1) return false;
  // one edit apart
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// Given the words just heard and the script, find where the reader is.
// `spoken` is the script's words (normalised, empties removed); `cur` is the index of the next expected word.
// Returns the new index of the next expected word, or `cur` if nothing convincing was heard.
export function followWords(spoken, cur, heard) {
  if (!heard.length || !spoken.length) return cur;
  const from = Math.max(0, cur - 12);
  const to = Math.min(spoken.length - 1, cur + 60);
  let best = -1;
  let bestScore = 0;
  for (let j = from; j <= to; j++) {
    if (!similar(spoken[j], heard[heard.length - 1])) continue;
    let score = 1;
    while (score < heard.length && j - score >= 0 && similar(spoken[j - score], heard[heard.length - 1 - score])) score++;
    const ahead = j - cur;
    // The further the jump, the more consecutive words must agree.
    const need = ahead < 0 ? 4 : ahead <= 2 ? 1 : ahead <= 10 ? 2 : 3;
    if (score < need) continue;
    if (score > bestScore || (score === bestScore && Math.abs(ahead) < Math.abs(best - cur))) { best = j; bestScore = score; }
  }
  return best >= 0 ? best + 1 : cur;
}
