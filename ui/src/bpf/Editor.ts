// The BPF node's curve editor: canvas drawing and pointer/keyboard editing.
//
// Editing works like Max's `function` object / DAW automation:
//   click empty space   add a point (and keep dragging it)
//   drag a point        move it (between its neighbours' times, inside the box)
//   Shift while dragging  snap to the minor grid (a quarter of the labelled step)
//   Alt while dragging    move the value only (keep the time)
//   double-click / right-click a point, or Delete/Backspace on the selected one: delete it
// With a BPF connected to the node's input the editor shows that curve read-only.
//
// State lives here (not in React) because pointer moves redraw at frame rate; the React
// wrapper (BPFEditor.tsx) subscribes to `getSnapshot` for its status line.
import {
  type BPFPayload,
  type Curve,
  type Point,
  evaluate,
  fmt,
  niceStep,
  segmentValue,
} from "./curve";

const MARGIN = { left: 46, right: 12, top: 10, bottom: 22 };
const HIT_RADIUS = 7;
const POINT_RADIUS = 4;
const ACCENT = "#4fa3ff";
const INPUT_ACCENT = "#5cc98a";
const SELECTED = "#ffa94d";

export interface EditorSnapshot {
  readOnly: boolean;
  status: string;
  count: number;
}

interface Theme {
  bg: string;
  fg: string;
  muted: string;
  grid: string;
}

/** ComfyUI palette colours (CSS variables on :root), read at draw time so theme switches apply. */
function theme(): Theme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--comfy-input-bg", "#222"),
    fg: v("--input-text", v("--fg-color", "#ddd")),
    muted: v("--descrip-text", "#999"),
    grid: v("--border-color", "#4e4e4e"),
  };
}

/**
 * The value axis for viewing a curve: its data's min..max plus 5% on each side, so a curve
 * that uses a small part of its nominal range (an f0 track at 220-390 Hz in 50-2000 Hz) is
 * still readable. Step/linear/exp segments never leave their endpoints' span, so the points'
 * extremes are the curve's.
 */
function dataView(points: Point[]): [number, number] | undefined {
  const values = points.map(([, v]) => v).filter(Number.isFinite);
  if (!values.length) return undefined;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = max > min ? (max - min) * 0.05 : Math.abs(min) * 0.05 || 0.5;
  return [min - pad, max + pad];
}

export function payloadToCurve(p: BPFPayload): Curve {
  let [lo, hi] = p.range;
  if (!(hi > lo)) [lo, hi] = [lo - 0.5, hi + 0.5]; // a flat curve still needs a box
  const lastT = p.points.length ? p.points[p.points.length - 1][0] : 0;
  return {
    points: p.points,
    interpolation: p.interpolation,
    duration: Math.max(p.duration, lastT) || 1,
    lo,
    hi,
    view: dataView(p.points),
    name: p.name,
    unit: p.unit,
  };
}

export class Editor {
  readonly canvas: HTMLCanvasElement;
  /** Points drawn in the editor (the node's `points` widget value). */
  points: Point[] = [];
  /** A curve from the node's input: shown read-only instead of the drawn points. */
  incoming: Curve | null = null;

  private selected: number | null = null;
  private hover: number | null = null;
  private cursor: { x: number; y: number } | null = null;
  private drag: { index: number; time: number } | null = null;
  private listeners = new Set<() => void>();
  private snapshot: EditorSnapshot = { readOnly: false, status: "", count: 0 };
  private themeObserver: MutationObserver;
  private resizeObserver: ResizeObserver;

