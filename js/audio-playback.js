// Frontend for the "Audio Playback" node (Python node_id "m5_AudioPlayback").
//
// The node returns ui = { playback_audio: [{ filename, subfolder, type }] } from
// its execute(): a FLAC rendering of its input audio, written to ComfyUI's temp
// directory.
//
// The audio is fetched and decoded with the Web Audio API, which gives us both
// the samples for the waveform and sample-accurate playback. The widget draws a
// single waveform on a <canvas> (multichannel audio is shown as the envelope of
// all its channels), with the played portion highlighted and a playhead that can
// be clicked or dragged to scrub. The "show spectrogram" button adds a
// log-frequency spectrogram of the mono mixdown beneath the waveform, in the
// same canvas, so the playhead and scrubbing span both.
//
// Absolute imports of the app API ("/scripts/...") are used for the same
// routing reasons as score-viewer.js.

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// Peak buckets computed once per decoded buffer. Drawing aggregates these to
// the canvas width, so resizing never has to rescan the raw samples.
const PEAK_BUCKETS = 4096;
const CONTROLS_HEIGHT = 30;
const MIN_WAVEFORM_HEIGHT = 60;

// Spectrogram analysis: an FFT_SIZE-point Hann-windowed STFT sampled at up to
// SPEC_COLUMNS evenly spaced times, resampled onto SPEC_ROWS log-spaced
// frequencies from SPEC_MIN_HZ to Nyquist, and shown over a SPEC_RANGE_DB range
// below the loudest bin. Like the peaks, it is computed once per buffer and
// only scaled when drawn.
const FFT_SIZE = 4096;
const SPEC_COLUMNS = 1024;
const SPEC_ROWS = 256;
const SPEC_MIN_HZ = 30;
const SPEC_RANGE_DB = 80;
// Spectrogram height relative to the waveform's when both are shown; the node
// grows/shrinks by this much on toggle so the waveform keeps its size.
const SPEC_HEIGHT_RATIO = 1.2;
const REGION_GAP = 2; // px (CSS) between the waveform and the spectrogram
const SPEC_TICKS_HZ = [100, 1000, 10000];

const COLORS = {
  background: "#1b1b1b",
  lane: "#262626",
  centerLine: "#3a3a3a",
  unplayed: "#6b7a8f",
  played: "#4fa3ff",
  playhead: "#ffffff",
  hover: "rgba(255, 255, 255, 0.35)",
  text: "#9a9a9a",
};

// Magma-like colormap stops (quiet -> loud), expanded into a 256-entry LUT.
const SPEC_COLOR_STOPS = [
  [0, 0, 4],
  [59, 15, 112],
  [140, 41, 129],
  [222, 73, 104],
  [254, 159, 109],
  [252, 253, 191],
];
const SPEC_LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  const segments = SPEC_COLOR_STOPS.length - 1;
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * segments;
    const s = Math.min(Math.floor(t), segments - 1);
    const f = t - s;
    for (let k = 0; k < 3; k++) {
      const a = SPEC_COLOR_STOPS[s][k];
      const b = SPEC_COLOR_STOPS[s + 1][k];
      lut[i * 3 + k] = a + (b - a) * f;
    }
  }
  return lut;
})();

// One AudioContext shared by every Audio Playback node. Created lazily, since
// browsers only allow audio to start after a user gesture.
let audioContext = null;
function getAudioContext() {
  if (!audioContext) audioContext = new AudioContext();
  return audioContext;
}

function viewURL({ filename, subfolder = "", type }) {
  const params = new URLSearchParams({ filename, subfolder, type });
  // Temp files can be rewritten under the same name; don't let the browser
  // serve a stale copy.
  if (type === "temp") params.set("rand", String(Math.random()));
  return api.apiURL(`/view?${params}`);
}

function formatTime(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
}

// Min/max over PEAK_BUCKETS equal slices of the buffer, taken across all
// channels so multichannel audio draws as one waveform.
function computePeaks(buffer) {
  const buckets = Math.min(PEAK_BUCKETS, buffer.length) || 1;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let b = 0; b < buckets; b++) {
      const start = Math.floor((b * data.length) / buckets);
      const end = Math.max(start + 1, Math.floor(((b + 1) * data.length) / buckets));
      let lo = min[b];
      let hi = max[b];
      for (let i = start; i < end && i < data.length; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[b] = lo;
      max[b] = hi;
    }
  }
  return { min, max };
}

