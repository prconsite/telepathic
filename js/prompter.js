// The prompter: rendering, scrolling engine, mirroring, voice follow, recording and on-screen controls.
import { CONFIG } from './config.js';
import { store } from './store.js';
import { parseScript, fmtDuration, esc } from './markup.js';
import { $, $$, icons, sheet, toast, menuSheet, shareOrDownload, debounce } from './ui.js';
import { SpeechFollower, LevelMeter, speechSupported, followWords } from './voice.js';
import { Recorder, recordingSupported } from './recorder.js';

export const FONTS = {
  system: { label: 'Clean', css: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif' },
  rounded: { label: 'Rounded', css: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Nunito", system-ui, sans-serif' },
  readable: { label: 'Easy read', css: 'Verdana, "Trebuchet MS", "DejaVu Sans", sans-serif' },
  serif: { label: 'Serif', css: 'Georgia, "Iowan Old Style", "Times New Roman", serif' },
  mono: { label: 'Mono', css: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
};

export const THEMES = {
  white: { label: 'White', fg: '#ffffff', bg: '#000000' },
  yellow: { label: 'Yellow', fg: '#ffe45c', bg: '#000000' },
  green: { label: 'Green', fg: '#5dfc9b', bg: '#000000' },
  paper: { label: 'Paper', fg: '#16130d', bg: '#f4efe2' },
  custom: { label: 'Custom', fg: null, bg: null },
};

export const MODES = {
  wpm: { label: 'Steady speed', short: 'Speed', hint: 'Scrolls at a set reading pace, the same on every device.' },
  timed: { label: 'Finish on time', short: 'Timed', hint: 'Set a length and the script ends exactly then.' },
  voice: { label: 'Follow my voice', short: 'Voice', hint: 'Listens and keeps your current line at the guide.' },
  pace: { label: 'Scroll while I talk', short: 'Talk', hint: 'Scrolls while you speak and waits when you stop.' },
  manual: { label: 'Manual', short: 'Manual', hint: 'Only moves when you drag, use a remote or a keyboard.' },
};
const modeEntries = () => Object.entries(MODES).filter(([k]) => !CONFIG.preview || (k !== 'voice' && k !== 'pace'));


const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
};

class Prompter {
  constructor() {
    this.active = false;
    this.script = null;
    this.parsed = { html: '', norms: [], sections: [], wordCount: 0 };
    this.pos = 0;
    this.minPos = 0;
    this.maxPos = 1;
    this.playing = false;
    this.counting = false;
    this.holdUntil = 0;
    this.elapsed = 0;       // seconds of active prompting
    this.centers = new Float32Array(0);
    this.wordEls = [];
    this.spoken = [];       // normalised, non-empty words
    this.spokenIdx = [];    // spoken index -> word index
    this.cur = 0;           // next expected spoken index (voice mode)
    this.saidTo = 0;        // word index up to which words are dimmed
    this.pauses = [];
    this.speedMarks = [];
    this.startWpm = 0;
    this.capLog = [];
    this.lastCap = 0;
    this.padPrev = null;
    this.rot = 0;
    this.sectionYs = [];
    this.lineH = 60;
    this.guideY = 100;
    this.painted = NaN;
    this.pointers = new Map();
    this.drag = null;
    this.pinch = null;
    this.follower = null;
    this.meter = null;
    this.recorder = new Recorder();
    this.takes = [];
    this.voiceState = '';
    this.onChange = null;   // called (throttled by the caller) when state worth broadcasting changes
    this.onClose = null;
    this.lastHud = 0;
    this.wake = null;
    this.persistPrefs = debounce(() => store.setMeta('prefs', store.meta.prefs), 400);
    this.tick = this.tick.bind(this);
  }

  get prefs() { return store.meta.prefs; }

  mount() {
    const ids = ['view-prompter', 'stage', 'cam', 'shade', 'flip', 'viewport', 'track', 'guide', 'dim-top', 'dim-bot', 'countdown',
      'hud', 'p-title', 'p-elapsed', 'p-remaining', 'p-progress', 'p-close', 'p-play', 'p-restart', 'p-back', 'p-fwd', 'p-minus',
      'p-plus', 'p-speed', 'p-mode', 'p-mirror', 'p-flipv', 'p-rot', 'p-voice', 'p-sections', 'p-camera', 'p-rec', 'p-settings', 'p-status', 'p-rec-time'];
    this.el = {};
    ids.forEach((id) => { this.el[id.replace(/^p-/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase())] = document.getElementById(id); });
    const e = this.el;
    e.view = e.viewPrompter;

    e.close.onclick = () => this.close();
    e.play.onclick = () => this.toggle();
    e.restart.onclick = () => this.restart();
    e.back.onclick = () => this.nudge(-4);
    e.fwd.onclick = () => this.nudge(4);
    e.minus.onclick = () => this.stepSpeed(-1);
    e.plus.onclick = () => this.stepSpeed(1);
    e.mode.onclick = () => this.chooseMode();
    e.mirror.onclick = () => this.toggleFlip('flipX');
    e.flipv.onclick = () => this.toggleFlip('flipY');
    e.rot.onclick = () => this.rotateStep();
    e.voice.onclick = () => this.toggleVoice();
    e.sections.onclick = () => this.chooseSection();
    e.camera.onclick = () => this.cameraMenu();
    e.rec.onclick = () => this.toggleRecording();
    e.settings.onclick = () => this.openDisplaySheet();
    if (CONFIG.preview) { e.camera.hidden = true; e.rec.hidden = true; }

    const stage = e.stage;
    stage.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    stage.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
    stage.addEventListener('pointerup', (ev) => this.onPointerUp(ev));
    stage.addEventListener('pointercancel', (ev) => this.onPointerUp(ev, true));
    stage.addEventListener('wheel', (ev) => {
      if (!this.active) return;
      ev.preventDefault();
      this.scrollBy(ev.deltaY * (this.prefs.flipY ? -1 : 1) * (this.rot === 180 ? -1 : 1));
    }, { passive: false });
    stage.addEventListener('mousemove', () => this.showHud());

    document.addEventListener('keydown', (ev) => this.onKey(ev));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && this.active) this.acquireWake(); });
    if (window.ResizeObserver) new ResizeObserver(() => { if (this.active) this.relayout(); }).observe(stage);
    else window.addEventListener('resize', () => { if (this.active) this.relayout(); });
  }

  // ---------- open / close ----------

  open(scriptId, { autoplay = false } = {}) {
    const script = store.get(scriptId);
    if (!script) return false;
    this.script = script;
    this.active = true;
    document.body.classList.add('prompting');
    this.el.view.hidden = false;
    this.el.title.textContent = script.title || 'Untitled';
    if (!this.prefs.fontSize) {
      const base = Math.min(window.innerWidth, window.innerHeight);
      this.prefs.fontSize = Math.round(clamp(base * 0.085, 34, 84));
      this.persistPrefs();
    }
    this.playing = false;
    this.counting = false;
    this.holdUntil = 0;
    this.elapsed = 0;
    this.startWpm = this.prefs.wpm;
    this.render();
    this.applyPrefs();
    this.restart(false);
    this.showHud(true);
    this.acquireWake();
    if (CONFIG.preview && (this.prefs.mode === 'voice' || this.prefs.mode === 'pace')) this.prefs.mode = 'wpm';
    if (this.prefs.cameraOn && recordingSupported && !CONFIG.preview) this.setCamera(true, { quiet: true });
    cancelAnimationFrame(this.raf);
    this.lastTs = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    this.changed();
    if (autoplay) this.play();
    return true;
  }

  async close() {
    if (!this.active) return;
    if (this.recorder.recording) await this.stopRecording();
    this.pause();
    this.active = false;
    cancelAnimationFrame(this.raf);
    if (this.speedMarks.length && this.startWpm) { this.prefs.wpm = this.startWpm; this.persistPrefs(); }
    this.stopVoice();
    await this.recorder.stopCamera(this.el.cam);
    this.el.stage.classList.remove('has-cam');
    this.el.view.hidden = true;
    document.body.classList.remove('prompting');
    if (this.wake) { try { this.wake.release(); } catch (e) { /* ignore */ } this.wake = null; }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $$('.sheet-backdrop.clear').forEach((n) => n.remove());
    this.changed();
    if (this.onClose) this.onClose();
  }

  async acquireWake() {
    try {
      if ('wakeLock' in navigator && !this.wake) {
        this.wake = await navigator.wakeLock.request('screen');
        this.wake.addEventListener('release', () => { this.wake = null; });
      }
    } catch (e) { /* not available; the screen follows the system setting */ }
  }

  // ---------- rendering & layout ----------

  render() {
    this.parsed = parseScript(this.script.body);
    this.el.track.innerHTML = this.parsed.html || '<p class="empty">This script is empty.</p>';
    this.spoken = [];
    this.spokenIdx = [];
    this.parsed.norms.forEach((n, i) => { if (n) { this.spoken.push(n); this.spokenIdx.push(i); } });
    this.saidTo = 0;
  }

  // Re-render after the script text changed (for example an edit from another device), keeping the place.
  refreshScript() {
    if (!this.active) return;
    const fresh = store.get(this.script.id);
    if (!fresh) return;
    const ratio = this.centers.length ? this.wordAt(this.pos) / this.centers.length : 0;
    this.script = fresh;
    this.el.title.textContent = fresh.title || 'Untitled';
    this.render();
    this.measure();
    if (this.centers.length) {
      const idx = clamp(Math.round(ratio * this.centers.length), 0, this.centers.length - 1);
      this.pos = clamp(this.centers[idx], this.minPos, this.maxPos);
    } else this.pos = this.minPos;
    this.resyncVoice();
    this.paint(true);
    this.changed();
  }

  applyPrefs() {
    const p = this.prefs;
    const st = this.el.stage;
    const theme = THEMES[p.theme] || THEMES.white;
    const fg = theme.fg || p.textColor;
    const bg = theme.bg || p.bgColor;
    const camOn = st.classList.contains('has-cam');
    const [r, g, b] = hexToRgb(bg);
    st.style.setProperty('--fs', `${p.fontSize}px`);
    st.style.setProperty('--lh', p.lineHeight);
    st.style.setProperty('--w', `${p.width}%`);
    st.style.setProperty('--fg', fg);
    st.style.setProperty('--bg', bg);
    st.style.setProperty('--bg-rgb', `${r}, ${g}, ${b}`);
    st.style.setProperty('--shade', camOn ? (p.overlayOpacity / 100).toFixed(2) : '1');
    st.style.setProperty('--font', (FONTS[p.font] || FONTS.system).css);
    st.style.setProperty('--weight', p.weight);
    st.style.setProperty('--area', `${p.areaHeight}%`);
    st.classList.toggle('flip-x', !!p.flipX);
    st.classList.toggle('flip-y', !!p.flipY);
    st.classList.toggle('caps', !!p.caps);
    st.classList.toggle('center', p.align === 'center');
    st.classList.toggle('light', (r * 299 + g * 587 + b * 114) / 1000 > 140);
    ['none', 'line', 'arrow', 'band'].forEach((gname) => st.classList.toggle(`guide-${gname}`, p.guide === gname));
    this.relayout();
    this.updateHud(true);
  }

  measure() {
    const track = this.el.track;
    const p = this.prefs;
    this.lineH = p.fontSize * p.lineHeight;
    const flipH = this.el.flip.clientHeight || window.innerHeight;
    this.guideY = flipH * (p.guidePos / 100);
    this.el.stage.style.setProperty('--guide-y', `${this.guideY}px`);
    this.el.stage.style.setProperty('--line-h', `${this.lineH}px`);
    const words = track.querySelectorAll('.w');
    this.wordEls = words;
    const centers = new Float32Array(words.length);
    for (let i = 0; i < words.length; i++) centers[i] = words[i].offsetTop + words[i].offsetHeight / 2;
    this.centers = centers;
    const h = track.offsetHeight;
    this.minPos = centers.length ? centers[0] : this.lineH * 0.5; // first spoken line sits on the guide
    this.maxPos = Math.max(this.minPos + 1, h + this.lineH * 0.5);
    const fired = new Set(this.pauses.filter((x) => x.fired).map((x) => x.i));
    this.speedMarks = Array.from(track.querySelectorAll('.sp')).map((n) => ({ y: n.offsetTop + n.offsetHeight / 2, wpm: clamp(parseInt(n.dataset.wpm, 10) || 140, 40, 400) }));
    this.pauses = Array.from(track.querySelectorAll('.pz:not(.sp)')).map((n, i) => ({
      i, y: n.offsetTop + n.offsetHeight / 2, secs: parseFloat(n.dataset.s) || 0, fired: fired.has(i), el: n,
    }));
    this.sectionYs = Array.from(track.querySelectorAll('.sec')).map((n) => n.offsetTop + n.offsetHeight / 2);
  }

  relayout() {
    if (!this.active) return;
    const had = this.centers.length;
    const idx = had ? this.wordAt(this.pos) : 0;
    const off = had ? (this.pos - this.centers[idx]) / (this.lineH || 1) : 0;
    const ratio = (this.pos - this.minPos) / Math.max(1, this.maxPos - this.minPos);
    this.applyOrientation();
    this.measure();
    if (had && this.centers.length) this.pos = this.centers[Math.min(idx, this.centers.length - 1)] + off * this.lineH;
    else this.pos = this.minPos + ratio * (this.maxPos - this.minPos);
    this.pos = clamp(this.pos, this.minPos, this.maxPos);
    this.paint(true);
  }

  // Index of the first word on or below the guide line.
  wordAt(pos) {
    const c = this.centers;
    const target = pos - this.lineH * 0.5;
    let lo = 0; let hi = c.length - 1; let ans = c.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid] >= target) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return Math.max(0, ans);
  }

  spokenCountBefore(wordIdx) {
    const a = this.spokenIdx;
    let lo = 0; let hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < wordIdx) lo = mid + 1; else hi = mid; }
    return lo;
  }

  paint(force = false) {
    const y = Math.round((this.guideY - this.pos) * 100) / 100;
    if (force || y !== this.painted) {
      this.painted = y;
      this.el.track.style.transform = `translate3d(0, ${y}px, 0)`;
    }
  }

  // ---------- engine ----------

  basePxPerSec() {
    const span = Math.max(1, this.maxPos - this.minPos);
    const words = Math.max(1, this.parsed.wordCount);
    return span / ((words / clamp(this.prefs.wpm, 30, 400)) * 60);
  }

  pxPerSec() {
    if (this.prefs.mode === 'timed') {
      const total = Math.max(5, this.prefs.timedSecs);
      const left = total - this.elapsed;
      const span = Math.max(1, this.maxPos - this.minPos);
      if (left <= 0.5) return span / total;
      return Math.max(0, this.maxPos - this.pos) / left;
    }
    return this.basePxPerSec();
  }

  remainingSecs() {
    const mode = this.prefs.mode;
    if (mode === 'timed') return Math.max(0, this.prefs.timedSecs - this.elapsed);
    const pending = this.pauses.reduce((t, x) => t + (!x.fired && x.y > this.pos ? x.secs : 0), 0);
    return Math.max(0, this.maxPos - this.pos) / Math.max(0.01, this.basePxPerSec()) + (mode === 'wpm' || mode === 'pace' ? pending : 0);
  }

  progress() {
    return clamp((this.pos - this.minPos) / Math.max(1, this.maxPos - this.minPos), 0, 1);
  }

  tick(ts) {
    if (!this.active) return;
    const dt = Math.min(0.1, Math.max(0, (ts - this.lastTs) / 1000));
    this.lastTs = ts;
    this.pollGamepad();
    if (this.recorder.recording && ts - this.lastCap > 150) { this.lastCap = ts; this.capLog.push([this.recorder.elapsed, this.pos]); }
    if (this.playing && !this.drag) {
      this.elapsed += dt;
      if (this.holdUntil) {
        if (ts >= this.holdUntil) { this.holdUntil = 0; this.setStatus(''); } else this.setStatus(`Pause ${Math.ceil((this.holdUntil - ts) / 1000)}s`);
      } else {
        const mode = this.prefs.mode;
        const prev = this.pos;
        if (mode === 'wpm' || mode === 'timed') this.pos += this.pxPerSec() * dt;
        else if (mode === 'pace') {
          const talking = this.meter ? this.meter.speaking(this.prefs.micSensitivity) : false;
          if (talking) this.pos += this.basePxPerSec() * dt;
          this.setStatus(this.meter ? (talking ? 'Listening' : 'Waiting for your voice') : '');
        } else if (mode === 'voice') {
          const target = this.voiceTarget();
          this.pos += (target - this.pos) * (1 - Math.exp(-dt * 5));
          if (this.cur >= this.spoken.length && Math.abs(target - this.pos) < 2) this.pos = this.maxPos;
        }
        if (mode === 'wpm' || mode === 'timed' || mode === 'pace') {
          for (const pz of this.pauses) {
            if (!pz.fired && prev <= pz.y && this.pos > pz.y) {
              pz.fired = true;
              this.pos = pz.y;
              if (pz.secs > 0) this.holdUntil = ts + pz.secs * 1000;
              else { this.pause(); this.setStatus('Paused at cue. Tap to continue'); }
              break;
            }
          }
          if (mode !== 'timed') {
            for (const m of this.speedMarks) {
              if (prev <= m.y && this.pos > m.y && this.prefs.wpm !== m.wpm) { this.prefs.wpm = m.wpm; this.updateHud(true); this.changedSoon(); }
            }
          }
        }
        if (this.pos >= this.maxPos) { this.pos = this.maxPos; this.finish(); }
      }
    }
    this.paint();
    if (ts - this.lastHud > 250) { this.lastHud = ts; this.updateHud(); }
    this.raf = requestAnimationFrame(this.tick);
  }

  voiceTarget() {
    if (!this.spoken.length) return this.pos;
    if (this.cur >= this.spoken.length) return this.maxPos - this.lineH * 0.5;
    return this.centers[this.spokenIdx[this.cur]];
  }

  onHeard(words) {
    if (!this.playing || this.prefs.mode !== 'voice') return;
    const next = followWords(this.spoken, this.cur, words);
    if (next !== this.cur) { this.cur = next; this.markSaid(); }
  }

  markSaid() {
    const upto = this.cur >= this.spoken.length ? this.wordEls.length : this.spokenIdx[this.cur];
    if (upto > this.saidTo) for (let i = this.saidTo; i < upto; i++) this.wordEls[i].classList.add('said');
    else for (let i = upto; i < this.saidTo; i++) this.wordEls[i].classList.remove('said');
    this.saidTo = upto;
  }

  // After a manual move, tell voice follow where we are now.
  resyncVoice() {
    if (!this.centers.length) { this.cur = 0; return; }
    this.cur = this.spokenCountBefore(this.wordAt(this.pos));
    this.markSaid();
  }

  resetPauses() {
    this.pauses.forEach((pz) => { if (pz.y > this.pos + 1) pz.fired = false; });
    if (this.holdUntil) { this.holdUntil = 0; this.setStatus(''); }
    this.syncSpeedCue();
  }

  // ---------- transport ----------

  play() {
    if (!this.active || this.playing || this.counting) return;
    if (this.pos >= this.maxPos - 1) this.restart(false);
    const n = this.prefs.countdown | 0;
    if (n > 0 && this.pos <= this.minPos + 2) this.countIn(n);
    else this.begin();
  }

  countIn(n) {
    this.counting = true;
    const el = this.el.countdown;
    el.hidden = false;
    let left = n;
    const step = () => {
      if (!this.counting) { el.hidden = true; return; }
      if (left <= 0) { el.hidden = true; this.counting = false; this.begin(); return; }
      el.textContent = left;
      el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
      left -= 1;
      this.countTimer = setTimeout(step, 1000);
    };
    step();
    this.updateHud(true);
    this.changed();
  }

  begin() {
    this.playing = true;
    this.lastTs = performance.now();
    this.setStatus('');
    this.startVoice();
    this.updateHud(true);
    this.showHud();
    this.changed();
  }

  pause() {
    if (this.counting) { this.counting = false; clearTimeout(this.countTimer); this.el.countdown.hidden = true; }
    if (!this.playing) { this.updateHud(true); this.changed(); return; }
    this.playing = false;
    this.holdUntil = 0;
    this.stopVoice();
    this.setStatus('');
    this.updateHud(true);
    this.showHud(true);
    this.changed();
  }

  toggle() { if (this.playing || this.counting) this.pause(); else this.play(); }

  restart(keepPlaying = true) {
    const was = this.playing;
    this.pos = this.minPos;
    this.elapsed = 0;
    this.jumped = false;
    this.holdUntil = 0;
    this.pauses.forEach((pz) => { pz.fired = false; });
    if (this.speedMarks.length && this.startWpm) this.prefs.wpm = this.startWpm;
    this.cur = 0;
    this.markSaid();
    this.paint(true);
    this.updateHud(true);
    if (!keepPlaying && was) this.pause();
    this.changed();
  }

  finish() {
    if (this.prefs.loop) { this.pos = this.minPos; this.elapsed = 0; this.pauses.forEach((pz) => { pz.fired = false; }); this.cur = 0; this.markSaid(); return; }
    const secs = this.elapsed;
    const words = this.parsed.wordCount;
    this.playing = false;
    this.stopVoice();
    this.setStatus('');
    this.updateHud(true);
    this.showHud(true);
    if (secs > 3 && words) toast(this.jumped ? `Finished in ${fmtDuration(secs)}` : `Finished in ${fmtDuration(secs)} · ${Math.round(words / (secs / 60))} words per minute`, { ms: 6000 });
    this.changed();
  }

  scrollBy(px) {
    this.jumped = true;
    this.pos = clamp(this.pos + px, this.minPos, this.maxPos);
    this.resetPauses();
    this.resyncVoice();
    this.paint();
    this.changedSoon();
  }

  nudge(lines) { this.scrollBy(lines * this.lineH); this.showHud(); }

  seek(ratio) {
    this.jumped = true;
    this.pos = this.minPos + clamp(ratio, 0, 1) * (this.maxPos - this.minPos);
    this.resetPauses();
    this.resyncVoice();
    this.paint(true);
    this.changed();
  }

  jumpSection(i) {
    if (this.sectionYs[i] == null) return;
    this.jumped = true;
    this.pos = clamp(this.sectionYs[i], this.minPos, this.maxPos);
    this.resetPauses();
    this.resyncVoice();
    this.paint(true);
    this.changed();
  }

  stepSpeed(dir) {
    const p = this.prefs;
    if (p.mode === 'timed') this.setPref('timedSecs', clamp(p.timedSecs + dir * -5, 10, 3 * 3600));
    else this.setPref('wpm', clamp(Math.round((p.wpm + dir * 5) / 5) * 5, 40, 400));
    this.showHud();
  }

  setPref(key, value) {
    this.prefs[key] = value;
    if (key === 'wpm' && !this.speedMarks.some((m) => m.y <= this.pos)) this.startWpm = value;
    this.persistPrefs();
    if (this.active) {
      if (['wpm', 'timedSecs', 'countdown', 'loop', 'micSensitivity', 'lang', 'showClock', 'estimateWpm'].includes(key)) this.updateHud(true);
      else this.applyPrefs();
    }
    this.changedSoon();
  }

  async setMode(mode) {
    if (!MODES[mode]) return;
    if (CONFIG.preview && (mode === 'voice' || mode === 'pace')) mode = 'wpm';
    if (mode === 'voice' && !speechSupported) {
      toast('This browser has no speech recognition, so "Scroll while I talk" is on instead.', { ms: 5000 });
      mode = 'pace';
    }
    const was = this.playing;
    if (was) this.stopVoice();
    this.prefs.mode = mode;
    this.persistPrefs();
    this.resyncVoice();
    if (was) this.startVoice();
    this.updateHud(true);
    this.changed();
  }

  cycleMirror() {
    const p = this.prefs;
    const state = (p.flipX ? 1 : 0) + (p.flipY ? 2 : 0);
    const next = (state + 1) % 4;
    p.flipX = !!(next & 1);
    p.flipY = !!(next & 2);
    this.persistPrefs();
    this.applyPrefs();
    toast(['Mirror off', 'Mirrored left-to-right (teleprompter glass)', 'Flipped top-to-bottom', 'Mirrored and flipped'][next]);
    this.changed();
  }

  // ---------- voice ----------

  async startVoice() {
    const mode = this.prefs.mode;
    this.stopVoice();
    if (mode === 'voice') {
      this.follower = new SpeechFollower({
        lang: this.prefs.lang || navigator.language || 'en-US',
        onWords: (w) => this.onHeard(w),
        onState: (s) => {
          this.voiceState = s;
          if (s === 'listening') this.setStatus('Listening');
          else if (s === 'denied') { this.setStatus(''); toast('Microphone or speech recognition is blocked. Allow it in Settings, or pick another scroll mode.', { ms: 6000 }); this.pause(); }
          else if (s === 'failed' || s === 'unavailable') { this.setStatus(''); this.voiceFallback(); }
          else if (s === 'unsupported') { toast('That language is not supported for voice follow on this device.'); this.pause(); }
        },
      });
      try { this.follower.start(); } catch (e) { toast(e.message); this.pause(); }
    } else if (mode === 'pace') {
      const meter = new LevelMeter();
      try {
        await meter.start(this.recorder.stream);
        if (this.playing && this.prefs.mode === 'pace') this.meter = meter; else meter.stop();
      } catch (e) {
        toast('Microphone access is needed for this mode. Allow it, or pick another scroll mode.', { ms: 6000 });
        this.pause();
      }
    }
  }

  stopVoice() {
    if (this.follower) { this.follower.stop(); this.follower = null; }
    if (this.meter) { this.meter.stop(); this.meter = null; }
    this.voiceState = '';
  }

  // ---------- camera & recording ----------

  async setCamera(on, { quiet = false } = {}) {
    const st = this.el.stage;
    if (!on) {
      await this.recorder.stopCamera(this.el.cam);
      st.classList.remove('has-cam');
      this.prefs.cameraOn = false;
      this.persistPrefs();
      this.applyPrefs();
      this.el.camera.classList.remove('on');
      return true;
    }
    if (!recordingSupported) { if (!quiet) toast('This browser cannot use the camera here.'); return false; }
    try {
      const info = await this.recorder.startCamera({ facing: this.prefs.facing, quality: this.prefs.quality, fps: this.prefs.fps, videoEl: this.el.cam });
      st.classList.add('has-cam');
      this.prefs.cameraOn = true;
      this.persistPrefs();
      this.applyPrefs();
      this.el.camera.classList.add('on');
      if (!quiet) toast(`Camera on · ${info.width}×${info.height}`);
      return true;
    } catch (e) {
      st.classList.remove('has-cam');
      this.prefs.cameraOn = false;
      this.persistPrefs();
      this.el.camera.classList.remove('on');
      if (!quiet) toast(e && e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow camera and microphone for this app in Settings.' : 'Could not start the camera.', { ms: 5000 });
      return false;
    }
  }

  async cameraMenu() {
    const p = this.prefs;
    const on = this.recorder.cameraOn;
    const choice = await menuSheet({
      title: 'Camera',
      items: [
        { label: on ? 'Turn camera off' : 'Turn camera on', icon: 'camera', value: 'toggle' },
        { label: p.facing === 'user' ? 'Switch to back camera' : 'Switch to front camera', icon: 'flipCam', value: 'flip' },
        { label: 'Record audio only', icon: 'mic', value: 'audio' },
        { sep: true },
        { label: '720p', value: 'q720', active: p.quality === '720' },
        { label: '1080p', value: 'q1080', active: p.quality === '1080' },
        { label: '4K (if the camera allows)', value: 'q2160', active: p.quality === '2160' },
        { label: '60 frames per second', value: 'fps', active: p.fps === 60 },
        ...(this.takes.length ? [{ sep: true }, { label: `Takes from this session (${this.takes.length})`, icon: 'list', value: 'takes' }] : []),
      ],
    });
    if (!choice) return;
    if (choice === 'toggle') await this.setCamera(!on);
    else if (choice === 'flip') { p.facing = p.facing === 'user' ? 'environment' : 'user'; this.persistPrefs(); await this.setCamera(true); }
    else if (choice === 'audio') await this.startAudioOnly();
    else if (choice === 'takes') this.showTakes();
    else if (choice === 'fps') { p.fps = p.fps === 60 ? 30 : 60; this.persistPrefs(); if (on) await this.setCamera(true); }
    else if (choice.startsWith('q')) { p.quality = choice.slice(1); this.persistPrefs(); if (on) await this.setCamera(true); }
  }

  async startAudioOnly() {
    try {
      await this.recorder.startMicOnly();
      this.el.stage.classList.remove('has-cam');
      this.applyPrefs();
      this.beginRecording();
    } catch (e) { toast('Microphone access was blocked.'); }
  }

  async toggleRecording() {
    if (this.recorder.recording) { await this.stopRecording(); return; }
    if (!recordingSupported) { toast('Recording is not supported in this browser.'); return; }
    if (!this.recorder.stream) {
      const ok = await this.setCamera(true, { quiet: true });
      if (!ok) { toast('Camera access is needed to record. Allow camera and microphone for this app.', { ms: 5000 }); return; }
    }
    this.beginRecording();
  }

  beginRecording() {
    try { this.recorder.start(); } catch (e) { toast(e.message || 'Could not start recording.'); return; }
    this.capLog = [[0, this.pos]];
    this.lastCap = performance.now();
    this.el.rec.classList.add('on');
    this.el.rec.innerHTML = icons.stop;
    this.el.stage.classList.add('recording');
    if (!this.playing) this.play();
    this.changed();
  }

  async stopRecording() {
    if (this.recorder.recording) this.capLog.push([this.recorder.elapsed, this.pos]);
    const srt = this.buildSrt();
    const take = await this.recorder.stop();
    this.el.rec.classList.remove('on');
    this.el.rec.innerHTML = icons.rec;
    this.el.stage.classList.remove('recording');
    this.el.recTime.textContent = '';
    this.pause();
    if (this.recorder.audioOnly) { await this.recorder.stopCamera(); if (this.prefs.cameraOn) this.setCamera(true, { quiet: true }); }
    if (take && take.blob.size) {
      take.name = `${(this.script.title || 'Take').replace(/[^\w\- ]+/g, '').trim() || 'Take'} ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')}.${take.ext}`;
      take.srt = srt;
      this.takes.unshift(take);
      this.showTakes(0);
    } else toast('Nothing was recorded.');
    this.changed();
  }

  showTakes(focus = null) {
    const mb = (n) => (n / 1048576 >= 10 ? Math.round(n / 1048576) : (n / 1048576).toFixed(1)) + ' MB';
    const html = this.takes.map((t, i) => `
      <div class="take" data-i="${i}">
        ${i === (focus ?? 0) ? (t.audioOnly ? `<audio controls src="${t.url}"></audio>` : `<video controls playsinline src="${t.url}"></video>`) : ''}
        <div class="row gap wrap">
          <div class="grow"><strong>${esc(t.name)}</strong><div class="muted">${fmtDuration(t.duration)} · ${mb(t.blob.size)}</div></div>
          <button type="button" class="btn primary" data-a="save">${icons.share}<span>Save</span></button>
          ${t.srt ? `<button type="button" class="btn" data-a="srt">${icons.cc}<span>Captions</span></button>` : ''}
          <button type="button" class="btn ghost" data-a="discard" aria-label="Discard take">${icons.trash}</button>
        </div>
      </div>`).join('') || '<p class="muted">No takes yet.</p>';
    const s = sheet({ title: 'Takes', html: `<p class="muted">Takes stay here until you close the app, so save the ones you want to keep. Captions are an .srt file timed from the scroll; check them in your editor.</p>${html}`, wide: true });
    s.body.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-a]');
      if (!btn) return;
      const i = +btn.closest('.take').dataset.i;
      const t = this.takes[i];
      if (btn.dataset.a === 'save') {
        const r = await shareOrDownload(t.blob, t.name, this.script.title || 'Take');
        if (r === 'downloaded') toast('Saved to your downloads.');
      } else if (btn.dataset.a === 'srt') {
        const r = await shareOrDownload(new Blob([t.srt], { type: 'application/x-subrip' }), t.name.replace(/\.[a-z0-9]+$/i, '.srt'), 'Captions');
        if (r === 'downloaded') toast('Captions saved to your downloads.');
      } else {
        URL.revokeObjectURL(t.url);
        this.takes.splice(i, 1);
        s.close();
        if (this.takes.length) this.showTakes();
      }
    });
  }


  // ---------- orientation ----------

  // Size, place and turn the text area. Rotation and both flips are applied to the text only, never the controls.
  applyOrientation() {
    const p = this.prefs;
    const st = this.el.stage;
    const W = st.clientWidth || window.innerWidth;
    const H = st.clientHeight || window.innerHeight;
    const a = clamp(p.areaHeight, 25, 100) / 100;
    const rot = (((p.rotate | 0) % 360) + 360) % 360;
    const side = rot === 90 || rot === 270;
    const w = side ? H : W;
    const h = (side ? W : H) * a;
    let cx = W / 2;
    let cy = h / 2;
    let box = [0, 0, W, h]; // the on-screen rectangle the text occupies
    if (rot === 180) { cy = H - h / 2; box = [0, H - h, W, h]; }
    else if (rot === 90) { cx = W - h / 2; cy = H / 2; box = [W - h, 0, h, H]; }
    else if (rot === 270) { cx = h / 2; cy = H / 2; box = [0, 0, h, H]; }
    const f = this.el.flip.style;
    f.width = `${w}px`;
    f.height = `${h}px`;
    f.left = `${cx - w / 2}px`;
    f.top = `${cy - h / 2}px`;
    f.right = 'auto';
    const sx = p.flipX ? -1 : 1;
    const sy = p.flipY ? -1 : 1;
    f.transform = rot === 0 && sx === 1 && sy === 1 ? '' : `rotate(${rot}deg) scale(${sx}, ${sy})`;
    const sh = this.el.shade.style;
    if (st.classList.contains('has-cam')) { sh.left = `${box[0]}px`; sh.top = `${box[1]}px`; sh.width = `${box[2]}px`; sh.height = `${box[3]}px`; sh.right = 'auto'; }
    else { sh.left = '0'; sh.top = '0'; sh.width = '100%'; sh.height = '100%'; }
    this.rot = rot;
  }

  // Convert a finger movement on the glass into movement along the script, whatever way round the text is.
  screenToScript(dx, dy) {
    const r = ((this.rot || 0) * Math.PI) / 180;
    return (dx * -Math.sin(r) + dy * Math.cos(r)) * (this.prefs.flipY ? -1 : 1);
  }

  orientationText() {
    const p = this.prefs;
    const bits = [];
    if (p.flipX) bits.push('mirrored left-to-right');
    if (p.flipY) bits.push('flipped top-to-bottom');
    if (p.rotate) bits.push(`rotated ${p.rotate}°`);
    return bits.length ? `Text is ${bits.join(' and ')}` : 'Text is the normal way round';
  }

  toggleFlip(key) {
    this.prefs[key] = !this.prefs[key];
    this.persistPrefs();
    this.applyPrefs();
    toast(this.orientationText());
    this.showHud(true);
    this.changed();
  }

  rotateStep() {
    this.prefs.rotate = ((this.prefs.rotate | 0) + 90) % 360;
    this.persistPrefs();
    this.applyPrefs();
    toast(this.orientationText());
    this.showHud(true);
    this.changed();
  }

  async toggleVoice() {
    if (CONFIG.preview) {
      toast('Voice follow listens through the microphone, and this preview inside Claude blocks the microphone. In the full app, tap Voice, press play and the script follows your words.', { ms: 7000 });
      return;
    }
    const p = this.prefs;
    if (p.mode === 'voice' || p.mode === 'pace') {
      await this.setMode(p.lastMode && p.lastMode !== 'voice' && p.lastMode !== 'pace' ? p.lastMode : 'wpm');
      toast('Voice follow is off.');
    } else {
      p.lastMode = p.mode;
      await this.setMode('voice');
      if (this.prefs.mode === 'voice') toast('Voice follow is on. Press play and start reading. The script keeps up with you and waits if you go off script.', { ms: 5000 });
    }
    this.showHud(true);
  }

  // Speech recognition would not run here: keep the reader hands-free with the microphone-level mode instead.
  voiceFallback() {
    if (this.prefs.mode !== 'voice') return;
    this.prefs.mode = 'pace';
    this.persistPrefs();
    this.updateHud(true);
    toast('Word-by-word voice follow is not available here, so the script now scrolls while you talk and waits when you stop. On iPhone and iPad, word tracking may need Telepathic opened in Safari rather than from the Home Screen.', { ms: 9000 });
    if (this.playing) this.startVoice();
    this.changed();
  }

  updateTiles() {
    const p = this.prefs;
    const e = this.el;
    e.mirror.classList.toggle('on', !!p.flipX);
    e.flipv.classList.toggle('on', !!p.flipY);
    e.rot.classList.toggle('on', !!p.rotate);
    e.rot.querySelector('span').textContent = p.rotate ? `${p.rotate}°` : 'Rotate';
    e.voice.classList.toggle('on', p.mode === 'voice' || p.mode === 'pace');
    e.voice.querySelector('span').textContent = p.mode === 'pace' ? 'Talk' : 'Voice';
    e.camera.classList.toggle('on', this.recorder.cameraOn);
  }

  // ---------- speed cues, game controller, captions ----------

  // After a manual move, use the pace of the last [speed] cue above the guide.
  syncSpeedCue() {
    if (!this.speedMarks.length) return;
    let wpm = this.startWpm;
    for (const m of this.speedMarks) if (m.y <= this.pos + 0.5) wpm = m.wpm;
    if (wpm && wpm !== this.prefs.wpm) { this.prefs.wpm = wpm; this.updateHud(true); }
  }

  pollGamepad() {
    if (!navigator.getGamepads) return;
    let pad = null;
    try { for (const g of navigator.getGamepads()) if (g && g.connected) { pad = g; break; } } catch (e) { return; }
    if (!pad) { this.padPrev = null; return; }
    const now = Array.from(pad.buttons, (b) => !!(b && b.pressed));
    const prev = this.padPrev || now.map(() => false);
    this.padPrev = now;
    const hit = (i) => now[i] && !prev[i];
    if (hit(0) || hit(9)) this.toggle();
    if (hit(3)) this.restart();
    if (hit(12)) this.stepSpeed(1);
    if (hit(13)) this.stepSpeed(-1);
    if (hit(14)) this.nudge(-3);
    if (hit(15)) this.nudge(3);
    if (hit(4)) this.jumpRelativeSection(-1);
    if (hit(5)) this.jumpRelativeSection(1);
  }

  // Captions for a take, timed from where the script was while recording.
  buildSrt() {
    const log = this.capLog || [];
    const els = this.wordEls;
    if (log.length < 2 || !els.length) return '';
    const lineH = this.lineH;
    const end = log[log.length - 1][0];
    const timeAt = (y) => {
      if (y <= log[0][1]) return y >= log[0][1] - lineH ? 0 : -1; // -1: read before the recording began
      for (let i = 1; i < log.length; i++) {
        if (log[i][1] >= y) {
          const [t0, p0] = log[i - 1];
          const [t1, p1] = log[i];
          return p1 > p0 ? t0 + (t1 - t0) * clamp((y - p0) / (p1 - p0), 0, 1) : t1;
        }
      }
      return Infinity; // never reached
    };
    // spread the words of each line across the time that line spends at the guide
    const when = new Array(els.length);
    let i = 0;
    while (i < els.length) {
      let j = i;
      while (j + 1 < els.length && Math.abs(this.centers[j + 1] - this.centers[i]) < 1) j++;
      const n = j - i + 1;
      for (let k = i; k <= j; k++) when[k] = timeAt(this.centers[i] - lineH / 2 + ((k - i) / n) * lineH);
      i = j + 1;
    }
    const cues = [];
    let cur = null;
    for (let k = 0; k < els.length; k++) {
      const word = els[k].textContent;
      if (!this.parsed.norms[k]) { if (cur) cur.text += ` ${word}`; continue; }
      const para = els[k].closest('p');
      if (cur && (cur.para !== para || cur.text.length + word.length > 38)) { cues.push(cur); cur = null; }
      if (!cur) cur = { start: when[k], text: word, para };
      else cur.text += ` ${word}`;
      if (/[.!?]["')\]]?$/.test(word) && cur.text.length >= 16) { cues.push(cur); cur = null; }
    }
    if (cur) cues.push(cur);
    const live = cues.filter((c) => c.start >= 0 && isFinite(c.start));
    const stamp = (t) => {
      const ms = Math.max(0, Math.round(t * 1000));
      const pad = (v, l = 2) => String(v).padStart(l, '0');
      return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
    };
    return live.map((c, n) => {
      const next = live[n + 1] ? live[n + 1].start : end;
      const stop = Math.max(c.start + 0.7, Math.min(next, c.start + 7));
      return `${n + 1}\n${stamp(c.start)} --> ${stamp(stop)}\n${c.text}\n`;
    }).join('\n');
  }

  // ---------- pointer, keyboard ----------

  onPointerDown(ev) {
    if (!this.active || ev.target.closest('.hud-bar')) return;
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    try { this.el.stage.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    if (this.pointers.size === 1) {
      this.drag = null;
      this.press = { y0: ev.clientY, x0: ev.clientX, last: ev.clientY, lastX: ev.clientX, t: performance.now(), moved: false, pinched: false };
    } else if (this.pointers.size === 2) {
      const [a, b] = Array.from(this.pointers.values());
      this.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, f0: this.prefs.fontSize };
      if (this.press) this.press.pinched = true;
      this.drag = null;
    }
  }

  onPointerMove(ev) {
    if (!this.active || !this.pointers.has(ev.pointerId)) return;
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = Array.from(this.pointers.values());
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const size = Math.round(clamp(this.pinch.f0 * (d / this.pinch.d0), 18, 220));
      if (size !== this.prefs.fontSize) { this.prefs.fontSize = size; this.persistPrefs(); this.applyPrefs(); }
      return;
    }
    const pr = this.press;
    if (!pr || pr.pinched) return;
    if (!pr.moved && Math.hypot(ev.clientY - pr.y0, ev.clientX - pr.x0) > 9) { pr.moved = true; this.drag = pr; pr.last = ev.clientY; pr.lastX = ev.clientX; }
    if (pr.moved) {
      const dx = ev.clientX - pr.lastX;
      const dy = ev.clientY - pr.last;
      pr.last = ev.clientY;
      pr.lastX = ev.clientX;
      this.pos = clamp(this.pos - this.screenToScript(dx, dy), this.minPos, this.maxPos);
      this.paint();
    }
  }

  onPointerUp(ev, cancelled = false) {
    if (!this.pointers.has(ev.pointerId)) return;
    this.pointers.delete(ev.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size > 0) return;
    const pr = this.press;
    this.press = null;
    if (!pr) return;
    if (pr.moved) {
      this.drag = null;
      this.jumped = true;
      this.lastTs = performance.now();
      this.resetPauses();
      this.resyncVoice();
      this.changedSoon();
    } else if (!cancelled && !pr.pinched && performance.now() - pr.t < 600) {
      this.toggle();
    }
  }

  onKey(ev) {
    if (!this.active || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (document.querySelector('.sheet-backdrop') && ev.key !== 'Escape') return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const k = ev.key;
    let used = true;
    if (k === ' ' || k === 'Enter' || k === 'k' || k === 'K' || k === 'PageDown' || k === 'MediaPlayPause') this.toggle();
    else if (k === 'ArrowUp') this.stepSpeed(1);
    else if (k === 'ArrowDown') this.stepSpeed(-1);
    else if (k === 'ArrowLeft' || k === 'PageUp') this.nudge(-3);
    else if (k === 'ArrowRight') this.nudge(3);
    else if (k === 'Home' || k === 'r' || k === 'R') this.restart();
    else if (k === 'End') this.seek(1);
    else if (k === '+' || k === '=') this.setPref('fontSize', clamp(this.prefs.fontSize + 4, 18, 220));
    else if (k === '-' || k === '_') this.setPref('fontSize', clamp(this.prefs.fontSize - 4, 18, 220));
    else if (k === 'm' || k === 'M') this.toggleFlip('flipX');
    else if (k === 'v' || k === 'V') this.toggleFlip('flipY');
    else if (k === 'o' || k === 'O') this.rotateStep();
    else if (k === 'f' || k === 'F') this.toggleFullscreen();
    else if (k === '[') this.jumpRelativeSection(-1);
    else if (k === ']') this.jumpRelativeSection(1);
    else if (k === 'Escape') { const open = document.querySelector('.sheet-backdrop'); if (open) open.dispatchEvent(new PointerEvent('pointerdown')); else this.close(); }
    else used = false;
    if (used) ev.preventDefault();
  }

  jumpRelativeSection(dir) {
    if (!this.sectionYs.length) return;
    let i = this.sectionYs.findIndex((y) => y > this.pos + 2);
    if (i === -1) i = this.sectionYs.length;
    const target = dir > 0 ? i : i - 2;
    this.jumpSection(clamp(target, 0, this.sectionYs.length - 1));
  }

  toggleFullscreen() {
    const root = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
  }

  // ---------- HUD ----------

  showHud(sticky = false) {
    const hud = this.el.hud;
    hud.classList.remove('away');
    clearTimeout(this.hudTimer);
    if (this.playing && !sticky) this.hudTimer = setTimeout(() => { if (this.playing && !document.querySelector('.sheet-backdrop')) hud.classList.add('away'); }, 2600);
    else if (this.playing) this.hudTimer = setTimeout(() => { if (this.playing) hud.classList.add('away'); }, 2600);
  }

  setStatus(text) {
    if (this.statusText === text) return;
    this.statusText = text;
    this.el.status.textContent = text;
    this.el.status.hidden = !text;
  }

  speedLabel() {
    const p = this.prefs;
    if (p.mode === 'timed') return fmtDuration(p.timedSecs);
    if (p.mode === 'voice') return 'Voice';
    if (p.mode === 'manual') return 'Manual';
    return `${p.wpm}`;
  }

  updateHud(full = false) {
    const e = this.el;
    const p = this.prefs;
    e.elapsed.textContent = fmtDuration(this.elapsed);
    e.remaining.textContent = p.showClock
      ? new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : `-${fmtDuration(this.remainingSecs())}`;
    e.progress.style.transform = `scaleX(${this.progress().toFixed(4)})`;
    if (this.recorder.recording) e.recTime.textContent = `REC ${fmtDuration(this.recorder.elapsed)}`;
    if (!full) return;
    e.play.innerHTML = this.playing || this.counting ? icons.pause : icons.play;
    e.play.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
    e.speed.innerHTML = `<strong>${esc(this.speedLabel())}</strong><small>${p.mode === 'wpm' || p.mode === 'pace' ? 'wpm' : p.mode === 'timed' ? 'length' : 'mode'}</small>`;
    const stepping = p.mode === 'wpm' || p.mode === 'pace' || p.mode === 'timed';
    e.minus.disabled = !stepping;
    e.plus.disabled = !stepping;
    e.mode.querySelector('span').textContent = MODES[p.mode].short;
    this.updateTiles();
    e.stage.style.setProperty('--hud-h', `${e.hud.querySelector('.hud-bottom').offsetHeight}px`);
    e.stage.classList.toggle('playing', this.playing);
    e.stage.classList.toggle('dim-spoken', !!p.dimSpoken && p.mode === 'voice');
  }

  async chooseMode() {
    const p = this.prefs;
    const choice = await menuSheet({
      title: 'How should it scroll?',
      items: modeEntries().map(([k, m]) => ({ label: m.label, detail: '', value: k, active: p.mode === k })),
    });
    if (choice) { await this.setMode(choice); toast(MODES[this.prefs.mode].hint, { ms: 3800 }); }
  }

  async chooseSection() {
    const secs = this.parsed.sections;
    if (!secs.length) { toast('Add lines that start with # to create sections you can jump to.'); return; }
    const choice = await menuSheet({ title: 'Jump to section', items: secs.map((s, i) => ({ label: s.title, value: i })) });
    if (choice !== null && choice !== undefined) this.jumpSection(choice);
  }

  openDisplaySheet() {
    const p = this.prefs;
    const range = (key, label, min, max, step, unit = '') => `
      <label class="ctl"><span class="ctl-label">${label}<output data-out="${key}">${p[key]}${unit}</output></span>
      <input type="range" data-key="${key}" data-unit="${unit}" min="${min}" max="${max}" step="${step}" value="${p[key]}"></label>`;
    const seg = (key, label, options) => `
      <div class="ctl"><span class="ctl-label">${label}</span>
      <div class="seg" data-seg="${key}">${options.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(p[key]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div></div>`;
    const toggle = (key, label, hint = '') => `
      <label class="ctl switch"><span class="ctl-label">${label}${hint ? `<small>${hint}</small>` : ''}</span>
      <input type="checkbox" data-key="${key}" ${p[key] ? 'checked' : ''}><i></i></label>`;
    const langs = [['', 'Device language'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['es-ES', 'Spanish (Spain)'], ['es-MX', 'Spanish (Mexico)'],
      ['fr-FR', 'French'], ['de-DE', 'German'], ['it-IT', 'Italian'], ['pt-BR', 'Portuguese (Brazil)'], ['nl-NL', 'Dutch'], ['pl-PL', 'Polish'],
      ['hi-IN', 'Hindi'], ['ar-SA', 'Arabic'], ['tr-TR', 'Turkish'], ['ru-RU', 'Russian'], ['id-ID', 'Indonesian'], ['tl-PH', 'Filipino']];
    const html = `
      <div class="group"><h3>Scrolling</h3>
        ${seg('mode', 'Mode', modeEntries().map(([k, m]) => [k, m.short]))}
        ${range('wpm', 'Reading pace', 60, 300, 5, ' wpm')}
        <label class="ctl"><span class="ctl-label">Finish-on-time length<output data-out="timedSecs">${fmtDuration(p.timedSecs)}</output></span>
          <input type="range" data-key="timedSecs" data-fmt="time" min="15" max="1800" step="15" value="${p.timedSecs}"></label>
        ${seg('countdown', 'Countdown before start', [[0, 'Off'], [3, '3s'], [5, '5s'], [10, '10s']])}
        ${toggle('loop', 'Loop at the end')}
      </div>
      <div class="group"><h3>Text</h3>
        ${range('fontSize', 'Size', 18, 220, 1, ' px')}
        ${range('lineHeight', 'Line spacing', 1, 2.2, 0.05)}
        ${range('width', 'Text width', 35, 100, 1, '%')}
        ${seg('font', 'Typeface', Object.entries(FONTS).map(([k, f]) => [k, f.label]))}
        ${seg('align', 'Alignment', [['left', 'Left'], ['center', 'Centre']])}
        ${seg('weight', 'Weight', [[400, 'Regular'], [600, 'Semibold'], [800, 'Heavy']])}
        ${toggle('caps', 'ALL CAPS')}
      </div>
      <div class="group"><h3>Orientation</h3>
        ${seg('rotate', 'Rotate', [[0, 'Upright'], [90, '90°'], [180, '180°'], [270, '270°']])}
        ${toggle('flipX', 'Mirror left-to-right', 'For beam-splitter teleprompter glass')}
        ${toggle('flipY', 'Flip top-to-bottom', 'For rigs that mount the screen upside down')}
      </div>
      <div class="group"><h3>Reading guide</h3>
        ${seg('guide', 'Style', [['none', 'None'], ['arrow', 'Arrow'], ['line', 'Line'], ['band', 'Focus band']])}
        ${range('guidePos', 'Guide position from top', 10, 80, 1, '%')}
        ${range('areaHeight', 'Text area height', 25, 100, 5, '%')}
        <p class="muted small">Shrink the text area to keep your eyes close to the camera lens.</p>
      </div>
      <div class="group"><h3>Colours</h3>
        ${seg('theme', 'Theme', Object.entries(THEMES).map(([k, t]) => [k, t.label]))}
        <div class="row gap" data-custom ${p.theme === 'custom' ? '' : 'hidden'}>
          <label class="swatch">Text<input type="color" data-key="textColor" value="${p.textColor}"></label>
          <label class="swatch">Background<input type="color" data-key="bgColor" value="${p.bgColor}"></label>
        </div>
        ${range('overlayOpacity', 'Background over camera', 0, 100, 5, '%')}
      </div>
      <div class="group"><h3>Voice</h3>
        <label class="ctl"><span class="ctl-label">Spoken language</span>
          <select data-key="lang">${langs.map(([v, l]) => `<option value="${v}" ${p.lang === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${range('micSensitivity', 'Microphone sensitivity', 0, 100, 5)}
        ${toggle('dimSpoken', 'Dim words I have said')}
        ${toggle('showClock', 'Show clock instead of time left')}
      </div>`;
    const s = sheet({ title: 'Display & scrolling', html, clear: true });
    this.showHud(true);
    s.body.addEventListener('input', (ev) => {
      const t = ev.target;
      const key = t.dataset.key;
      if (!key) return;
      let v;
      if (t.type === 'checkbox') v = t.checked;
      else if (t.type === 'range') v = parseFloat(t.value);
      else v = t.value;
      const out = s.body.querySelector(`[data-out="${key}"]`);
      if (out) out.textContent = t.dataset.fmt === 'time' ? fmtDuration(v) : `${v}${t.dataset.unit || ''}`;
      if (key === 'lang') { this.setPref(key, v); if (this.playing && p.mode === 'voice') this.startVoice(); } else this.setPref(key, v);
    });
    s.body.addEventListener('click', (ev) => {
      const b = ev.target.closest('.seg button');
      if (!b) return;
      const key = b.parentElement.dataset.seg;
      let v = b.dataset.v;
      if (key === 'countdown' || key === 'weight' || key === 'rotate') v = Number(v);
      $$('button', b.parentElement).forEach((x) => x.classList.toggle('on', x === b));
      if (key === 'mode') {
        this.setMode(v).then(() => {
          $$('button', b.parentElement).forEach((x) => x.classList.toggle('on', x.dataset.v === this.prefs.mode));
        });
      } else {
        this.setPref(key, v);
        if (key === 'theme') s.body.querySelector('[data-custom]').hidden = v !== 'custom';
      }
    });
  }

  // ---------- remote control ----------

  changed() { if (this.onChange) this.onChange(true); }
  changedSoon() { if (this.onChange) this.onChange(false); }

  state() {
    if (!this.active) return { open: false };
    const p = this.prefs;
    return {
      open: true,
      scriptId: this.script.id,
      title: this.script.title || 'Untitled',
      playing: this.playing || this.counting,
      progress: +this.progress().toFixed(4),
      elapsed: Math.round(this.elapsed),
      remaining: Math.round(this.remainingSecs()),
      mode: p.mode,
      wpm: p.wpm,
      timedSecs: p.timedSecs,
      fontSize: p.fontSize,
      flipX: !!p.flipX,
      flipY: !!p.flipY,
      rotate: p.rotate | 0,
      recording: this.recorder.recording,
      sections: this.parsed.sections.map((s) => s.title).slice(0, 60),
      status: this.statusText || '',
    };
  }

  command(action, value) {
    if (!this.active) return;
    switch (action) {
      case 'toggle': this.toggle(); break;
      case 'play': this.play(); break;
      case 'pause': this.pause(); break;
      case 'restart': this.restart(); break;
      case 'nudge': this.nudge(Number(value) || 0); break;
      case 'seek': this.seek(Number(value) || 0); break;
      case 'section': this.jumpSection(Number(value) || 0); break;
      case 'speed': this.stepSpeed(Number(value) > 0 ? 1 : -1); break;
      case 'wpm': this.setPref('wpm', clamp(Number(value) || 140, 40, 400)); break;
      case 'font': this.setPref('fontSize', clamp(this.prefs.fontSize + (Number(value) || 0), 18, 220)); break;
      case 'mode': this.setMode(String(value)); break;
      case 'mirror': this.cycleMirror(); break;
      case 'flipx': this.toggleFlip('flipX'); break;
      case 'flipy': this.toggleFlip('flipY'); break;
      case 'rotate': this.rotateStep(); break;
      case 'voice': this.toggleVoice(); break;
      case 'record': this.toggleRecording(); break;
      case 'close': this.close(); break;
      default: break;
    }
  }
}

export const prompter = new Prompter();