  constructor(
    /** The box and settings from the node's widgets (duration, min/max, interpolation…). */
    private readonly settings: () => Omit<Curve, "points">,
    /** Called after an edit, with the new points, to store them in the widget. */
    private readonly onCommit: (points: Point[]) => void,
  ) {
    const c = document.createElement("canvas");
    c.tabIndex = 0; // so Delete/Backspace reach us
    Object.assign(c.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%",
      outline: "none", touchAction: "none", cursor: "crosshair",
    });
    this.canvas = c;
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointercancel", this.onPointerUp);
    c.addEventListener("pointerleave", this.onPointerLeave);
    c.addEventListener("dblclick", this.onDoubleClick);
    c.addEventListener("contextmenu", this.onContextMenu);
    c.addEventListener("keydown", this.onKeyDown);
    // Keep the canvas's events from reaching LiteGraph (canvas pan, node menu, Delete = delete node).
    for (const type of ["pointerdown", "pointerup", "contextmenu", "keydown", "keyup", "wheel", "dblclick"]) {
      c.addEventListener(type, (e) => e.stopPropagation());
    }
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(c);
    // ComfyUI switches palettes by rewriting :root's style/class.
    this.themeObserver = new MutationObserver(() => this.draw());
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.themeObserver.disconnect();
    this.listeners.clear();
  }

  // --- React subscription (useSyncExternalStore) ---------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  private updateSnapshot(): void {
    const curve = this.curve();
    const readOnly = this.incoming !== null;
    let status: string;
    const unit = curve.unit ? ` ${curve.unit}` : "";
    if (this.hover !== null && curve.points[this.hover]) {
      const [t, v] = curve.points[this.hover];
      status = `point ${this.hover + 1}: ${fmt(t)} ms, ${fmt(v)}${unit}`;
    } else if (this.cursor && this.inPlot(this.cursor.x, this.cursor.y)) {
      const t = this.xToT(this.cursor.x);
      const v = evaluate(curve.points, curve.interpolation, t);
      status = `${fmt(t)} ms` + (v === null ? "" : ` → ${fmt(v)}${unit}`);
    } else if (readOnly) {
      const name = curve.name ? ` '${curve.name}'` : "";
      status = `input${name}: ${curve.points.length} points (read-only)`;
    } else {
      status = curve.points.length ? "" : "Click to add points";
    }
    const next = { readOnly, status, count: curve.points.length };
    const s = this.snapshot;
    if (s.readOnly !== next.readOnly || s.status !== next.status || s.count !== next.count) {
      this.snapshot = next;
      this.listeners.forEach((fn) => fn());
    }
  }

  // --- geometry ----------------------------------------------------------------------------

  /** The curve being shown: the incoming one, or the drawn points in the widgets' box. */
  curve(): Curve {
    return this.incoming ?? { ...this.settings(), points: this.points };
  }

  private size() {
    return { w: this.canvas.clientWidth, h: this.canvas.clientHeight };
  }

  private plot() {
    const { w, h } = this.size();
    return {
      x0: MARGIN.left, y0: MARGIN.top,
      w: Math.max(1, w - MARGIN.left - MARGIN.right),
      h: Math.max(1, h - MARGIN.top - MARGIN.bottom),
    };
  }

  private box() {
    const c = this.curve();
    const duration = c.duration > 0 ? c.duration : 1;
    const [a, b] = c.view ?? [c.lo, c.hi];
    const [lo, hi] = b > a ? [a, b] : [a - 0.5, a + 0.5];
    return { duration, lo, hi };
  }

  private tToX(t: number) {
    const p = this.plot();
    return p.x0 + (t / this.box().duration) * p.w;
  }
  private vToY(v: number) {
    const p = this.plot();
    const { lo, hi } = this.box();
    return p.y0 + (1 - (v - lo) / (hi - lo)) * p.h;
  }
  private xToT(x: number) {
    const p = this.plot();
    return clamp(((x - p.x0) / p.w) * this.box().duration, 0, this.box().duration);
  }
  private yToV(y: number) {
    const p = this.plot();
    const { lo, hi } = this.box();
    return clamp(lo + (1 - (y - p.y0) / p.h) * (hi - lo), lo, hi);
  }
  private inPlot(x: number, y: number) {
    const p = this.plot();
    return x >= p.x0 - HIT_RADIUS && x <= p.x0 + p.w + HIT_RADIUS && y >= p.y0 - HIT_RADIUS && y <= p.y0 + p.h + HIT_RADIUS;
  }

  /** Pointer position in canvas CSS pixels. The DOM-widget layer is scaled with the canvas
   * zoom, so divide out the ratio between the on-screen and the layout size. */
  private local(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const sx = this.canvas.clientWidth / (r.width || 1);
    const sy = this.canvas.clientHeight / (r.height || 1);
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  private hit(x: number, y: number): number | null {
    let best: number | null = null;
    let bestD = HIT_RADIUS * HIT_RADIUS;
    const { duration, lo, hi } = this.box();
    this.curve().points.forEach(([t, v], i) => {
      const dx = this.tToX(clamp(t, 0, duration)) - x;
      const dy = this.vToY(clamp(v, lo, hi)) - y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) [best, bestD] = [i, d];
    });
    return best;
  }

  /** Grid steps: [time, value] labelled steps for the current size. */
  private steps() {
    const p = this.plot();
    const { duration, lo, hi } = this.box();
    return [niceStep(duration, Math.max(2, p.w / 80)), niceStep(hi - lo, Math.max(2, p.h / 36))];
  }

  // --- editing -------------------------------------------------------------------------------

  private onPointerDown = (e: PointerEvent) => {
    this.canvas.focus();
    if (e.button !== 0 || this.incoming) return;
    const { x, y } = this.local(e);
    if (!this.inPlot(x, y)) return;
    let index = this.hit(x, y);
    if (index === null) {
      // Add a point here, keeping time order (after any point at the same time).
      const point: Point = [this.xToT(x), this.yToV(y)];
      index = this.points.findIndex(([t]) => t > point[0]);
      if (index < 0) index = this.points.length;
      this.points.splice(index, 0, point);
    }
    this.selected = this.hover = index;
    this.drag = { index, time: this.points[index][0] };
    this.canvas.setPointerCapture(e.pointerId);
    this.draw();
  };

  private onPointerMove = (e: PointerEvent) => {
    const { x, y } = this.local(e);
    this.cursor = { x, y };
    if (this.drag) {
      const i = this.drag.index;
      const pts = this.points;
      let t = this.xToT(x);
      let v = this.yToV(y);
      if (e.shiftKey) {
        const [ts, vs] = this.steps().map((s) => s / 4);
        const { lo, hi } = this.box();
        t = Math.round(t / ts) * ts;
        v = clamp(lo + Math.round((v - lo) / vs) * vs, lo, hi);
      }
      if (e.altKey) t = this.drag.time;
      // Points can't pass their neighbours (equal times are allowed: a jump).
      const minT = i > 0 ? pts[i - 1][0] : 0;
      const maxT = i < pts.length - 1 ? pts[i + 1][0] : this.box().duration;
      pts[i] = [clamp(t, minT, maxT), v];
    } else {
      this.hover = this.inPlot(x, y) ? this.hit(x, y) : null;
      this.canvas.style.cursor = this.incoming ? "default" : this.hover !== null ? "grab" : "crosshair";
    }
    this.draw();
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.drag) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.commit();
  };

  private onPointerLeave = () => {
    if (this.drag) return;
    this.cursor = null;
    this.hover = null;
    this.draw();
  };

  private onDoubleClick = (e: MouseEvent) => {
    const { x, y } = this.local(e);
    const i = this.hit(x, y);
    if (i !== null) this.remove(i);
  };

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault(); // no browser or LiteGraph menu over the editor
    const { x, y } = this.local(e);
    const i = this.hit(x, y);
    if (i !== null) this.remove(i);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if ((e.key === "Delete" || e.key === "Backspace") && this.selected !== null) {
      e.preventDefault();
      this.remove(this.selected);
    } else if (e.key === "Escape") {
      this.selected = null;
      this.draw();
    }
  };

  private remove(i: number): void {
    if (this.incoming || !this.points[i]) return;
    this.points.splice(i, 1);
    this.selected = this.hover = null;
    this.commit();
  }

  private commit(): void {
    this.points = this.points.map(([t, v]) => [round(t), round(v)] as Point);
    this.onCommit(this.points);
    this.draw();
  }

  // --- drawing -------------------------------------------------------------------------------

  draw = (): void => {
    const c = this.canvas;
    const { w, h } = this.size();
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const th = theme();
    const p = this.plot();
    const curve = this.curve();
    const { duration, lo, hi } = this.box();
    const accent = this.incoming ? INPUT_ACCENT : ACCENT;

    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, w, h);

    // Grid and axis labels.
    const [ts, vs] = this.steps();
    ctx.font = "10px sans-serif";
    ctx.lineWidth = 1;
    ctx.strokeStyle = th.grid;
    ctx.fillStyle = th.muted;
    ctx.globalAlpha = 0.6;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let t = 0; t <= duration + ts * 1e-6; t += ts) {
      const x = Math.round(this.tToX(t)) + 0.5;
      line(ctx, x, p.y0, x, p.y0 + p.h);
      ctx.globalAlpha = 1;
      ctx.fillText(fmt(t), x, p.y0 + p.h + 5);
      ctx.globalAlpha = 0.6;
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let v = Math.ceil(lo / vs) * vs; v <= hi + vs * 1e-6; v += vs) {
      const y = Math.round(this.vToY(v)) + 0.5;
      line(ctx, p.x0, y, p.x0 + p.w, y);
      ctx.globalAlpha = 1;
      ctx.fillText(fmt(v), p.x0 - 5, y);
      ctx.globalAlpha = 0.6;
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("ms", w - 2, h - 1);
    ctx.strokeStyle = th.muted;
    ctx.strokeRect(p.x0 + 0.5, p.y0 + 0.5, p.w, p.h);

    // The curve, clipped to the box.
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.x0, p.y0, p.w, p.h);
    ctx.clip();
    const pts = curve.points;
    if (pts.length) {
      const X = (t: number) => this.tToX(t);
      const Y = (v: number) => this.vToY(clamp(v, lo, hi));
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(p.x0, Y(pts[0][1])); // held before the first point
      ctx.lineTo(X(pts[0][0]), Y(pts[0][1]));
      for (let i = 0; i + 1 < pts.length; i++) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[i + 1];
        if (curve.interpolation === "step") {
          ctx.lineTo(X(x1), Y(y0));
        } else if (curve.interpolation === "exp" && y0 * y1 > 0) {
          const n = Math.max(2, Math.ceil(Math.abs(X(x1) - X(x0)) / 3));
          for (let k = 1; k < n; k++) ctx.lineTo(X(x0 + ((x1 - x0) * k) / n), Y(segmentValue(y0, y1, k / n, "exp")));
        }
        ctx.lineTo(X(x1), Y(y1));
      }
      ctx.lineTo(p.x0 + p.w, Y(pts[pts.length - 1][1])); // held after the last point
      ctx.stroke();

      // Points: selected in orange, hovered bigger with a ring.
      pts.forEach(([t, v], i) => {
        const x = X(clamp(t, 0, duration));
        const y = Y(v);
        const r = i === this.hover ? POINT_RADIUS + 2 : POINT_RADIUS;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = i === this.selected && !this.incoming ? SELECTED : accent;
        ctx.fill();
        if (i === this.hover) {
          ctx.strokeStyle = th.fg;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      });
    }
    ctx.restore();

    // Value label next to the hovered (or dragged) point.
    if (this.hover !== null && pts[this.hover]) {
      const [t, v] = pts[this.hover];
      const label = `${fmt(t)} ms, ${fmt(v)}${curve.unit ? " " + curve.unit : ""}`;
      ctx.font = "11px sans-serif";
      const tw = ctx.measureText(label).width + 8;
      let x = this.tToX(clamp(t, 0, duration)) + 8;
      let y = this.vToY(clamp(v, lo, hi)) - 22;
      x = Math.min(x, p.x0 + p.w - tw);
      if (y < p.y0) y += 30;
      ctx.fillStyle = th.fg;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x, y, tw, 16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = th.bg;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x + 4, y + 8);
    }
    this.updateSnapshot();
  };
}

function clamp(x: number, lo: number, hi: number) {
  return Math.min(Math.max(x, lo), hi);
}

/** Round to 6 significant digits so the saved JSON stays readable. */
function round(x: number) {
  return +x.toPrecision(6);
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}