// In-place iterative radix-2 FFT of (re, im); length must be a power of two.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let uRe = 1;
      let uIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tRe = re[b] * uRe - im[b] * uIm;
        const tIm = re[b] * uIm + im[b] * uRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const next = uRe * wRe - uIm * wIm;
        uIm = uRe * wIm + uIm * wRe;
        uRe = next;
      }
    }
  }
}

// Render the spectrogram of the buffer's mono mixdown into a small canvas
// (one pixel per analysis column x log-frequency row, high frequencies at the
// top), which draw() then scales into place.
function computeSpectrogram(buffer) {
  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }

  const columns = Math.max(1, Math.min(SPEC_COLUMNS, Math.ceil(length / 256)));
  const bins = FFT_SIZE / 2;
  const nyquist = buffer.sampleRate / 2;
  const minHz = Math.min(SPEC_MIN_HZ, nyquist / 2);
  const hann = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }
  // Fractional FFT bin sampled by each output row, lowest frequency last.
  const rowBin = new Float32Array(SPEC_ROWS);
  for (let y = 0; y < SPEC_ROWS; y++) {
    const hz = minHz * Math.pow(nyquist / minHz, 1 - y / (SPEC_ROWS - 1));
    rowBin[y] = Math.min(bins - 1, (hz / nyquist) * bins);
  }

  const db = new Float32Array(columns * SPEC_ROWS);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const mag = new Float32Array(bins);
  let peakDb = -Infinity;
  for (let x = 0; x < columns; x++) {
    const center = Math.floor(((x + 0.5) * length) / columns);
    const start = center - FFT_SIZE / 2;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < length ? mono[s] * hann[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) mag[k] = Math.hypot(re[k], im[k]);
    for (let y = 0; y < SPEC_ROWS; y++) {
      const k = Math.floor(rowBin[y]);
      const f = rowBin[y] - k;
      const m = mag[k] * (1 - f) + mag[Math.min(k + 1, bins - 1)] * f;
      const v = 20 * Math.log10(m + 1e-12);
      db[y * columns + x] = v;
      if (v > peakDb) peakDb = v;
    }
  }

  const image = new ImageData(columns, SPEC_ROWS);
  for (let i = 0; i < db.length; i++) {
    const t = (db[i] - (peakDb - SPEC_RANGE_DB)) / SPEC_RANGE_DB;
    const c = Math.round(Math.max(0, Math.min(1, t)) * 255) * 3;
    image.data[i * 4] = SPEC_LUT[c];
    image.data[i * 4 + 1] = SPEC_LUT[c + 1];
    image.data[i * 4 + 2] = SPEC_LUT[c + 2];
    image.data[i * 4 + 3] = 255;
  }
  const canvas = document.createElement("canvas");
  canvas.width = columns;
  canvas.height = SPEC_ROWS;
  canvas.getContext("2d").putImageData(image, 0, 0);
  // Height fraction (from the top) of each labelled frequency within range.
  const ticks = SPEC_TICKS_HZ.filter((hz) => hz > minHz && hz < nyquist).map((hz) => ({
    label: hz >= 1000 ? `${hz / 1000}k` : `${hz}`,
    frac: 1 - Math.log(hz / minHz) / Math.log(nyquist / minHz),
  }));
  return { canvas, ticks };
}

// All per-node state and behavior: loading, drawing, transport and scrubbing.
class Player {
  constructor(node) {
    this.node = node;
    this.buffer = null;
    this.peaks = null;
    this.source = null; // the AudioBufferSourceNode while playing
    this.playing = false;
    this.offset = 0; // position (s) when paused, or where playback started
    this.startedAt = 0; // audioContext.currentTime when playback started
    this.hoverX = null;
    this.scrubbing = false;
    this.resumeAfterScrub = false;
    this.loadToken = 0; // discards stale loads that finish out of order
    this.rafId = null;
    this.layers = null; // pre-rendered { unplayed, played } waveform canvases
    this.showSpectrogram = false;
    this.spectrogram = null; // { canvas, ticks } for the current buffer, made on demand
    this.buildDOM();
  }

