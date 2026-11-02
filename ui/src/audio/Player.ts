// Per-node audio state and behavior for the Audio Playback node: loading,
// transport, scrubbing and canvas drawing. The React component
// (AudioPlayback.tsx) renders the DOM, attaches the canvas, and shows the
// controls from this player's snapshot.
//
// The audio is fetched and decoded with the Web Audio API, which gives us both
// the samples for the waveform and sample-accurate playback. The canvas shows a
// single waveform (multichannel audio is drawn as the envelope of all its
// channels), with the played portion highlighted and a playhead that can be
// clicked or dragged to scrub. "show spectrogram" adds a log-frequency
// spectrogram of the mono mixdown beneath the waveform, in the same canvas, so
// the playhead and scrubbing span both.
import type { PointerEvent as ReactPointerEvent } from "react";

import type { M5Node } from "../common/node";
import { type Peaks, type Spectrogram, computePeaks, computeSpectrogram } from "./dsp";

// Spectrogram height relative to the waveform's when both are shown; the node
// grows/shrinks by this much on toggle so the waveform keeps its size.
const SPEC_HEIGHT_RATIO = 1.2;
const REGION_GAP = 2; // px (CSS) between the waveform and the spectrogram

export const COLORS = {
  background: "#1b1b1b",
  lane: "#262626",
  centerLine: "#3a3a3a",
  unplayed: "#6b7a8f",
  played: "#4fa3ff",
  playhead: "#ffffff",
  hover: "rgba(255, 255, 255, 0.35)",
  text: "#9a9a9a",
};

// One AudioContext shared by every Audio Playback node. Created lazily, since
// browsers only allow audio to start after a user gesture.
let audioContext: AudioContext | null = null;
function getAudioContext(): AudioContext {
  audioContext ??= new AudioContext();
  return audioContext;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
}

/** What the controls row shows; a new object whenever any field changes. */
export interface PlayerSnapshot {
  hasBuffer: boolean;
  playing: boolean;
  showSpectrogram: boolean;
  time: string;
  status: string;
}

export class Player {
  private node: M5Node;
  private buffer: AudioBuffer | null = null;
  private peaks: Peaks | null = null;
  private source: AudioBufferSourceNode | null = null; // while playing
  private playing = false;
  private offset = 0; // position (s) when paused, or where playback started
  private startedAt = 0; // audioContext.currentTime when playback started
  private hoverX: number | null = null;
  private scrubbing = false;
  private resumeAfterScrub = false;
  private loadToken = 0; // discards stale loads that finish out of order
  private rafId: number | null = null;
  private layers: { unplayed: HTMLCanvasElement; played: HTMLCanvasElement } | null = null;
  private showSpectrogram = false;
  private spectrogram: Spectrogram | null = null; // for the current buffer, made on demand
  private message: string | null = null;
  private status = "";
  private canvas: HTMLCanvasElement | null = null;

  private snapshot: PlayerSnapshot;
  private listeners = new Set<() => void>();

  constructor(node: M5Node) {
    this.node = node;
    this.snapshot = this.makeSnapshot();
  }

  // --- React wiring ----------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PlayerSnapshot => this.snapshot;

  private makeSnapshot(): PlayerSnapshot {
    return {
      hasBuffer: !!this.buffer,
      playing: this.playing,
      showSpectrogram: this.showSpectrogram,
      time: this.buffer ? `${formatTime(this.position)} / ${formatTime(this.duration)}` : "",
      status: this.status,
    };
  }

  // Equivalent of the old updateControls()/updateTime(): publish the state the
  // controls row renders, if anything changed.
  private updateControls(): void {
    const next = this.makeSnapshot();
    const prev = this.snapshot;
    if (
      next.hasBuffer === prev.hasBuffer &&
      next.playing === prev.playing &&
      next.showSpectrogram === prev.showSpectrogram &&
      next.time === prev.time &&
      next.status === prev.status
    ) {
      return;
    }
    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  /** Called by the component once the canvas is in the DOM (null on unmount). */
  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
    this.layers = null;
    this.draw();
  }

  /** The canvas's box changed size (ResizeObserver on its wrapper). */
  onResize(): void {
    this.layers = null;
    this.draw();
  }

  get duration(): number {
    return this.buffer ? this.buffer.duration : 0;
  }

  get position(): number {
    if (!this.playing) return this.offset;
    const elapsed = getAudioContext().currentTime - this.startedAt;
    return Math.min(this.offset + elapsed, this.duration);
  }

  // --- Loading ---------------------------------------------------------------

