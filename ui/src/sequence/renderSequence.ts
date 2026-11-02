// Proportional (time-space) rendering of an m5.Sequence payload with VexFlow.
//
// Payload (ui.sequence_data[0]) describes a raw, unquantized m5.Sequence:
//
//   { staves: [ { instrument: str|null,
//                 notes: [ { start_ms, duration_ms, pitches: ["C4", ...],
//                            dynamic?, playing_style?, detuning_cents? }, ... ] },
//               ... ],
//     duration_ms: number }
//
// No bar lines, meters or beats. Every event is an identical filled
// quarter-note head placed horizontally at its absolute onset *time*; one
// stacked staff per instrument shares a single horizontal time axis (so
// simultaneous onsets line up vertically), and a horizontal duration line runs
// from each notehead to its end time. Overlapping notes within a staff simply
// draw at their own time positions, which is how multiple voices appear.
import type { RenderContext, StaveNote as StaveNoteT } from "vexflow";

import { type M5Node, fitNodeHeight } from "../common/node";

export interface SequenceNote {
  start_ms: number;
  duration_ms: number;
  pitches?: string[];
  dynamic?: string;
  playing_style?: string;
  detuning_cents?: number;
}

export interface SequenceStaff {
  instrument?: string | null;
  notes?: SequenceNote[];
}

export interface SequenceData {
  staves?: SequenceStaff[];
  duration_ms?: number;
}

let vexModule: Promise<typeof import("vexflow")> | null = null;
function loadVexFlow() {
  vexModule ??= import("vexflow");
  return vexModule;
}

// --- Layout constants (pixels, in the DOM-widget / graph-unit space) ---------
const TOP_PAD = 20; // room for the time-ruler labels along the top
const RULER_GAP = 18; // gap between the ruler and the first staff's reach
const BOTTOM_PAD = 12; // trailing space below the last staff
const STAVE_LEFT = 64; // x where every staff + clef begins; the gutter to
//                        its left holds the instrument name
const ORIGIN_X = STAVE_LEFT + 80; // x where time=0 sits (clears the widest clef)
const RIGHT_PAD = 48; // trailing space after the last event
const STAFF_LINE_GAP = 10; // VexFlow's default staff line spacing
const STAFF_HEIGHT = 4 * STAFF_LINE_GAP; // top line -> bottom line of a 5-line staff
const STAFF_GAP = 28; // minimum vertical gap between adjacent staves
const NOTEHEAD_PAD = 9; // notehead radius + breathing room past ledger lines
const MIN_TOTAL_WIDTH = 360;

type Letter = "c" | "d" | "e" | "f" | "g" | "a" | "b";
type Clef = "treble" | "bass";

// Notehead letter -> semitone, for picking a clef from a staff's pitch range.
const LETTER_SEMITONE: Record<Letter, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
// Notehead letter -> diatonic step within the octave, for measuring how far a
// pitch sits above/below the staff lines (notation is spaced diatonically).
const LETTER_DIATONIC: Record<Letter, number> = { c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, b: 6 };
// Diatonic index (octave*7 + letter step) of each clef's top and bottom lines.
const CLEF_LINES: Record<Clef, { top: number; bottom: number }> = {
  treble: { top: 5 * 7 + 3, bottom: 4 * 7 + 2 }, // F5 (top line) .. E4 (bottom)
  bass: { top: 3 * 7 + 5, bottom: 2 * 7 + 4 }, // A3 (top line) .. G2 (bottom)
};

interface ParsedPitch {
  key: string;
  accidental: string | null;
  midi: number;
  letter: Letter;
  octave: number;
}

