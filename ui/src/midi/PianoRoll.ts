// Per-node state and drawing for the MIDI Viewer: a piano roll on a canvas and
// playback of the synth rendering (Web Audio). The React component
// (MidiViewer.tsx) lays out the scroller, canvas and controls, and shows this
// object's snapshot.
//
// Layout: a native horizontal scroller holds a spacer as wide as the zoomed
// piece; the canvas is `position: sticky` inside it and only ever as wide as
// the visible area, so a long file at a high zoom never needs a huge canvas.
// Vertically the pitch range of the file (padded) always fills the height.
import type { PointerEvent as ReactPointerEvent } from "react";

import { getAudioContext } from "../audio/Player";

/** [start_ms, duration_ms, pitch, velocity, channel (1-based), cents] */
export type NoteRow = [number, number, number, number, number, number];

export interface MidiTrackData {
  name: string;
  channels: number[];
  notes: NoteRow[];
}

export interface MidiData {
  tracks: MidiTrackData[];
  duration_ms: number;
  bars: { ms: number; measure: number }[];
  beats: number[];
  tempo: string;
  meter: string;
}

export const KEYS_WIDTH = 38; // px, the keyboard strip on the left
const RULER_HEIGHT = 16; // px, measure numbers along the top
const MIN_SPAN = 24; // semitones shown at least, so a short melody isn't drawn huge
const PAD = 2; // semitones of room above and below the notes

export const COLORS = {
  background: "#1b1b1b",
  whiteRow: "#232323",
  blackRow: "#1d1d1d",
  cLine: "#353535",
  beat: "#2b2b2b",
  bar: "#4a4a4a",
  ruler: "#151515",
  text: "#9a9a9a",
  whiteKey: "#d8d8d8",
  blackKey: "#2a2a2a",
  playhead: "#ffffff",
  played: "rgba(255, 255, 255, 0.04)",
};

// One color per track (cycled), readable on the dark background.
export const TRACK_COLORS = [
  "#4fa3ff", "#ff9f43", "#5fd38d", "#e35d6a", "#b48cff",
  "#f5d547", "#3fc9c9", "#ff7ac6", "#a3c34f", "#c9a27a",
];

const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);