  async load(url: string): Promise<void> {
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
      this.status = n === 1 ? "mono" : n === 2 ? "stereo" : `${n} channels`;
      this.updateControls();
      this.draw();
    } catch (err) {
      if (token !== this.loadToken) return;
      console.error("[m5.AudioPlayback] failed to load audio:", err);
      this.clear(`Failed to load audio: ${(err as Error)?.message ?? err}`);
    }
  }

  clear(message: string): void {
    this.loadToken++;
    this.stop();
    this.buffer = null;
    this.peaks = null;
    this.spectrogram = null;
    this.offset = 0;
    this.layers = null;
    this.setMessage(message);
  }

  private setMessage(message: string): void {
    this.message = message;
    this.status = "";
    this.updateControls();
    this.draw();
  }

  // --- Transport -------------------------------------------------------------

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (!this.buffer) return;
    const ctx = getAudioContext();
    if (ctx.state === "suspended") void ctx.resume();
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

  pause(): void {
    if (!this.playing) return;
    this.offset = this.position;
    this.stopSource();
    this.updateControls();
    this.draw();
  }

  stop(): void {
    this.stopSource();
    this.offset = 0;
    this.updateControls();
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
    this.offset = Math.max(0, Math.min(seconds, this.duration));
    if (wasPlaying) this.play();
    this.updateControls();
    this.draw();
  }

  private tick(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    const frame = () => {
      this.rafId = null;
      if (!this.playing) return;
      this.updateControls();
      this.draw();
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  // --- Scrubbing -------------------------------------------------------------

  private timeAt(e: ReactPointerEvent): number {
    const rect = this.canvas!.getBoundingClientRect();
    const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    return Math.max(0, Math.min(1, frac)) * this.duration;
  }

  // Hover position in canvas CSS pixels. getBoundingClientRect is in screen
  // pixels (scaled by the ComfyUI canvas zoom), clientWidth is not.
  private hoverAt(e: ReactPointerEvent): number | null {
    const rect = this.canvas!.getBoundingClientRect();
    return rect.width > 0 ? ((e.clientX - rect.left) / rect.width) * this.canvas!.clientWidth : null;
  }

  onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!this.buffer || !this.canvas || e.button !== 0) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    // Pause while dragging and resume from the release point, rather than
    // restarting playback on every pointer move.
    this.scrubbing = true;
    this.resumeAfterScrub = this.playing;
    if (this.playing) this.pause();
    this.seek(this.timeAt(e));
  }

  onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!this.canvas) return;
    this.hoverX = this.buffer ? this.hoverAt(e) : null;
    if (this.scrubbing) this.seek(this.timeAt(e));
    else this.draw();
  }

  onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    if (this.canvas?.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    if (this.resumeAfterScrub) this.play();
    this.resumeAfterScrub = false;
  }

  onPointerLeave(): void {
    this.hoverX = null;
    this.draw();
  }

  // --- Drawing ---------------------------------------------------------------

  // Size the canvas backing store to its CSS box. Returns false if not laid out.
  private sizeCanvas(canvas: HTMLCanvasElement): boolean {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return false;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      this.layers = null;
    }
    return true;
  }

  // Height (backing-store px) of the waveform and spectrogram regions. With the
  // spectrogram hidden the waveform fills the canvas.
  private regions(canvas: HTMLCanvasElement) {
    const { height } = canvas;
    if (!this.showSpectrogram) return { waveHeight: height, specTop: height, specHeight: 0 };
    const gap = Math.round(REGION_GAP * (window.devicePixelRatio || 1));
    const waveHeight = Math.max(1, Math.round((height - gap) / (1 + SPEC_HEIGHT_RATIO)));
    const specTop = waveHeight + gap;
    return { waveHeight, specTop, specHeight: Math.max(0, height - specTop) };
  }

  // Render the waveform twice (unplayed and played colors) into offscreen
  // canvases, so each animation frame is just two clipped blits + a line.
  private renderLayers(width: number, waveHeight: number) {
    const make = (color: string) => {
      const layer = document.createElement("canvas");
      layer.width = width;
      layer.height = waveHeight;
      this.drawWaveform(layer.getContext("2d")!, width, waveHeight, color);
      return layer;
    };
    return { unplayed: make(COLORS.unplayed), played: make(COLORS.played) };
  }

  private drawWaveform(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    color: string,
  ): void {
    const { min, max } = this.peaks!;
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

  private drawSpectrogram(
    ctx: CanvasRenderingContext2D,
    width: number,
    top: number,
    height: number,
  ): void {
    if (height <= 0) return;
    this.spectrogram ??= computeSpectrogram(this.buffer!);
    const { canvas, ticks } = this.spectrogram;
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

  draw(): void {
    const canvas = this.canvas;
    if (!canvas || !this.sizeCanvas(canvas)) return;
    const ctx = canvas.getContext("2d")!;
    const { width, height } = canvas;
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

    const { waveHeight, specTop, specHeight } = this.regions(canvas);
    if (!this.layers || this.layers.played.height !== waveHeight) {
      this.layers = this.renderLayers(width, waveHeight);
    }
    const x = Math.round((this.duration > 0 ? this.position / this.duration : 0) * width);
    const h = waveHeight;
    if (x > 0) ctx.drawImage(this.layers.played, 0, 0, x, h, 0, 0, x, h);
    if (x < width) {
      ctx.drawImage(this.layers.unplayed, x, 0, width - x, h, x, 0, width - x, h);
    }
    if (this.showSpectrogram) this.drawSpectrogram(ctx, width, specTop, specHeight);

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
  setSpectrogramVisible(show: unknown, resize = true): void {
    const visible = !!show;
    const h = this.canvas?.clientHeight ?? 0;
    if (resize && visible !== this.showSpectrogram && h > 0) {
      const delta = visible
        ? h * SPEC_HEIGHT_RATIO + REGION_GAP
        : (h - REGION_GAP) * (SPEC_HEIGHT_RATIO / (1 + SPEC_HEIGHT_RATIO)) + REGION_GAP;
      const node = this.node;
      node.setSize([node.size[0], node.size[1] + (visible ? delta : -delta)]);
      node.setDirtyCanvas?.(true, true);
    }
    this.showSpectrogram = visible;
    this.node.properties ??= {};
    this.node.properties.m5ShowSpectrogram = visible;
    this.updateControls();
    this.draw();
  }

  destroy(): void {
    this.loadToken++;
    this.stopSource();
  }
}