  buildDOM() {
    const root = document.createElement("div");
    Object.assign(root.style, {
      display: "flex",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      boxSizing: "border-box",
      background: COLORS.background,
      borderRadius: "4px",
      overflow: "hidden",
      userSelect: "none",
    });

    // The canvas is absolutely positioned inside a flex wrapper so the size of
    // its backing store (which we set from its CSS box) can't feed back into
    // the flex layout and make it grow.
    const canvasWrap = document.createElement("div");
    Object.assign(canvasWrap.style, {
      flex: "1 1 0",
      minHeight: "0",
      position: "relative",
    });
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      cursor: "pointer",
      touchAction: "none",
    });
    canvasWrap.append(canvas);

    const controls = document.createElement("div");
    Object.assign(controls.style, {
      flex: `0 0 ${CONTROLS_HEIGHT}px`,
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "0 8px",
      font: "12px monospace",
      color: COLORS.text,
    });

    const playButton = document.createElement("button");
    Object.assign(playButton.style, {
      width: "28px",
      height: "22px",
      padding: "0",
      border: "none",
      borderRadius: "3px",
      background: "#333",
      color: "#ddd",
      cursor: "pointer",
      font: "13px sans-serif",
    });
    playButton.addEventListener("click", () => this.toggle());

    const spectrogramButton = document.createElement("button");
    Object.assign(spectrogramButton.style, {
      flex: "0 0 auto",
      height: "22px",
      padding: "0 8px",
      border: "none",
      borderRadius: "3px",
      background: "#333",
      color: "#ddd",
      cursor: "pointer",
      font: "12px sans-serif",
    });
    spectrogramButton.addEventListener("click", () =>
      this.setSpectrogramVisible(!this.showSpectrogram)
    );

    const timeLabel = document.createElement("span");
    const statusLabel = document.createElement("span");
    Object.assign(statusLabel.style, {
      flex: "1",
      textAlign: "right",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });

    controls.append(playButton, timeLabel, statusLabel, spectrogramButton);
    root.append(canvasWrap, controls);

    // Keep pointer interaction inside the widget from also dragging the node or
    // panning the canvas.
    root.addEventListener("pointerdown", (e) => e.stopPropagation());

    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    canvas.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    canvas.addEventListener("pointerleave", () => {
      this.hoverX = null;
      this.draw();
    });

    new ResizeObserver(() => {
      this.layers = null;
      this.draw();
    }).observe(canvasWrap);

    this.root = root;
    this.canvas = canvas;
    this.playButton = playButton;
    this.spectrogramButton = spectrogramButton;
    this.timeLabel = timeLabel;
    this.statusLabel = statusLabel;
    this.updateControls();
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  get position() {
    if (!this.playing) return this.offset;
    const elapsed = getAudioContext().currentTime - this.startedAt;
    return Math.min(this.offset + elapsed, this.duration);
  }

  // --- Loading ---------------------------------------------------------------

  async load(url) {
    this.clear("Loading audio…");
    const token = this.loadToken;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      const bytes = await resp.arrayBuffer();
      const buffer = await getAudioContext().decodeAudioData(bytes);
      if (token !== this.loadToken) return;
      this.buffer = buffer;
      this.peaks = computePeaks(buffer);
      this.spectrogram = null;
      this.offset = 0;
      this.layers = null;
      this.message = null;
      const n = buffer.numberOfChannels;
      this.statusLabel.textContent = n === 1 ? "mono" : n === 2 ? "stereo" : `${n} channels`;
      this.updateControls();
      this.draw();
    } catch (err) {
      if (token !== this.loadToken) return;
      console.error("[m5.AudioPlayback] failed to load audio:", err);
      this.clear(`Failed to load audio: ${err?.message ?? err}`);
    }
  }

  clear(message) {
    this.loadToken++;
    this.stop();
    this.buffer = null;
    this.peaks = null;
    this.spectrogram = null;
    this.offset = 0;
    this.layers = null;
    this.setMessage(message);
  }

  setMessage(message) {
    this.message = message;
    this.statusLabel.textContent = "";
    this.updateControls();
    this.draw();
  }

  // --- Transport -------------------------------------------------------------

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  play() {
    if (!this.buffer) return;
    const ctx = getAudioContext();
    if (ctx.state === "suspended") ctx.resume();
    // Pressing play at the end starts over.
    if (this.offset >= this.duration - 1e-3) this.offset = 0;

    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      // Only a natural end: stop()/pause() detach this handler first.
      if (this.source !== source) return;
      this.source = null;
      this.playing = false;
      this.offset = this.duration;
      this.updateControls();
      this.draw();
    };
    source.start(0, this.offset);
    this.source = source;
    this.startedAt = ctx.currentTime;
    this.playing = true;
    this.updateControls();
    this.tick();
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.position;
    this.stopSource();
    this.updateControls();
    this.draw();
  }

  stop() {
    this.stopSource();
    this.offset = 0;
    this.updateControls();
  }

  stopSource() {
    const source = this.source;
    this.source = null;
    this.playing = false;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      source.disconnect();
    }
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  seek(seconds) {
    const wasPlaying = this.playing;
    if (wasPlaying) this.stopSource();
    this.offset = Math.max(0, Math.min(seconds, this.duration));
    if (wasPlaying) this.play();
    this.updateControls();
    this.draw();
  }

  tick() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    const frame = () => {
      this.rafId = null;
      if (!this.playing) return;
      this.updateTime();
      this.draw();
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  updateTime() {
    this.timeLabel.textContent = this.buffer
      ? `${formatTime(this.position)} / ${formatTime(this.duration)}`
      : "";
  }

  updateControls() {
    this.playButton.disabled = !this.buffer;
    this.playButton.style.opacity = this.buffer ? "1" : "0.4";
    this.playButton.textContent = this.playing ? "❚❚" : "▶";
    this.playButton.title = this.playing ? "Pause" : "Play";
    this.spectrogramButton.textContent = this.showSpectrogram
      ? "hide spectrogram"
      : "show spectrogram";
    this.updateTime();
  }

  // --- Scrubbing -------------------------------------------------------------

  timeAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    return Math.max(0, Math.min(1, frac)) * this.duration;
  }

  // Hover position in canvas CSS pixels. getBoundingClientRect is in screen
  // pixels (scaled by the ComfyUI canvas zoom), clientWidth is not.
  hoverAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    return rect.width > 0
      ? ((e.clientX - rect.left) / rect.width) * this.canvas.clientWidth
      : null;
  }

  onPointerDown(e) {
    if (!this.buffer || e.button !== 0) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    // Pause while dragging and resume from the release point, rather than
    // restarting playback on every pointer move.
    this.scrubbing = true;
    this.resumeAfterScrub = this.playing;
    if (this.playing) this.pause();
    this.seek(this.timeAt(e));
  }

  onPointerMove(e) {
    this.hoverX = this.buffer ? this.hoverAt(e) : null;
    if (this.scrubbing) this.seek(this.timeAt(e));
    else this.draw();
  }

  onPointerUp(e) {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    if (this.resumeAfterScrub) this.play();
    this.resumeAfterScrub = false;
  }

  // --- Drawing ---------------------------------------------------------------

  // Size the canvas backing store to its CSS box. Returns false if not laid out.
  sizeCanvas() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return false;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
      this.layers = null;
    }
    return true;
  }

  // Height (backing-store px) of the waveform and spectrogram regions. With the
  // spectrogram hidden the waveform fills the canvas.
  regions() {
    const { height } = this.canvas;
    if (!this.showSpectrogram) return { waveHeight: height, specTop: height, specHeight: 0 };
    const gap = Math.round(REGION_GAP * (window.devicePixelRatio || 1));
    const waveHeight = Math.max(1, Math.round((height - gap) / (1 + SPEC_HEIGHT_RATIO)));
    const specTop = waveHeight + gap;
    return { waveHeight, specTop, specHeight: Math.max(0, height - specTop) };
  }

  // Render the waveform twice (unplayed and played colors) into offscreen
  // canvases, so each animation frame is just two clipped blits + a line.
  renderLayers(waveHeight) {
    const { width } = this.canvas;
    const make = (color) => {
      const layer = document.createElement("canvas");
      layer.width = width;
      layer.height = waveHeight;
      this.drawWaveform(layer.getContext("2d"), width, waveHeight, color);
      return layer;
    };
    this.layers = { unplayed: make(COLORS.unplayed), played: make(COLORS.played) };
  }

  drawWaveform(ctx, width, height, color) {
    const { min, max } = this.peaks;
    const buckets = min.length;
    const mid = height / 2;
    const amp = height / 2 - 1;

    ctx.fillStyle = COLORS.lane;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = COLORS.centerLine;
    ctx.fillRect(0, Math.floor(mid), width, 1);

    // One vertical min..max bar per backing-store pixel column, aggregated
    // from whichever peak buckets fall under that column.
    ctx.fillStyle = color;
    for (let x = 0; x < width; x++) {
      const b0 = Math.floor((x * buckets) / width);
      const b1 = Math.max(b0 + 1, Math.floor(((x + 1) * buckets) / width));
      let lo = 0;
      let hi = 0;
      for (let b = b0; b < b1 && b < buckets; b++) {
        if (min[b] < lo) lo = min[b];
        if (max[b] > hi) hi = max[b];
      }
      const y0 = mid - Math.min(1, hi) * amp;
      const y1 = mid - Math.max(-1, lo) * amp;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }

  drawSpectrogram(ctx, top, height) {
    if (height <= 0) return;
    if (!this.spectrogram) this.spectrogram = computeSpectrogram(this.buffer);
    const { canvas, ticks } = this.spectrogram;
    const { width } = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas, 0, top, width, height);

    // Frequency labels along the left edge.
    ctx.font = `${10 * dpr}px sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const { label, frac } of ticks) {
      const y = Math.round(top + frac * height);
      ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
      ctx.fillRect(0, y, 4 * dpr, Math.max(1, dpr));
      ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
      ctx.fillText(label, 6 * dpr, y);
    }
  }

  draw() {
    if (!this.sizeCanvas()) return;
    const ctx = this.canvas.getContext("2d");
    const { width, height } = this.canvas;
    const dpr = window.devicePixelRatio || 1;

    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, height);

    if (!this.buffer) {
      ctx.fillStyle = COLORS.text;
      ctx.font = `${12 * dpr}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.message ?? "", width / 2, height / 2, width - 16 * dpr);
      return;
    }

    const { waveHeight, specTop, specHeight } = this.regions();
    if (!this.layers || this.layers.played.height !== waveHeight) {
      this.renderLayers(waveHeight);
    }
    const x = Math.round((this.duration > 0 ? this.position / this.duration : 0) * width);
    const h = waveHeight;
    if (x > 0) ctx.drawImage(this.layers.played, 0, 0, x, h, 0, 0, x, h);
    if (x < width) {
      ctx.drawImage(this.layers.unplayed, x, 0, width - x, h, x, 0, width - x, h);
    }
    if (this.showSpectrogram) this.drawSpectrogram(ctx, specTop, specHeight);

    if (this.hoverX !== null && !this.scrubbing) {
      ctx.fillStyle = COLORS.hover;
      ctx.fillRect(Math.round(this.hoverX * dpr), 0, Math.max(1, dpr), height);
    }

    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(Math.min(x, width - 2 * dpr), 0, Math.max(2, 2 * dpr), height);
  }

  // Show or hide the spectrogram. With `resize`, the node grows or shrinks by
  // the spectrogram's share so the waveform keeps its height; restoring a saved
  // workflow passes false, since the saved node size already accounts for it.
  setSpectrogramVisible(show, resize = true) {
    show = !!show;
    if (resize && show !== this.showSpectrogram && this.canvas.clientHeight > 0) {
      const h = this.canvas.clientHeight;
      const delta = show
        ? h * SPEC_HEIGHT_RATIO + REGION_GAP
        : (h - REGION_GAP) * (SPEC_HEIGHT_RATIO / (1 + SPEC_HEIGHT_RATIO)) + REGION_GAP;
      const node = this.node;
      node.setSize([node.size[0], node.size[1] + (show ? delta : -delta)]);
      node.setDirtyCanvas?.(true, true);
    }
    this.showSpectrogram = show;
    this.node.properties ??= {};
    this.node.properties.m5ShowSpectrogram = show;
    this.updateControls();
    this.draw();
  }

  destroy() {
    this.loadToken++;
    this.stopSource();
  }
}

app.registerExtension({
  name: "m5.AudioPlayback",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "m5_AudioPlayback") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);

      const player = new Player(this);
      this._m5Player = player;
      this.addDOMWidget("waveform", "div", player.root, {
        serialize: false,
        getMinHeight: () => MIN_WAVEFORM_HEIGHT + CONTROLS_HEIGHT,
      });
      player.clear("Run the node to play its audio.");

      this.size[0] = Math.max(this.size[0], 480);
      this.size[1] = Math.max(this.size[1], 240);
      return result;
    };

    // Restore the spectrogram toggle saved with the workflow.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      this._m5Player?.setSpectrogramVisible(this.properties?.m5ShowSpectrogram, false);
      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      const ref = message?.playback_audio?.[0];
      if (ref) this._m5Player?.load(viewURL(ref));
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this._m5Player?.destroy();
      return onRemoved?.apply(this, arguments);
    };
  },
});