function pitchName(pitch: number): string {
  return `${PITCH_CLASSES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
}

/** What the controls row shows; a new object whenever any field changes. */
export interface RollSnapshot {
  data: MidiData | null;
  hasBuffer: boolean;
  playing: boolean;
  time: string;
  status: string;
  /** Spacer width in px: the zoomed piece plus the keyboard strip. */
  contentWidth: number;
}

interface Hover {
  x: number;
  y: number;
  track: number;
  note: NoteRow;
}

export class PianoRoll {
  private data: MidiData | null = null;
  private zoom = 1;
  private message: string | null = "Run the node to see the MIDI.";
  private lowPitch = 48;
  private highPitch = 72;

  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private playing = false;
  private offset = 0; // s, position when paused or where playback started
  private startedAt = 0;
  private loadToken = 0;
  private rafId: number | null = null;
  private audioStatus = "";

  private canvas: HTMLCanvasElement | null = null;
  private scroller: HTMLDivElement | null = null;
  private hover: Hover | null = null;
  private scrubbing = false;
  private resumeAfterScrub = false;

  private snapshot: RollSnapshot;
  private listeners = new Set<() => void>();

  constructor() {
    this.snapshot = this.makeSnapshot();
  }

  // --- React wiring ----------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RollSnapshot => this.snapshot;

  private makeSnapshot(): RollSnapshot {
    const total = this.totalSeconds;
    return {
      data: this.data,
      hasBuffer: !!this.buffer,
      playing: this.playing,
      time: this.data ? `${formatTime(this.position)} / ${formatTime(total)}` : "",
      status: this.audioStatus,
      contentWidth: KEYS_WIDTH + this.viewWidth * this.zoom,
    };
  }

  private publish(): void {
    const next = this.makeSnapshot();
    const prev = this.snapshot;
    if (
      next.data === prev.data &&
      next.hasBuffer === prev.hasBuffer &&
      next.playing === prev.playing &&
      next.time === prev.time &&
      next.status === prev.status &&
      next.contentWidth === prev.contentWidth
    ) {
      return;
    }
    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  attach(canvas: HTMLCanvasElement | null, scroller: HTMLDivElement | null): void {
    this.canvas = canvas;
    this.scroller = scroller;
    this.publish();
    this.draw();
  }

  onResize(): void {
    this.publish();
    this.draw();
  }

  onScroll(): void {
    this.draw();
  }

  // --- Data ------------------------------------------------------------------

  setData(data: MidiData): void {
    this.data = data;
    this.message = data.tracks.some((t) => t.notes.length) ? null : "This MIDI has no notes.";
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of data.tracks) {
      for (const n of t.notes) {
        const p = n[2] + n[5] / 100;
        lo = Math.min(lo, p);
        hi = Math.max(hi, p);
      }
    }
    if (!Number.isFinite(lo)) [lo, hi] = [60, 60];
    lo = Math.floor(lo) - PAD;
    hi = Math.ceil(hi) + PAD;
    if (hi - lo + 1 < MIN_SPAN) {
      const extra = MIN_SPAN - (hi - lo + 1);
      lo -= Math.floor(extra / 2);
      hi += Math.ceil(extra / 2);
    }
    this.lowPitch = Math.max(0, lo);
    this.highPitch = Math.min(127, hi);
    this.hover = null;
    if (this.scroller) this.scroller.scrollLeft = 0;
    this.publish();
    this.draw();
  }

  setZoom(zoom: number): void {
    if (!(zoom > 0) || zoom === this.zoom) return;
    // Keep the time at the left edge where it is.
    const leftMs = this.xToMs(KEYS_WIDTH);
    this.zoom = zoom;
    this.publish();
    if (this.scroller) this.scroller.scrollLeft = Math.max(0, leftMs * this.pxPerMs);
    this.draw();
  }

  // --- Geometry --------------------------------------------------------------

  /** Visible width of the roll (without the keyboard strip), in CSS px. */
  private get viewWidth(): number {
    return Math.max(1, (this.scroller?.clientWidth ?? 400) - KEYS_WIDTH);
  }

  /** The piece's length: the MIDI's, or the audio's if its release tail is longer. */
  private get totalMs(): number {
    const ms = Math.max(this.data?.duration_ms ?? 0, (this.buffer?.duration ?? 0) * 1000);
    return ms > 0 ? ms : 1000;
  }

  private get totalSeconds(): number {
    return this.data ? this.totalMs / 1000 : 0;
  }

  private get pxPerMs(): number {
    return (this.viewWidth * this.zoom) / this.totalMs;
  }

  private get scrollLeft(): number {
    return this.scroller?.scrollLeft ?? 0;
  }

  private msToX(ms: number): number {
    return KEYS_WIDTH + ms * this.pxPerMs - this.scrollLeft;
  }

  private xToMs(x: number): number {
    return (x - KEYS_WIDTH + this.scrollLeft) / this.pxPerMs;
  }

  private rowHeight(height: number): number {
    return (height - RULER_HEIGHT) / (this.highPitch - this.lowPitch + 1);
  }

  /** Top y of a (possibly fractional) pitch's row. */
  private pitchToY(pitch: number, rowH: number): number {
    return RULER_HEIGHT + (this.highPitch - pitch) * rowH;
  }

  // --- Transport -------------------------------------------------------------

  get position(): number {
    if (!this.playing) return this.offset;
    const elapsed = getAudioContext().currentTime - this.startedAt;
    return Math.min(this.offset + elapsed, this.buffer?.duration ?? 0);
  }

  async load(url: string | null): Promise<void> {
    this.loadToken++;
    const token = this.loadToken;
    this.stopSource();
    this.offset = 0;
    this.buffer = null;
    this.audioStatus = url ? "rendering audio…" : "";
    this.publish();
    if (!url) return;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      const buffer = await getAudioContext().decodeAudioData(await resp.arrayBuffer());
      if (token !== this.loadToken) return;
      this.buffer = buffer;
      this.audioStatus = "";
    } catch (err) {
      if (token !== this.loadToken) return;
      console.error("[m5.MidiViewer] failed to load audio:", err);
      this.audioStatus = `no audio: ${(err as Error)?.message ?? err}`;
    }
    this.publish();
    this.draw();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (!this.buffer) return;
    const ctx = getAudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    if (this.offset >= this.buffer.duration - 1e-3) this.offset = 0;
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      this.playing = false;
      this.offset = this.buffer?.duration ?? 0;
      this.publish();
      this.draw();
    };
    source.start(0, this.offset);
    this.source = source;
    this.startedAt = ctx.currentTime;
    this.playing = true;
    this.publish();
    this.tick();
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.position;
    this.stopSource();
    this.publish();
    this.draw();
  }

  private stopSource(): void {
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

  private seek(seconds: number): void {
    const wasPlaying = this.playing;
    if (wasPlaying) this.stopSource();
    this.offset = Math.max(0, Math.min(seconds, this.buffer?.duration ?? this.totalSeconds));
    if (wasPlaying) this.play();
    this.publish();
    this.draw();
  }

  private tick = (): void => {
    if (!this.playing) return;
    this.follow();
    this.publish();
    this.draw();
    this.rafId = requestAnimationFrame(this.tick);
  };

  /** While playing, page the view so the playhead stays visible. */
  private follow(): void {
    if (!this.scroller || this.scrubbing) return;
    const x = this.msToX(this.position * 1000);
    if (x > KEYS_WIDTH + this.viewWidth * 0.95 || x < KEYS_WIDTH) {
      this.scroller.scrollLeft = Math.max(0, this.position * 1000 * this.pxPerMs - this.viewWidth * 0.05);
    }
  }

  destroy(): void {
    this.loadToken++;
    this.stopSource();
    this.listeners.clear();
  }

  // --- Pointer ---------------------------------------------------------------

  /** Pointer position in canvas CSS px (the ComfyUI canvas zoom scales the screen rect). */
  private localXY(e: { clientX: number; clientY: number }): [number, number] | null {
    const c = this.canvas;
    if (!c) return null;
    const rect = c.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return [
      ((e.clientX - rect.left) / rect.width) * c.clientWidth,
      ((e.clientY - rect.top) / rect.height) * c.clientHeight,
    ];
  }

  onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>): void {
    const p = this.localXY(e);
    if (!p || p[0] < KEYS_WIDTH || !this.data) return;
    try {
      this.canvas?.setPointerCapture(e.pointerId);
    } catch {
      /* not an active pointer (synthetic event): scrub without capture */
    }
    this.scrubbing = true;
    this.resumeAfterScrub = this.playing;
    if (this.playing) {
      this.offset = this.position;
      this.stopSource();
    }
    this.seek(this.xToMs(p[0]) / 1000);
  }

  onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>): void {
    const p = this.localXY(e);
    if (!p) return;
    if (this.scrubbing) {
      this.seek(this.xToMs(Math.max(KEYS_WIDTH, p[0])) / 1000);
      return;
    }
    const hover = this.noteAt(p[0], p[1]);
    if (hover?.note !== this.hover?.note || hover?.x !== this.hover?.x) {
      this.hover = hover;
      this.draw();
    }
  }

  onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    if (this.canvas?.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (this.resumeAfterScrub) this.play();
  }

  onPointerLeave(): void {
    if (this.hover) {
      this.hover = null;
      this.draw();
    }
  }

  private noteAt(x: number, y: number): Hover | null {
    if (!this.data || !this.canvas || x < KEYS_WIDTH || y < RULER_HEIGHT) return null;
    const rowH = this.rowHeight(this.canvas.clientHeight);
    const ms = this.xToMs(x);
    // Last drawn wins: search tracks and notes backwards.
    for (let t = this.data.tracks.length - 1; t >= 0; t--) {
      const notes = this.data.tracks[t].notes;
      for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        if (ms < n[0] || ms > n[0] + n[1]) continue;
        const top = this.pitchToY(n[2] + n[5] / 100, rowH);
        if (y >= top && y <= top + Math.max(rowH, 3)) return { x, y, track: t, note: n };
      }
    }
    return null;
  }

  // --- Drawing ---------------------------------------------------------------

  draw(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, w, h);

    if (!this.data || this.message) {
      ctx.fillStyle = COLORS.text;
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.message ?? "", w / 2, h / 2);
      return;
    }

    const rowH = this.rowHeight(h);
    const fromMs = this.xToMs(KEYS_WIDTH);
    const toMs = this.xToMs(w);

    // Rows: black keys darker, a line under every C.
    for (let p = this.lowPitch; p <= this.highPitch; p++) {
      const y = this.pitchToY(p, rowH);
      ctx.fillStyle = BLACK.has(p % 12) ? COLORS.blackRow : COLORS.whiteRow;
      ctx.fillRect(KEYS_WIDTH, y, w - KEYS_WIDTH, Math.ceil(rowH));
      if (p % 12 === 0) {
        ctx.fillStyle = COLORS.cLine;
        ctx.fillRect(KEYS_WIDTH, Math.round(y + rowH) - 1, w - KEYS_WIDTH, 1);
      }
    }

    // Played part, beats and bars.
    const playX = this.msToX(this.position * 1000);
    if (playX > KEYS_WIDTH) {
      ctx.fillStyle = COLORS.played;
      ctx.fillRect(KEYS_WIDTH, RULER_HEIGHT, Math.min(playX, w) - KEYS_WIDTH, h - RULER_HEIGHT);
    }
    const beatPx = this.data.beats.length > 1 ? (this.data.beats[1] - this.data.beats[0]) * this.pxPerMs : 99;
    if (beatPx >= 6) {
      ctx.fillStyle = COLORS.beat;
      for (const ms of this.data.beats) {
        if (ms < fromMs || ms > toMs) continue;
        ctx.fillRect(Math.round(this.msToX(ms)), RULER_HEIGHT, 1, h - RULER_HEIGHT);
      }
    }
    ctx.fillStyle = COLORS.ruler;
    ctx.fillRect(KEYS_WIDTH, 0, w - KEYS_WIDTH, RULER_HEIGHT);
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    let lastLabelX = -Infinity;
    for (const bar of this.data.bars) {
      if (bar.ms > toMs) break;
      const x = Math.round(this.msToX(bar.ms));
      if (x < KEYS_WIDTH - 40) continue;
      ctx.fillStyle = COLORS.bar;
      if (x >= KEYS_WIDTH) ctx.fillRect(x, 0, 1, h);
      if (x - lastLabelX >= 28 && x >= KEYS_WIDTH) {
        ctx.fillStyle = COLORS.text;
        ctx.fillText(String(bar.measure), x + 3, RULER_HEIGHT / 2);
        lastLabelX = x;
      }
    }

    // Notes: one color per track, fainter when softer; ones sounding now get an outline.
    const nowMs = this.position * 1000;
    const noteH = Math.max(rowH - 1, 2);
    this.data.tracks.forEach((track, t) => {
      const color = TRACK_COLORS[t % TRACK_COLORS.length];
      for (const n of track.notes) {
        const [start, dur, pitch, vel, , cents] = n;
        if (start > toMs || start + dur < fromMs) continue;
        const x = this.msToX(start);
        const nw = Math.max(dur * this.pxPerMs, 2);
        const y = this.pitchToY(pitch + cents / 100, rowH) + 0.5;
        ctx.globalAlpha = 0.35 + 0.65 * (vel / 127);
        ctx.fillStyle = color;
        ctx.fillRect(x, y, nw, noteH);
        ctx.globalAlpha = 1;
        const sounding = (this.playing || this.offset > 0) && start <= nowMs && nowMs < start + dur;
        if (sounding || this.hover?.note === n) {
          ctx.strokeStyle = COLORS.playhead;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, nw - 1, noteH - 1);
        }
      }
    });
    ctx.globalAlpha = 1;

    // Keyboard strip, drawn over anything scrolled under it.
    ctx.fillStyle = COLORS.ruler;
    ctx.fillRect(0, 0, KEYS_WIDTH, h);
    ctx.textAlign = "right";
    for (let p = this.lowPitch; p <= this.highPitch; p++) {
      const y = this.pitchToY(p, rowH);
      const black = BLACK.has(p % 12);
      ctx.fillStyle = black ? COLORS.blackKey : COLORS.whiteKey;
      ctx.fillRect(black ? 0 : 0, y, black ? KEYS_WIDTH * 0.6 : KEYS_WIDTH - 1, Math.max(rowH - 0.5, 1));
      if (p % 12 === 0 && rowH >= 4) {
        ctx.fillStyle = "#333";
        ctx.font = `${Math.min(10, Math.max(8, rowH))}px sans-serif`;
        ctx.fillText(pitchName(p), KEYS_WIDTH - 3, y + rowH / 2);
      }
    }
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "left";
    ctx.font = "9px sans-serif";
    ctx.fillText(this.data.meter, 3, RULER_HEIGHT / 2);

    // Playhead.
    if (playX >= KEYS_WIDTH && playX <= w) {
      ctx.fillStyle = COLORS.playhead;
      ctx.fillRect(Math.round(playX), 0, 1, h);
    }

    if (this.hover) this.drawTooltip(ctx, w, h);
  }

  private drawTooltip(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const { x, y, track, note } = this.hover!;
    const [start, dur, pitch, vel, ch, cents] = note;
    const name = this.data!.tracks[track].name || `track ${track + 1}`;
    const centsText = Math.abs(cents) >= 0.5 ? ` ${cents > 0 ? "+" : ""}${cents}¢` : "";
    const lines = [
      `${pitchName(pitch)}${centsText}  (${pitch})  vel ${vel}`,
      `${name} · ch ${ch}`,
      `${(start / 1000).toFixed(3)} s, ${(dur / 1000).toFixed(3)} s long`,
    ];
    ctx.font = "11px sans-serif";
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
    const th = lines.length * 14 + 8;
    let bx = x + 12;
    let by = y + 12;
    if (bx + tw > w) bx = x - tw - 8;
    if (by + th > h) by = y - th - 8;
    ctx.fillStyle = "rgba(10, 10, 10, 0.9)";
    ctx.fillRect(bx, by, tw, th);
    ctx.strokeStyle = TRACK_COLORS[track % TRACK_COLORS.length];
    ctx.strokeRect(bx + 0.5, by + 0.5, tw - 1, th - 1);
    ctx.fillStyle = "#e0e0e0";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    lines.forEach((l, i) => ctx.fillText(l, bx + 6, by + 5 + i * 14));
  }
}
