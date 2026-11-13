// BPF math shared by the editor: the same interpolation rules as m5.BPF.evaluate
// (mmmmm/src/m5/bpf.py), so what the node draws is what the backend computes.

export type Interpolation = "step" | "linear" | "exp";
export type Point = [number, number]; // [time_ms, value]

/** What the editor draws: the points plus the box they live in. */
export interface Curve {
  points: Point[];
  interpolation: Interpolation;
  duration: number; // ms, length of the time axis
  lo: number; // value axis bottom
  hi: number; // value axis top
  /** Value axis actually shown, when it differs from lo..hi: incoming curves zoom to their data. */
  view?: [number, number];
  name: string;
  unit: string;
}

/** The node's ui payload (nodes/create.py `_bpf_payload`). */
export interface BPFPayload {
  points: Point[];
  interpolation: Interpolation;
  range: [number, number];
  duration: number;
  name: string;
  unit: string;
  source: "input" | "editor";
}

/** Parse the points widget's JSON; bad or missing values give no points. */
export function parsePoints(json: unknown): Point[] {
  try {
    const data = typeof json === "string" ? JSON.parse(json || "[]") : json;
    if (!Array.isArray(data)) return [];
    return data
      .filter((p) => Array.isArray(p) && p.length >= 2 && isFinite(+p[0]) && isFinite(+p[1]))
      .map((p) => [+p[0], +p[1]] as Point)
      .sort((a, b) => a[0] - b[0]);
  } catch {
    return [];
  }
}

/** Value between two points at fraction `f` (0..1), per m5's rules. */
export function segmentValue(y0: number, y1: number, f: number, interp: Interpolation): number {
  if (interp === "step") return y0;
  // Geometric ("exp") only when both ends have the same sign; otherwise linear, like m5.
  if (interp === "exp" && y0 * y1 > 0) return y0 * Math.pow(y1 / y0, f);
  return y0 + (y1 - y0) * f;
}

/** The curve's value at time t (holds the end values outside the points). */
export function evaluate(points: Point[], interp: Interpolation, t: number): number | null {
  if (!points.length) return null;
  if (t < points[0][0]) return points[0][1];
  // Last point at or before t (a jump: the later of two equal times wins).
  let i = 0;
  while (i + 1 < points.length && points[i + 1][0] <= t) i++;
  if (i === points.length - 1) return points[i][1];
  const [x0, y0] = points[i];
  const [x1, y1] = points[i + 1];
  return segmentValue(y0, y1, (t - x0) / (x1 - x0), interp);
}

/** A "nice" grid step (1, 2 or 5 × 10^k) giving about `target` divisions of `span`. */
export function niceStep(span: number, target: number): number {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
}

/** Short number label: up to 4 significant digits, no trailing zeros. */
export function fmt(x: number): string {
  if (x === 0) return "0";
  const a = Math.abs(x);
  if (a >= 1e5 || a < 1e-3) return x.toExponential(2).replace(/\.?0+e/, "e");
  return String(+x.toPrecision(a >= 1000 ? 6 : 4));
}