// Parse an m5 pitch name ("C4", "A#5", "Bb3", "C##4", "C-1" = C natural octave -1)
// into a VexFlow key ("c/4"), a VexFlow accidental code (or null) and a MIDI
// number. The octave is the trailing signed integer; everything between the
// letter and the octave is the accidental. Sharps are "#"/"x"(double), flats are
// "b"; a "-" only ever appears as the octave's sign (the backend spells flats
// with "b"/"#", never "-").
export function parsePitch(name: string): ParsedPitch | null {
  const m = /^([A-Ga-g])([#bx]*?)(-?\d+)$/.exec(String(name).trim());
  if (!m) return null;
  const letter = m[1].toLowerCase() as Letter;
  const acc = m[2];
  const octave = parseInt(m[3], 10);

  const sharps = (acc.match(/#/g) || []).length + (acc.match(/x/g) || []).length * 2;
  const flats = (acc.match(/b/g) || []).length;
  const semitone = LETTER_SEMITONE[letter] + sharps - flats;
  const midi = (octave + 1) * 12 + semitone;

  let accidental: string | null = null;
  if (sharps === 1) accidental = "#";
  else if (sharps >= 2) accidental = "##";
  else if (flats === 1) accidental = "b";
  else if (flats >= 2) accidental = "bb";

  return { key: `${letter}/${octave}`, accidental, midi, letter, octave };
}

// A "nice" time-axis step (in seconds) so gridlines land ~targetPx apart.
function niceTimeStep(pixelsPerSecond: number, targetPx = 96): number {
  const rawSeconds = targetPx / Math.max(pixelsPerSecond, 1e-6);
  const pow = Math.pow(10, Math.floor(Math.log10(rawSeconds)));
  for (const mult of [1, 2, 5, 10]) {
    const step = mult * pow;
    if (step >= rawSeconds) return step;
  }
  return 10 * pow;
}

function formatSeconds(s: number): string {
  // Trim trailing zeros: 0.5 -> "0.5s", 2 -> "2s", 1.25 -> "1.25s".
  return `${parseFloat(s.toFixed(3))}s`;
}

// Width (px) of a bold label at a given font size, using the SVG context's text
// measurer when available and falling back to a rough character estimate. Leaves
// the context's font set to the measured size.
function measureLabel(ctx: RenderContext, text: string, fontSize: number): number {
  ctx.setFont("Arial", fontSize, "bold");
  try {
    const m = ctx.measureText(text);
    if (m && typeof m.width === "number" && isFinite(m.width) && m.width > 0) {
      return m.width;
    }
  } catch {
    /* fall through to estimate */
  }
  return text.length * fontSize * 0.6;
}

export async function renderSequence(
  node: M5Node,
  el: HTMLDivElement,
  data: SequenceData,
  pixelsPerSecond: number,
): Promise<void> {
  let VF: typeof import("vexflow");
  try {
    VF = await loadVexFlow();
  } catch (err) {
    console.error("[m5.SequenceViewer] failed to render sequence:", err);
    el.textContent = "Failed to render sequence: " + ((err as Error)?.message ?? err);
    return;
  }
  try {
    draw(VF, node, el, data, pixelsPerSecond);
  } catch (err) {
    console.error("[m5.SequenceViewer] failed to render sequence:", err);
    el.textContent = "Failed to render sequence: " + ((err as Error)?.message ?? err);
  }
}

function draw(
  VF: typeof import("vexflow"),
  node: M5Node,
  el: HTMLDivElement,
  data: SequenceData,
  pixelsPerSecond: number,
): void {
  el.innerHTML = "";

  const staves = (data && data.staves) || [];
  const durationMs = (data && data.duration_ms) || 0;
  const pxPerSecond = pixelsPerSecond > 0 ? pixelsPerSecond : 120;
  const pxPerMs = pxPerSecond / 1000;

  if (staves.length === 0) {
    el.textContent = "Sequence is empty.";
    requestAnimationFrame(() => fitNodeHeight(node, el));
    return;
  }

  const timeX = (ms: number) => ORIGIN_X + ms * pxPerMs;
  const totalWidth = Math.max(MIN_TOTAL_WIDTH, timeX(durationMs) + RIGHT_PAD);

  // --- Pre-pass: per-staff clef + how far its noteheads reach above the top
  // and below the bottom staff line. Pitches are placed diatonically, so a
  // very high/low note pushes ledger lines well past the five lines; measuring
  // that reach lets us pad the layout so extreme notes are never clipped. -----
  const HALF_LINE = STAFF_LINE_GAP / 2; // vertical px per diatonic step
  const layout = staves.map((staff) => {
    const notes = staff.notes || [];

    // Pick a clef from the staff's median pitch (treble for >= middle C), and
    // track the highest/lowest diatonic position for the vertical padding.
    const midis: number[] = [];
    let maxDia = -Infinity;
    let minDia = Infinity;
    for (const n of notes) {
      for (const p of n.pitches || []) {
        const parsed = parsePitch(p);
        if (!parsed) continue;
        midis.push(parsed.midi);
        const dia = parsed.octave * 7 + LETTER_DIATONIC[parsed.letter];
        if (dia > maxDia) maxDia = dia;
        if (dia < minDia) minDia = dia;
      }
    }
    midis.sort((a, b) => a - b);
    const median = midis.length ? midis[Math.floor(midis.length / 2)] : 71;
    const clef: Clef = median >= 60 ? "treble" : "bass";
    const lines = CLEF_LINES[clef];

    let above = NOTEHEAD_PAD;
    let below = NOTEHEAD_PAD;
    if (midis.length) {
      above = Math.max(above, (maxDia - lines.top) * HALF_LINE + NOTEHEAD_PAD);
      below = Math.max(below, (lines.bottom - minDia) * HALF_LINE + NOTEHEAD_PAD);
    }
    return { staff, notes, clef, above, below, top: 0 };
  });

  // Stack the staves, giving each its measured headroom/legroom plus a gap.
  let staffY = TOP_PAD + RULER_GAP + layout[0].above;
  layout.forEach((L, i) => {
    L.top = staffY;
    const nextAbove = i + 1 < layout.length ? layout[i + 1].above : 0;
    staffY += STAFF_HEIGHT + L.below + STAFF_GAP + nextAbove;
  });
  const lastL = layout[layout.length - 1];
  const totalHeight = lastL.top + STAFF_HEIGHT + lastL.below + BOTTOM_PAD;

  const renderer = new VF.Renderer(el, VF.Renderer.Backends.SVG);
  renderer.resize(Math.ceil(totalWidth), Math.ceil(totalHeight));
  const ctx = renderer.getContext();

  // --- Time ruler: full-height gridlines + second labels along the top ----
  const step = niceTimeStep(pxPerSecond);
  const stepMs = step * 1000;
  ctx.setFont("Arial", 9, "");
  for (let t = 0; t <= durationMs + 1e-6; t += stepMs) {
    const x = timeX(t);
    ctx.setStrokeStyle("#e2e2e2");
    ctx.setLineWidth(1);
    ctx.beginPath();
    ctx.moveTo(x, TOP_PAD);
    ctx.lineTo(x, totalHeight - 8);
    ctx.stroke();
    ctx.setFillStyle("#888");
    ctx.fillText(formatSeconds(t / 1000), x + 2, 12);
  }

  // --- One stacked staff per instrument -----------------------------------
  layout.forEach((L) => {
    const { staff, notes, clef } = L;
    const staffTop = L.top;

    // Zero VexFlow's built-in head/legroom (default space_above_staff_ln = 4,
    // i.e. ~40px) so staffTop is exactly the top line. That makes our measured
    // above/below padding and totalHeight match what VexFlow actually draws --
    // otherwise every staff sits 40px lower than budgeted and the bottom one
    // gets clipped.
    const stave = new VF.Stave(STAVE_LEFT, staffTop, totalWidth - STAVE_LEFT, {
      space_above_staff_ln: 0,
      space_below_staff_ln: 0,
    });
    stave.addClef(clef);
    // Force solid black: the ruler/notes leave a lighter fill style on the
    // context, which otherwise tinted the first clef gray.
    ctx.setFillStyle("#000");
    stave.setContext(ctx).draw();

    // Instrument label: directly left of the clef, baseline-aligned to the
    // staff's middle line. Shrunk to fit the gutter, right-aligned so it abuts
    // the clef.
    const label = staff.instrument || "(unnamed)";
    const avail = STAVE_LEFT - 10;
    let fontSize = 11;
    let labelWidth = measureLabel(ctx, label, fontSize);
    while (labelWidth > avail && fontSize > 7) {
      fontSize -= 1;
      labelWidth = measureLabel(ctx, label, fontSize);
    }
    ctx.setFont("Arial", fontSize, "bold");
    ctx.setFillStyle("#000");
    ctx.fillText(
      label,
      Math.max(2, STAVE_LEFT - 8 - labelWidth),
      stave.getYForLine(2) + Math.round(fontSize * 0.34),
    );

    // --- Each event: a quarter-note head placed at its onset time ---------
    for (const note of notes) {
      const parsedList = (note.pitches || [])
        .map(parsePitch)
        .filter((p): p is ParsedPitch => p !== null)
        .sort((a, b) => a.midi - b.midi);

      const isUnpitched = parsedList.length === 0;
      // Unpitched events get a single notehead on the staff's middle line.
      const keys = isUnpitched
        ? [clef === "bass" ? "d/3" : "b/4"]
        : parsedList.map((p) => p.key);

      let staveNote: StaveNoteT;
      try {
        staveNote = new VF.StaveNote({ clef, keys, duration: "q" });
        if (!isUnpitched) {
          parsedList.forEach((p, idx) => {
            if (p.accidental) staveNote.addModifier(new VF.Accidental(p.accidental), idx);
          });
        }
      } catch (e) {
        console.warn("[m5.SequenceViewer] skipping unrenderable note", note, e);
        continue;
      }

      staveNote.setStave(stave).setContext(ctx);
      const tc = new VF.TickContext();
      tc.addTickable(staveNote);
      tc.preFormat();
      // Place the notehead exactly at timeX(start_ms): probe where it lands
      // when the tick context sits at x=0 (this folds in the clef width and
      // VexFlow's internal padding, which differ per clef), then offset so
      // every staff's onsets align to the same shared time axis.
      tc.setX(0);
      let baseX: number;
      try {
        baseX = staveNote.getAbsoluteX();
      } catch {
        baseX = stave.getNoteStartX();
      }
      tc.setX(timeX(note.start_ms) - baseX);
      ctx.setFillStyle("#000"); // keep noteheads + accidentals black
      staveNote.draw();

      // Duration line: notehead -> end-time x, at the lowest notehead's y.
      const startX = timeX(note.start_ms);
      const endX = timeX(note.start_ms + note.duration_ms);
      const ys = staveNote.getYs ? staveNote.getYs() : [];
      const lineY = ys.length ? Math.max(...ys) : staffTop + 2 * STAFF_LINE_GAP;
      if (endX > startX + 1) {
        ctx.setStrokeStyle("#000");
        ctx.setLineWidth(2);
        ctx.beginPath();
        ctx.moveTo(startX + 6, lineY);
        ctx.lineTo(endX, lineY);
        ctx.stroke();
      }
    }
  });

  requestAnimationFrame(() => fitNodeHeight(node, el));
}
