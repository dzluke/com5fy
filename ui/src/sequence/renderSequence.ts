// Proportional (time-space) rendering of an m5.Sequence payload with VexFlow.
//
// Payload (ui.sequence_data[0]) describes a raw, unquantized m5.Sequence:
//
//   { staves: [ { instrument: str|null,
//                 notes: [ { start_ms, duration_ms, pitches: ["C4", ...],
//                            dynamic?, playing_style?, articulations?: [str],
//                            detuning_cents?: [one per pitch] }, ... ] },
//               ... ],
//     duration_ms: number }
//
// The backend sends dynamic / playing_style only where they change on a staff,
// so they are drawn as a score shows them: the dynamic below the staff and the
// text playing style ("pizz.") above it, at the note's onset. Articulations are
// drawn as their usual symbols on the notehead side (text when VexFlow has no
// symbol). A ±50 cent detuning is drawn as a quarter-tone accidental; any other
// detuning keeps the semitone accidental and gets a small cents label (+14).
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
  articulations?: string[];
  detuning_cents?: number[];
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
const TEXT_ROW = 15; // height of one row of dynamics / playing-style text
const TEXT_FONT = 11;

/** Pixels per second at zoom 1 (the Python node's BASE_PIXELS_PER_SECOND). */
export const BASE_PIXELS_PER_SECOND = 120;

// MusicXML articulation names (what m5 puts in playing_style) -> VexFlow codes.
const ARTICULATION_CODES: Record<string, string> = {
  staccato: "a.",
  staccatissimo: "av",
  spiccato: "av",
  accent: "a>",
  tenuto: "a-",
  "strong-accent": "a^",
  "snap-pizzicato": "ao",
  stopped: "a+",
  harmonic: "ah",
  "up-bow": "a|",
  "down-bow": "am",
};
// Articulations that sit above the staff whichever way the stem goes.
const ALWAYS_ABOVE = new Set(["up-bow", "down-bow", "snap-pizzicato", "stopped", "harmonic"]);

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
  /** Semitones of the written accidental (sharps positive). */
  alter: number;
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

  return { key: `${letter}/${octave}`, accidental, alter: sharps - flats, midi, letter, octave };
}

/**
 * How to draw a pitch detuned by `cents`: a quarter-tone accidental when the
 * pitch is a quarter tone off (B −50 → B quarter-flat, C# +50 → C three-quarter
 * sharp, on the same staff position), else the semitone accidental plus a
 * cents label, the way spectral scores mark other deviations.
 */
export function microtonalSpelling(
  p: ParsedPitch,
  cents: number,
): { accidental: string | null; label: string | null } {
  const rounded = Math.round(cents);
  if (rounded === 0) return { accidental: p.accidental, label: null };
  if (Math.abs(rounded) === 50) {
    const quarterTones: Record<string, string> = { "-1.5": "db", "-0.5": "d", "0.5": "+", "1.5": "++" };
    const code = quarterTones[String(p.alter + rounded / 100)];
    if (code) return { accidental: code, label: null };
  }
  return { accidental: p.accidental, label: rounded > 0 ? `+${rounded}` : `\u2212${-rounded}` };
}

// Rough width of a text label, for placing labels before anything is drawn.
function estimateWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.55;
}

/**
 * Assign each label a row so labels in one row don't overlap: the first row
 * whose last label ends before this one starts. Returns the row per label and
 * the number of rows used.
 */
function stackLabels(items: { x: number; width: number }[]): { rows: number[]; count: number } {
  const ends: number[] = [];
  const rows = items.map(({ x, width }) => {
    let row = ends.findIndex((end) => x >= end + 4);
    if (row < 0) row = ends.length;
    ends[row] = x + width;
    return row;
  });
  return { rows, count: ends.length };
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
  zoom: number,
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
    // Keep the view on the same moment in time when the zoom changes.
    const ratio = el.scrollWidth > el.clientWidth ? (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth : 0;
    draw(VF, node, el, data, BASE_PIXELS_PER_SECOND * (zoom > 0 ? zoom : 1));
    if (ratio) el.scrollLeft = Math.max(0, ratio * el.scrollWidth - el.clientWidth / 2);
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
    // Articulations sit under the noteheads (stems go up): leave room for them.
    if (notes.some((n) => n.articulations?.length)) below += 12;

    // Text rows: playing styles (and articulations without a symbol) above
    // the staff, dynamics below it.
    const styleItems = notes.flatMap((n) => {
      const texts = [
        n.playing_style,
        ...(n.articulations || []).filter((a) => !(a in ARTICULATION_CODES)),
      ].filter((t): t is string => !!t);
      if (!texts.length) return [];
      const text = texts.join(", ");
      return [{ note: n, text, x: timeX(n.start_ms) - 4, width: estimateWidth(text, TEXT_FONT) }];
    });
    const dynamicItems = notes.flatMap((n) =>
      n.dynamic
        ? [{ note: n, text: n.dynamic, x: timeX(n.start_ms) - 4, width: estimateWidth(n.dynamic, TEXT_FONT + 2) }]
        : [],
    );
    const styleRows = stackLabels(styleItems);
    const dynamicRows = stackLabels(dynamicItems);
    above += styleRows.count * TEXT_ROW;
    below += dynamicRows.count * TEXT_ROW;
    return {
      staff, notes, clef, above, below, top: 0,
      styleItems, styleRows: styleRows.rows,
      dynamicItems, dynamicRows: dynamicRows.rows,
      noteAbove: above - styleRows.count * TEXT_ROW,
      noteBelow: below - dynamicRows.count * TEXT_ROW,
    };
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
      // Pair each pitch with its detuning before sorting by height.
      const parsedList = (note.pitches || [])
        .map((name, i) => ({ p: parsePitch(name), cents: note.detuning_cents?.[i] ?? 0 }))
        .filter((x): x is { p: ParsedPitch; cents: number } => x.p !== null)
        .map(({ p, cents }) => ({ ...p, ...microtonalSpelling(p, cents) }))
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
        for (const name of note.articulations || []) {
          const code = ARTICULATION_CODES[name];
          if (!code) continue;
          const articulation = new VF.Articulation(code);
          articulation.setPosition(
            ALWAYS_ABOVE.has(name) ? VF.Modifier.Position.ABOVE : VF.Modifier.Position.BELOW,
          );
          staveNote.addModifier(articulation, 0);
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

      // Cents labels for detunings that aren't quarter tones, by each notehead.
      ctx.setFont("Arial", 8, "");
      ctx.setFillStyle("#555");
      parsedList.forEach((p, idx) => {
        if (p.label && ys[idx] !== undefined) ctx.fillText(p.label, startX + 8, ys[idx] - 5);
      });
    }

    // Playing styles above the staff, dynamics below, at each note's onset.
    const styleTop = staffTop - L.noteAbove;
    ctx.setFillStyle("#000");
    ctx.setFont("Times New Roman", TEXT_FONT, "normal", "italic");
    L.styleItems.forEach((item, i) => {
      ctx.fillText(item.text, item.x, styleTop - L.styleRows[i] * TEXT_ROW - 4);
    });
    const dynamicTop = staffTop + STAFF_HEIGHT + L.noteBelow;
    ctx.setFont("Times New Roman", TEXT_FONT + 2, "bold", "italic");
    L.dynamicItems.forEach((item, i) => {
      ctx.fillText(item.text, item.x, dynamicTop + (L.dynamicRows[i] + 1) * TEXT_ROW - 3);
    });
  });

  requestAnimationFrame(() => fitNodeHeight(node, el));
}
