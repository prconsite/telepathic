// Camera preview and recording. The recording contains only the camera and microphone, never the script text.

const QUALITY = {
  720: { width: 1280, height: 720, bits: 5_000_000 },
  1080: { width: 1920, height: 1080, bits: 10_000_000 },
  2160: { width: 3840, height: 2160, bits: 30_000_000 },
};

function pickMime(video) {
  if (!window.MediaRecorder) return null;
  const options = video
    ? ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  return options.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export const recordingSupported = typeof window !== 'undefined' && !!window.MediaRecorder && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

export class Recorder {
  constructor() {
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.startedAt = 0;
    this.mime = '';
    this.audioOnly = false;
  }

  get cameraOn() { return !!this.stream && this.stream.getVideoTracks().length > 0; }
  get recording() { return !!this.rec && this.rec.state !== 'inactive'; }
  get elapsed() { return this.recording ? (performance.now() - this.startedAt) / 1000 : 0; }

  async startCamera({ facing = 'user', quality = '1080', fps = 30, videoEl }) {
    await this.stopCamera();
    const q = QUALITY[quality] || QUALITY[1080];
    const portrait = window.innerHeight > window.innerWidth;
    const constraints = {
      audio: { echoCancellation: true, noiseSuppression: true },
      video: {
        facingMode: facing,
        width: { ideal: portrait ? q.height : q.width },
        height: { ideal: portrait ? q.width : q.height },
        frameRate: { ideal: fps },
      },
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      if (e && (e.name === 'OverconstrainedError' || e.name === 'NotReadableError')) {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: facing } });
      } else throw e;
    }
    this.audioOnly = false;
    this.quality = quality;
    if (videoEl) {
      videoEl.srcObject = this.stream;
      videoEl.classList.toggle('selfie', facing === 'user');
      await videoEl.play().catch(() => {});
    }
    const s = this.stream.getVideoTracks()[0].getSettings();
    return { width: s.width, height: s.height };
  }

  async startMicOnly() {
    await this.stopCamera();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.audioOnly = true;
  }

  async stopCamera(videoEl) {
    if (this.recording) await this.stop();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (videoEl) videoEl.srcObject = null;
  }

  start() {
    if (!this.stream) throw new Error('Camera is off');
    const mime = pickMime(!this.audioOnly);
    if (mime === null) throw new Error('Recording is not supported in this browser.');
    const q = QUALITY[this.quality] || QUALITY[1080];
    const opts = this.audioOnly ? { audioBitsPerSecond: 128000 } : { videoBitsPerSecond: q.bits, audioBitsPerSecond: 128000 };
    if (mime) opts.mimeType = mime;
    this.rec = new MediaRecorder(this.stream, opts);
    this.mime = this.rec.mimeType || mime || (this.audioOnly ? 'audio/mp4' : 'video/mp4');
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
    this.startedAt = performance.now();
  }

  // Resolves with the finished take.
  stop() {
    return new Promise((resolve) => {
      if (!this.recording) return resolve(null);
      const duration = (performance.now() - this.startedAt) / 1000;
      const rec = this.rec;
      rec.onstop = () => {
        const type = (this.mime || '').split(';')[0] || (this.audioOnly ? 'audio/mp4' : 'video/mp4');
        const blob = new Blob(this.chunks, { type });
        this.chunks = [];
        this.rec = null;
        const ext = type.includes('webm') ? 'webm' : this.audioOnly ? 'm4a' : 'mp4';
        resolve({ blob, type, ext, duration, audioOnly: this.audioOnly, url: URL.createObjectURL(blob) });
      };
      try { rec.stop(); } catch (e) { this.rec = null; resolve(null); }
    });
  }
}
