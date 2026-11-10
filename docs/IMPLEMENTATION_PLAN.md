# Musica ex Machina — Implementation Plan

This is the working plan for building the music environment described in
[Music Environment Technical Specification.md](../../../Music%20Environment%20Technical%20Specification.md)
(kept in the ComfyUI root, outside this repo).
It turns that spec into an ordered list of tasks, each about one Claude Code session
long, with clear "done" criteria, so the system can be built step by step over many
sessions.

The spec says **what** the system is and **why**. This file says **how** and **in what order**.
When the two disagree, the spec wins on goals and this file wins on implementation details.
Fix whichever one is out of date.

---

## 0. How to use this file (session protocol)

Every Claude session working on this project should:

1. **Read** this file (at least §1 Current state, §3 Conventions and the milestone you're working on).
2. **Pick** the first unchecked task whose `Depends on` tasks are all checked. If the user named a task, do that one.
3. **Check what's already there** before writing code. Read the relevant files in `mmmmm/src/m5/` and `custom_nodes/com5fy/`.
4. **Build it** following §3. Core logic goes in `m5`, ComfyUI wiring goes in `com5fy`.
5. **Verify it**: run `pytest` in `mmmmm/`, run the com5fy tests, and for UI tasks load the node in a running ComfyUI and check it in the browser.
6. **Update this file**: tick the task, add one line to the §9 Session log (date, task ID, what changed, anything left open), and write down any new decision in §2.
7. **Commit and push** in each repo that changed (`mmmmm` and `com5fy` are separate git repos; the ComfyUI folder itself is not a repo).
   The user has given standing permission to commit and push to both whenever a task is finished.
8. **Hand off a test workflow** whenever the session added a new feature (see below).

### New-feature handoff (required)

Whenever a session adds a new user-facing feature (a new node, type, conversion, UI, or a visible change in behavior),
it ends by giving the user something to try by hand. Sessions that only do internal work (tests, refactors,
docs, tooling) skip this and just summarize what changed.

1. **A test workflow** saved as `custom_nodes/com5fy/workflows/<task-id>_<short-name>.json` (ComfyUI UI format, so it
   can be dragged onto the canvas or opened from the Workflows sidebar). It must exercise what the session built,
   use only files that exist (inputs in ComfyUI's `input/`, or fixtures shipped in the repo), and have a Note node on the
   canvas explaining what to look at. Check it loads and runs in ComfyUI before handing it off.
2. **A change note** in the final message and in `docs/changes/<YYYY-MM-DD>_<task-id>.md`:
   - **What changed:** new/changed nodes, types and library functions, with file links, and the commits pushed per repo.
   - **How to test:** restart ComfyUI if Python changed (or rebuild the frontend), open the workflow, and the exact
     steps, inputs and the expected result.
   - **Known limitations** and anything mocked.
   - **Feedback wanted:** the specific choices the user should react to (look, defaults, naming, musical behavior).
3. User feedback starts the next session: apply it first (or add it as tasks here), then continue with the next task.

Task status markers: `[ ]` todo · `[~]` in progress / partly done · `[x]` done · `[!]` blocked (say on what).

Tasks marked **⚑ external** depend on another IRCAM team's research (MCP team, Analyse-Synthèse, AFTER/RAVE authors).
For these we build the plumbing (types, engine interface, node, UI) against a **mock engine**,
so the pipeline works end to end and the real model can be dropped in later.

---

## 1. Current state (snapshot, 2026-11-02)

Timeline check: Phase 1 (May–Oct 2026) has ended. We are at the start of **Phase 2 (v0.1 prototype, due April 2027)**.

### Layout

```
ComfyUI/                         upstream ComfyUI checkout (not a git repo here)
├── pyproject.toml               uv workspace: depends on mmmmm
├── mmmmm/                       git repo — core library, package name `m5`
│   └── src/m5/
│       ├── audio.py             Audio(waveform: np.ndarray (C, T) float32, sample_rate)
│       ├── time.py              Event (duration ms + list-valued fields), Sequence ((start_ms, item) list, nestable, optional time_map)
│       ├── timemap.py           TimeMap: tempo + meter changes, pickup; ms ⇄ quarters ⇄ (measure, beat); from score / MIDI
│       ├── score.py             Score (wraps music21.stream.Score), from_file, from_sequence (quantize), to_sequence, to_musicxml
│       ├── render.py            render_sequence(Sequence) -> Audio (mixes audio carried by events)
│       ├── orchidea.py          orchestrate(Audio, params, database) -> Orchestration; SoundDatabase; connection.txt parser
│       ├── orch_config.txt      default Orchidea config
│       └── bin/orchestrate      bundled Orchidea binary (universal macOS: arm64 + x86_64)
└── custom_nodes/com5fy/         git repo — ComfyUI nodes using m5
    ├── docs/IMPLEMENTATION_PLAN.md   this file
    ├── nodes/                   types.py (M5_SCORE, M5_SEQUENCE), boundary.py, convert.py, data.py, io.py,
    │                            paths.py (folder_paths: models/m5/orchidea_db)
    ├── tests/                   pytest, calls each node's execute directly; test_workflows.py runs workflows/api
    ├── workflows/               UI-format workflows; api/ (API format) + run.py headless runner; inputs/ fixtures
    ├── ui/                      TypeScript + React sources (Vite): score/ (OSMD), sequence/ (VexFlow), audio/
    └── js/                      build output, committed: com5fy.js (the only extension entry) + chunks/*.mjs (OSMD, VexFlow, lazy)
```

Frontend: edit `ui/src/`, then `cd ui && npm ci && npm run build` (reproducible) and commit `js/`. ComfyUI imports every
`*.js` under `js/`, so the build emits exactly one `.js`; the OSMD/VexFlow chunks are `.mjs` and load on first render.

### What exists

| Node (`node_id`)      | What it does |
|-----------------------|--------------|
| `m5_Orchidea`         | AUDIO → Score + Sequence + orchestrated AUDIO (audio → score via Orchidea); database dropdown from `models/m5/orchidea_db` |
| `m5_LoadScore`        | file (MusicXML/MIDI/ABC…) → Score |
| `m5_ScoreViewer`      | displays a Score as engraved notation (OSMD, single horizontal staff line) |
| `m5_SequenceViewer`   | displays a Sequence as proportional, time-based notation, with dynamics, text styles, articulations, microtones; live `zoom` |
| `m5_SequenceToAudio`  | Sequence → AUDIO (mixes the samples carried by events) |
| `m5_ScoreToSequence`  | Score → Sequence (`Score.to_sequence`: the score's tempo marks, 120 BPM without) |
| `m5_SequenceToScore`  | Sequence → Score (`Score.from_sequence`: quantization grid + bpm, 0 = estimated) |
| `m5_AudioPlayback`    | waveform display + playback |

Nodes use the new `comfy_api.latest.io` schema API (`io.ComfyNode`, `define_schema`, `ComfyExtension`).
Audio crosses the node boundary as ComfyUI's builtin `AUDIO` (`{"waveform": torch (B, C, T), "sample_rate"}`),
converted by `_to_m5_audio` / `_to_comfy_audio` in `nodes/boundary.py`.

### What's missing (big picture)

m5 and com5fy have pytest suites (`mmmmm/tests/`, `custom_nodes/com5fy/tests/`). No MIDI, Descriptor, Control-data (Text/Number/BPF) types. No data-node history. No LLM integration.
No score→audio, no editing nodes, no import/export beyond loading a score file, no Code / Custom nodes,
no timeline, no model nodes. Orchidea's sound database (TinySOL) is still installed by hand into `models/m5/orchidea_db`.

---

## 2. Architecture and key decisions

Decisions confirmed by the user on 2026-11-02 (answers to the former open questions):

- **Repos:** `mmmmm` and `com5fy` stay separate. This plan lives in `com5fy/docs/`.
- **Sequence as conversion hub** (§2.3) and **engine registry** (§2.4): approved.
- **LLM server:** llama.cpp (`llama-server`) for now (§2.6).
- **Generated code:** no strict sandboxing for now (§2.7).
- **Score + text:** no bach MCP integration; build the LLM code-generation engine (M5.3).
- **Graph feedback:** not now, unless an elegant solution turns up (M8.6).
- **External software priority:** MuseScore, Ableton, Premiere. Max/bach and DaVinci Resolve are deferred.
- **Platform:** M-series Macs only.
- **Frontend:** TypeScript + React (M0.6).

### 2.1 Two layers (from the spec)

1. **`m5` core library (Python, no ComfyUI imports).** Data types, conversions, editing logic,
   engine adapters, LLM client. Must be usable from a plain script or notebook and fully testable without ComfyUI.
2. **`com5fy` ComfyUI node library.** Thin wrappers: declare inputs/outputs, convert between
   ComfyUI types and m5 types at the boundary, call m5, return UI payloads. Frontend JS/TS for viewers,
   the timeline and any sidebar.

Rule: if a function would be useful outside ComfyUI, it belongs in `m5`.

### 2.2 Data types

| Spec type | m5 class | ComfyUI type | Notes |
|---|---|---|---|
| Audio | `m5.Audio` | builtin `AUDIO` | exists |
| Event | `m5.Event` | — | exists; carried inside a Sequence |
| Sequence | `m5.Sequence` | `M5_SEQUENCE` | exists; ms timebase |
| Score | `m5.Score` | `M5_SCORE` | exists; music21-backed. Needs metered + proportional modes |
| MIDI | `m5.Midi` | `M5_MIDI` | **todo**; wraps a list of tracks/notes/CCs + tempo map (via `mido` or `pretty_midi`) |
| Descriptor | `m5.Descriptor` | `M5_DESCRIPTOR` | **todo**; named time series: `{name: (times_ms, values)}` + units/range, plus optional partials/frames matrices |
| Text | `str` | builtin `STRING` | reuse builtin |
| Number | `float` | builtin `FLOAT`/`INT` | reuse builtin |
| BPF / automation | `m5.BPF` | `M5_BPF` | **todo**; `(time_ms, value)` points + interpolation mode + range |
| Model handle | `m5.ModelRef` | `M5_MODEL` | **todo**; points at a loaded RAVE/AFTER/LoRA/LLM |
| Time map | `m5.TimeMap` | — | exists (M2.2); tempo + meter map, ms ↔ quarters ↔ (measure, beat); see §2.3 |
| Origin | `m5.Origin` | — | **todo**; attached to any representation, see 2.5 |

### 2.3 Sequence as the conversion hub

The spec lists 16 conversion pairs between audio, score, MIDI and descriptor, plus edit and create nodes.
Instead of writing every pair, symbolic types convert through `Sequence`:

```
Score ⇄ Sequence ⇄ MIDI          (symbolic, exact-ish, no models needed)
Descriptor ⇄ Sequence             (onsets/partials become events)
Audio → {Score, MIDI, Descriptor, Sequence}   via engines (Orchidea, pitch tracking, analysis…)
{Score, MIDI, Descriptor, Sequence} → Audio   via engines (render, AFTER, resynthesis…)
```

So `score → MIDI` = `Score.to_sequence()` then `Midi.from_sequence()`. Each class gets
`from_sequence` / `to_sequence`. Direct paths are only added where the round trip loses information.

**Score ⇄ Sequence details (M2.1).** `Score.to_sequence` gives one sub-Sequence per part (added at 0 ms), one Event
per note/chord/unpitched note; rests are gaps, tie chains are one Event (articulations from any tied note kept).
Dynamics and text expressions sit **only on the Event where the marking appears** (the first note at or after it), as
in the score (user decision 2026-11-05). `from_sequence` writes a marking when it differs from the last one written, so
Sequences that repeat them on every event (Orchidea's) still give one marking per change; a repeated identical marking
is dropped. `playing_style` holds the text expression first, then the note's articulations as MusicXML-style names
(`"staccato"`, `"strong-accent"`, list in `m5.ARTICULATIONS`); `from_sequence` turns those back into articulations
and treats the first other value as the text expression. The Sequence Viewer shows them the same way (dynamic and
text style only where they change on a staff).
**Tempo** (2026-11-05): a score with no metronome mark is read at `DEFAULT_BPM` = **120** (music21, MIDI, notation
software). `Score to Sequence` always uses the score's marks (no bpm widget; `to_sequence(bpm=)` remains in m5).
`from_sequence(bpm=None)` estimates the tempo with `m5.estimate_bpm` (`tempo.py`): a grid search over 40–200 BPM
for the beat that puts onsets on the simplest subdivisions, leaves few beats empty and is near 100 BPM; the half/double
tempo ambiguity is settled by that prior. The Orchidea node keeps a fixed 60 BPM. The metronome mark is written into the
first part (on the Score itself MusicXML export dropped it).
**m5 pitch names** are `<letter><accidental><octave>` with `#`/`x` sharps and `b` flats; `-` is only the octave sign
(`"C-1"`), unlike music21's `"B-4"`. Microtones (music21 microtones and quarter-tone accidentals) become the
`detuning_cents` custom field, one value per pitch, with the name the **nearest tempered pitch** on the written step and
the cents within ±50 (C +70 → C# −30; B quarter-flat → B −50): the usual data convention (Orchidea, MIDI pitch bend,
cents annotations in spectral scores). `from_sequence` writes ±50 as quarter-tone accidentals (MusicXML
`quarter-flat` etc., what notation software shows) and other values as microtones (fractional `alter`); the Sequence
Viewer draws ±50 as quarter-tone accidentals and other deviations as a cents label.
`from_sequence` parses names with the same rules (it used to pass them to music21, which read `"C-1"` as C♭1).
**TimeMap** (M2.2, `timemap.py`): tempo changes (`TempoChange(quarters, bpm, referent)`, the referent kept so ♩. = 60
is written back as such) and meter changes (`MeterChange(quarters, numerator, denominator)`), both keyed by position in
**quarter notes**, plus `pickup` (quarters of an anacrusis, numbered `first_measure - 1`) and `first_measure` (1, or more
for an excerpt). A meter change starts a new measure; mid-measure (MIDI can do it) the measure before is cut short.
Beats are 1-based in units of the meter's denominator (6/8 counts eighths); pickup beats count from the end of the bar
(a one-quarter pickup in 4/4 is beat 4). Tempo changes are instantaneous (no accel./rit. ramps yet).
Sources: `TimeMap.from_score` / `Score.time_map` (metronome marks, time signatures, first measure's `paddingLeft`),
`TimeMap.from_midi_events(tpq, tempos, time_signatures)` + `to_midi_events` (the hook for `m5.Midi`, M2.4, independent
of the MIDI library) and `TimeMap.from_midi_file` (music21's MIDI reader, no new dependency).
**A Sequence carries an optional `time_map`** (decision 2026-11-10): ms stay authoritative, the map only interprets
them; only the outermost Sequence's map counts. `Score.to_sequence` sets it; `Score.from_sequence` picks its map as:
explicit `time_map=` › the Sequence's map › with `bpm` given, one tempo in the Sequence's *first* meter only (a forced
tempo moves its later barlines in time) or 4/4 › estimated tempo in 4/4. So Score → Sequence → Score keeps tempo and
meter changes and the pickup; `Sequence to Score` `bpm` 0 now means "the Sequence's map, else estimate". Time
signatures are written into every part, tempo marks into the first; a pickup is made by `_make_pickup` (measures made
with the music shifted by the unplayed part of bar 0, then shifted back with `paddingLeft`).

### 2.4 Engines

Each transformation node has an **engine** dropdown (the "Select Model" box in the spec diagrams).
An engine is a class in `m5.engines` implementing a small protocol for one kind of transformation:

```python
class AudioToScoreEngine(Protocol):
    name: str
    def run(self, audio: Audio, params: dict) -> Score | Sequence: ...
```

Engines register themselves in a registry; nodes list the registered engines for their transformation.
Every ⚑ external transformation starts with a `Mock…Engine` that returns something plausible (e.g. a transposed copy).
Engines that need conflicting dependencies (e.g. a specific torch version, a Max patch, a binary) run out of process
(subprocess / HTTP / OSC) so the ComfyUI environment stays clean.

### 2.5 Provenance and the shared timeline (from the spec, shape proposed)

Anything imported from external software carries an `Origin`:
`software` (ableton/musescore/max/premiere/file), `project` (path or id), `item` (track/clip/part id),
`start_ms`, `end_ms`, optional `measures` range and that project's `TimeMap`.
Transformations copy the input's Origin to the output by default. Export nodes use it to put results
back in the same place, and the timeline uses it to line up projects ("measures 8–16 in MuseScore = 3:15–4:30 in Ableton").

### 2.6 Local LLM

`m5.llm.LLMClient` talks to a **local OpenAI-compatible HTTP server**, by default llama.cpp's `llama-server`
(Metal build on M-series Macs, GGUF models from `models/m5/llm`), configured by base URL + model name.
Keeping to the OpenAI-compatible API means Ollama / LM Studio / MLX can be swapped in later without code changes.
No cloud calls by default (spec solution 7).
The LLM is used through narrow, structured tasks (JSON output validated against a schema, or Python code
validated before running) to keep context small on 7–30B models. Agent orchestration (smolagents / LangGraph / PocketFlow)
is only brought in if simple tool-calling loops stop being enough.

### 2.7 Running generated code

Code nodes and LLM-written transforms run Python. No strict sandboxing for now (user decision): code runs in a
subprocess with a time limit so a hang or crash can't take down ComfyUI, gets m5 objects in and out (pickled),
and the generated code is always shown in the node so the user can see what ran.

### 2.9 Frontend

Frontend code moves to **TypeScript + React**, based on the
[ComfyUI React extension template](https://github.com/Comfy-Org/ComfyUI-React-Extension-Template):
sources in `com5fy/ui/` (Vite build), npm-managed dependencies (OSMD, VexFlow, etc.), built output in `com5fy/js/`
(committed, so users don't need Node to install). The plain-JS viewers were ported in M0.6. Pinned: OSMD 1.9.0,
VexFlow 4.2.5 (same as the old vendored bundles), React 18.3.1, `@comfyorg/comfyui-frontend-types` 1.43.18 (matches the
installed frontend; 1.57.6 is a broken publish), Vite 6.

### 2.8 Models and files

Models live under ComfyUI's `models/` folder, registered through `folder_paths`
(`models/m5/rave`, `models/m5/after`, `models/m5/loras`, `models/m5/llm`, `models/m5/orchidea_db`).
Exported files go to ComfyUI's `output/`; imported files come from `input/`.
Registration lives in `com5fy/nodes/paths.py`, which also creates the default folders.

An Orchidea database (M1.2) is a `<Name>.<features>.db` analysis file with its `<Name>/` samples folder next to it
(Orchidea's own dataset layout); the node's dropdown lists every `.db` file under `orchidea_db` (spectrum ones first)
and `m5.SoundDatabase.from_db_file` infers the samples folder (falling back to the `.db` file's folder). The bundled
`orch_config.txt` keeps placeholder database paths; the node always passes a database.

---

## 3. Conventions

- **Target platform: M-series macOS only.** Use MPS for torch models where available.
- **Python 3.12**, `uv` for environments (see `custom_nodes/com5fy/README.md` for setup).
- **m5 must not import** `comfy`, `comfy_api`, `folder_paths` or `torch`. numpy is the array type in m5.
  Torch ↔ numpy happens only in com5fy boundary helpers.
- Times are **milliseconds (float)** inside m5. Musical time (quarter lengths, measures) only through `TimeMap`.
- Match the existing code style: dataclasses, type hints, docstrings that explain *why*, small private helpers.
- Node IDs are `m5_<Name>`; categories under `m5/…` (e.g. `m5/convert`, `m5/edit`, `m5/create`, `m5/data`, `m5/io`, `m5/model`).
- New ComfyUI types are declared with `@io.comfytype(io_type="M5_…")` in com5fy.
- **Tests**: `mmmmm/tests/` (pytest, tiny fixtures in `mmmmm/tests/data/`, no network, no GPU).
  Tests needing Orchidea / a model / an LLM are marked `@pytest.mark.slow` or `@pytest.mark.external` and skipped by default.
  com5fy gets `custom_nodes/com5fy/tests/` that import the node classes and call `execute` directly.
- **End-to-end checks**: example workflows saved as JSON in `custom_nodes/com5fy/workflows/`,
  runnable headlessly through ComfyUI's `/prompt` API by a small script. Every new feature adds one (see §0 handoff).
- **Frontend**: TypeScript + React in `com5fy/ui/`, built with `npm run build` into `com5fy/js/` (see §2.9).
- Optional heavy dependencies (AFTER, RAVE, LLM libraries) are optional extras in `mmmmm/pyproject.toml`
  and imported lazily, so the base install stays light.

---

## 4. Target workflows (acceptance tests for the whole system)

These come from the spec's use cases and workflow diagrams. Milestones say which workflows they unlock.

- **W1 – Phase 1:** Load audio → Audio → Score (Orchidea) → Score viewer → Score → Audio → playback.
- **W2 – Phase 2 prototype:** Audio → Score → Score + text ("gradually thin out the texture") → Score → Score → Audio → playback.
- **W3 – Descriptors:** Load audio → Audio → Descriptor (pitch, brightness, spectral flux) → Descriptor viewers →
  Descriptor + text → Score ("quantize to eighth notes, random octave per pitch"), and Descriptor + text → Control data
  ("binary on/off graph at the point of largest change").
- **W4 – Custom process:** Text ("create a node for evolutionary processes that combine two scores") → Code → custom node
  "Evolutionary Process" (Score A, Score B, params → Score), output can feed back in.
- **W5 – Cross-software (diagram 2):** Import MIDI from Ableton → MIDI → Audio (AFTER model) → Audio + text → Audio
  ("increase brightness over time") → Audio → Score → Interleave (custom node, with a score imported from MuseScore) →
  Score + text → Score ("duration of note i = ith Fibonacci number mod 8") → export to MuseScore; Score → Audio → export to Ableton;
  Audio → Descriptor → export as keyframes controlling blur in Premiere.
- **W6 – Natural language workflow:** user describes W2 in plain text and the LLM builds the node graph.
- **W7 – Score text-editing benchmark:** the spec's score use cases (flute interleaved lines, major chords on each note,
  Fibonacci durations, harmonics +1 beat, Daniele's Farey-sequence anacruses) run through the Score + text node.
  Kept as a test set in `mmmmm/tests/llm_cases/` with checks on the result (range, pitch content, durations).

---

## 5. Milestones and tasks

Milestones are in build order. M0–M6 = spec Phase 1–2 (prototype, April 2027). M7–M12 = spec Phase 3 (v1.0, October 2027).
M13 = release work done along the way.

### M0 — Foundations

- [x] **M0.1 Project guide for Claude.** Add a `CLAUDE.md` at the ComfyUI root (and short ones in `mmmmm/` and `com5fy/`)
  pointing to the spec and this plan, with setup/test commands and the conventions in §3.
  *Done when:* a fresh session can find the plan, set up the env and run the tests from CLAUDE.md alone.
- [x] **M0.2 Test setup for m5.** `mmmmm/tests/` with pytest config, markers (`slow`, `external`), tiny fixtures
  (a 1 s sine WAV, a 4-bar MusicXML, a saved Orchidea `connection.txt`). Tests for `Audio`, `Event`, `Sequence`,
  `Score.from_sequence` (quantization), `render_sequence`, and the `connection.txt` parser.
  *Done when:* `uv run pytest` in `mmmmm/` passes with no Orchidea/GPU.
- [x] **M0.3 Test setup for com5fy.** `custom_nodes/com5fy/tests/` that call each node's `execute` with fixtures,
  including the AUDIO ⇄ m5.Audio boundary helpers. *Depends on:* M0.2.
- [x] **M0.4 Headless workflow runner.** `custom_nodes/com5fy/workflows/` + a script that starts/uses a ComfyUI server,
  posts a workflow (API format) to `/prompt`, and checks it finishes without errors. Save W1 as the first workflow.
  *Depends on:* M0.3.
- [x] **M0.5 Split `nodes.py`.** Move to a package (`com5fy/nodes/{types,boundary,convert,data,io}.py`) before it grows,
  keeping `__init__.py` exports and node IDs unchanged. *Depends on:* M0.3.
- [x] **M0.6 TypeScript/React frontend.** Set up `com5fy/ui/` from the React extension template (Vite, TS, npm deps for
  OSMD/VexFlow), build into `js/`, and port the score viewer, sequence viewer and audio playback with no change in
  behavior. Fix the `.gitignore` `lib/` rule so needed files are tracked.
  *Done when:* a fresh clone + `npm ci && npm run build` (or just the committed build) gives working viewers.

### M1 — Finish Phase 1: audio → score with Orchidea (W1)

- [x] **M1.1 Orchidea node.** Exists. Remaining: expose the most useful config keys as typed inputs with sane ranges,
  clear error when the sound database is missing, document TinySOL setup in the node tooltip.
- [x] **M1.2 Sound database location.** Register `models/m5/orchidea_db` with `folder_paths`; the node picks a database
  from a dropdown instead of a path baked into `orch_config.txt`.
- [x] **M1.3 Orchidea portability.** Not needed: the target is M-series macOS only (user decision 2026-11-02).
  Just check the bundled binary runs natively on Apple Silicon (not under Rosetta) and fail clearly on other platforms.
  Checked in M1: universal binary with an arm64 slice (tested); forced to arm64 with `arch -arm64` when Python itself
  runs under Rosetta; clear error off macOS unless `ORCHIDEA_EXECUTABLE` is set.
- [x] **M1.4 W1 end to end.** W1 workflow saved and passing in the runner (marked `external` since it needs Orchidea).
  *Depends on:* M0.4, M1.1, M1.2.

### M2 — Complete the data model

- [x] **M2.1 `Score ⇄ Sequence`.** Add `Score.to_sequence(time_map)` (the inverse of `from_sequence`), keeping
  instrument, pitch (incl. microtones), dynamics, playing styles. Round-trip tests.
  Done as `Score.to_sequence(bpm=None)` (score's metronome marks, or one tempo); M2.2 swaps the private
  `_tempo_map` for a `TimeMap`. Nodes `m5_ScoreToSequence` / `m5_SequenceToScore` (`m5/convert`).
- [x] **M2.2 `TimeMap`.** Tempo changes + meter changes; `ms_to_measure_beat`, `measure_beat_to_ms`, `ms_to_quarters`.
  Score uses it instead of the fixed `DEFAULT_BPM`. Extract from music21 scores and MIDI files.
  Done as `m5.TimeMap` (`timemap.py`, §2.3); `Sequence.time_map` (optional) makes Score → Sequence → Score keep tempo
  and meter changes and the pickup; `from_midi_events` / `to_midi_events` are the hook for M2.4.
- [ ] **M2.3 Proportional vs metered scores.** `Score` gets a `notation` mode (`metered` | `proportional`);
  proportional scores keep raw ms timings (spec: Score nodes support both). *Depends on:* M2.2.
- [ ] **M2.4 `Midi` type.** Read/write `.mid`, `from_sequence` / `to_sequence`, tempo map, CC lanes → BPFs.
  *Depends on:* M2.2.
- [ ] **M2.5 `BPF` type.** Points, interpolation (step/linear/exp), resample to a grid, rescale range, read/write JSON/CSV.
- [ ] **M2.6 `Descriptor` type.** Named time series + units + range; frame matrices (e.g. partials: time × (freq, amp));
  `to_bpf(name)`, `to_sequence()` (onsets/partials as events); read/write JSON/CSV and SDIF if a library is available.
- [ ] **M2.7 `Origin`.** Dataclass from §2.5, optional field on Audio/Score/Midi/Descriptor/BPF/Sequence;
  copied through transformations by a helper.
- [ ] **M2.8 Serialization.** Each type gets `to_dict` / `from_dict` (JSON-safe, audio by file reference) — needed for
  data-node history, Code-node subprocesses, the LLM and OSC. *Depends on:* M2.4–M2.7.

### M3 — Data nodes and viewers

Spec: data nodes display only (no editing); each keeps a history of versions you can step through.

- [ ] **M3.1 Data-node history (backend).** A store keyed by node id that keeps the last N outputs (serialized via M2.8)
  under `output/m5_history/`, plus a small HTTP route (`PromptServer.instance.routes`) to list/fetch versions.
  *Depends on:* M2.8.
- [ ] **M3.2 History UI.** Shared JS helper adding ◀ ▶ version controls + "pin this version as output" to every data node.
  *Depends on:* M3.1.
- [ ] **M3.3 Score node.** Merge viewer behavior: metered via OSMD (exists), proportional via the sequence viewer;
  playback button using `render_sequence` or a simple synth. *Depends on:* M2.3, M3.2.
- [ ] **M3.4 MIDI node.** Piano-roll viewer (canvas) + playback via a basic synth. *Depends on:* M2.4.
- [ ] **M3.5 Descriptor node.** Table view + line plot per descriptor (spec says table; plot is cheap to add).
  *Depends on:* M2.6.
- [ ] **M3.6 Control-data nodes.** Text (builtin is fine), Number (builtin), BPF node with a curve display. *Depends on:* M2.5.
- [ ] **M3.7 Audio node.** Fold `m5_AudioPlayback` into the shared history mechanism. *Depends on:* M3.2.

### M4 — Symbolic conversions and analysis (W3 groundwork)

- [ ] **M4.1 Convert nodes via the hub.** Score ⇄ MIDI, Score/MIDI → Sequence and back, using §2.3. One generic
  `m5_Convert` node per output type is fine (Score ⇄ Sequence already has its own two nodes from M2.1; keep their ids
  if a generic node replaces them in the menu). *Depends on:* M2.1, M2.4.
- [ ] **M4.2 Engine registry.** `m5.engines` with the protocol + registry from §2.4; Orchidea moved behind it as the first
  `AudioToScore` engine; node engine dropdowns read from the registry.
- [ ] **M4.3 Audio → Descriptor.** Engine using librosa (pitch/f0, loudness, spectral centroid ≈ brightness, flux, onsets)
  and optionally partial tracking. Node with a multi-select of descriptors and one output per descriptor or one bundle.
  Leave room for a Partiels engine later. *Depends on:* M2.6, M4.2.
- [ ] **M4.4 Audio → MIDI.** Engine using an open transcription model (e.g. basic-pitch) as an optional extra. *Depends on:* M2.4, M4.2.
- [ ] **M4.5 Descriptor → Audio (simple).** Additive resynthesis from partials / f0 + loudness (spec: "simple case").
  *Depends on:* M2.6.
- [ ] **M4.6 Descriptor / MIDI / Score → Control data.** Pick a descriptor or CC lane as a BPF; rescale/threshold
  helpers. *Depends on:* M2.5, M2.6.
- [ ] **M4.7 Score → Audio (non-AI).** Render a score with the Orchidea sample database / soundfont so W1 works without
  AFTER. *Depends on:* M2.1.

### M5 — Local LLM and text editing (the "+ text" nodes)

- [ ] **M5.1 LLM client.** `m5.llm.LLMClient` per §2.6: chat, JSON-schema output with retry on invalid JSON, timeouts,
  model listing. Config via env vars / a ComfyUI setting. Test against a fake server.
- [ ] **M5.2 LLM model node.** `m5_LocalLLM` (`M5_MODEL` output) choosing server + model; checks the server is up.
  *Depends on:* M5.1.
- [ ] **M5.3 Score + text → Score.** First version: the LLM writes a Python function `transform(seq: Sequence) -> Sequence`
  against a short, documented m5 API cheat-sheet; it runs through the runner from §2.7; the code is returned as a second
  output for display. (No bach MCP engine — user decision 2026-11-02.)
  *Depends on:* M2.1, M5.1, M8.1.
- [ ] **M5.4 Score-editing test set (W7).** The spec's score use cases as cases with automatic checks; a script that
  runs them against a chosen local model and reports pass rate. Useful for the MCP team's LLM comparison too. *Depends on:* M5.3.
- [ ] **M5.5 MIDI / Descriptor / Control data + text.** Same pattern as M5.3 for the other symbolic types. *Depends on:* M5.3.
- [ ] **M5.6 Text → parameters.** LLM fills an engine's parameters from a prompt (spec research item: Orchidea params
  from natural language). Generic: engine exposes a JSON schema of its params. *Depends on:* M4.2, M5.1.
- [ ] **M5.7 Text → Score / MIDI / Control data (creation nodes).** Same code-generation pattern with an empty input.
  *Depends on:* M5.3.

### M6 — Score → audio and audio editing (completes W2, Phase 2 prototype)

- [ ] **M6.1 ⚑ external AFTER engine (score/MIDI → audio).** Wrapper around AFTER inference (out of process if its
  deps clash), model files from `models/m5/after`. Needs: AFTER code/checkpoints from its authors. Mock engine first.
  *Depends on:* M4.2, M2.4.
- [ ] **M6.2 Model node.** `m5_LoadModel` listing files in `models/m5/*`, outputs `M5_MODEL`; transformation nodes take an
  optional model input. *Depends on:* M4.2.
- [ ] **M6.3 ⚑ external Audio + text → Audio.** Node + engine interface; mock engine (e.g. EQ tilt for "brighter");
  real engine from the Analyse-Synthèse team (Guillaume, Alfredo) when ready. *Depends on:* M4.2.
- [ ] **M6.4 W2 end to end.** Saved workflow passing with real or mock engines; recorded as the v0.1 prototype.
  *Depends on:* M1.4, M5.3, M4.7 or M6.1.
- [ ] **M6.5 Composer testing round.** Package v0.1 for the testing team (Aaron, Curtis): install guide, example
  workflows, known issues. Collect feedback into §8 / new tasks.

### M7 — Import / export and external software (W5 groundwork)

Priority (user decision): **MuseScore, Ableton, Premiere**. Max/bach (M7.4) and DaVinci Resolve are deferred.

- [ ] **M7.1 File import/export nodes.** Load/save for every type: audio (builtin), MusicXML/MIDI/ABC, `.mid`,
  descriptor JSON/CSV/SDIF, BPF JSON/CSV. Origin set to `software="file"`. *Depends on:* M2.8.
- [ ] **M7.2 OSC send/receive.** `python-osc`; send any serialized type, receive with a timeout (offline system, so a
  node waits for a message). *Depends on:* M2.8.
- [ ] **M7.3 MuseScore.** Import/export MusicXML with Origin (score path + measure range); optional MuseScore CLI for
  PDF/audio. Investigate a MuseScore plugin for "send selection to ComfyUI". *Depends on:* M7.1.
- [ ] **M7.4 (deferred) Max / bach.** OSC or bach's llll text format for bach.roll / bach.score ⇄ Sequence; small Max abstraction
  shipped in `com5fy/max/`. Coordinate with the MCP team. *Depends on:* M7.2.
- [ ] **M7.5 Ableton.** Clip import/export with position (via AbletonOSC or a Max for Live device); MIDI and audio clips;
  write back at the same time position. *Depends on:* M7.2, M2.7.
- [ ] **M7.6 Premiere.** Export BPF/descriptor as keyframes on an effect parameter over a time range (via a UXP/CEP panel
  or ExtendScript, or an importable keyframe file as a first step). DaVinci Resolve deferred. *Depends on:* M2.5, M2.7.

### M8 — Code nodes and custom nodes (W4)

- [ ] **M8.1 Sandbox runner.** `m5.sandbox.run(code, inputs, timeout)` per §2.7. Needed by M5.3. *Depends on:* M2.8.
- [ ] **M8.2 Code node.** Code editor widget; typed inputs/outputs chosen by the user; runs through the sandbox.
  *Depends on:* M8.1.
- [ ] **M8.3 Custom node from code.** Save a Code node as a reusable node (name, typed ports, code) under
  `user/default/m5_nodes/`; loaded as real nodes at startup. *Depends on:* M8.2.
- [ ] **M8.4 Custom node from a subgraph.** Use ComfyUI's built-in subgraph feature where possible; document it
  instead of rebuilding it.
- [ ] **M8.5 LLM-generated custom node.** Text → Code node (writes + saves a custom node). W4 passing. *Depends on:* M5.1, M8.3.
- [ ] **M8.6 (deferred) Feedback / iteration.** Not now (user decision). Candidate if it proves elegant: a
  "Previous Output" node that reads a data node's last version from the history store (M3.1), so each run feeds on the
  previous one without making the graph cyclic. Propose to the user before building.

### M9 — Model nodes and audio → audio

- [ ] **M9.1 ⚑ external RAVE engine (audio → audio, timbre transfer).** TorchScript `.ts` models from `models/m5/rave`.
  *Depends on:* M6.2.
- [ ] **M9.2 ⚑ external AFTER audio → audio.** *Depends on:* M6.1.
- [ ] **M9.3 LoRA loading.** Model node accepts a LoRA and passes it to engines that support it. *Depends on:* M6.2.
- [ ] **M9.4 Model from GitHub URL (research spike).** Spec idea: paste a repo URL, get a node. Time-boxed spike:
  write up what's feasible (likely: a manifest format that model repos can provide).
- [ ] **M9.5 Training / fine-tuning nodes.** LoRA training on the user's data (spec Phase 3). Scope with the user first.

### M10 — Workflows from natural language (W6)

- [ ] **M10.1 Node catalog for the LLM.** Generate a compact description of every m5 node (id, ports, types, one line)
  from the schemas, small enough for a local model's context. *Depends on:* most of M4.
- [ ] **M10.2 Text → workflow.** LLM produces a ComfyUI workflow JSON (validated: node ids exist, port types match),
  loaded into the canvas. Start with a sidebar panel (React extension template). *Depends on:* M10.1, M5.1.
- [ ] **M10.3 Edit an existing workflow from text.** "add a descriptor branch after the audio node". *Depends on:* M10.2.

### M11 — Timeline and shared timeline

- [ ] **M11.1 Timeline data model.** Tracks of clips (any representation + Origin + position), in `m5.timeline`.
  *Depends on:* M2.7.
- [ ] **M11.2 Timeline node / panel UI.** Shows clips from imported projects; clips can be graph inputs; graph outputs can
  be dropped back on it. *Depends on:* M11.1.
- [ ] **M11.3 Shared timeline across projects.** Map times between projects using each project's TimeMap and Origin
  (the spec's Ableton ↔ Premiere and MuseScore ↔ Ableton examples). *Depends on:* M11.1, M7.3, M7.5, M7.6.
- [ ] **M11.4 Timeline driven by code / LLM.** Python API + LLM tool to place clips. *Depends on:* M11.2, M5.1.

### M12 — Musical knowledge for the LLM

- [ ] **M12.1 RAG store.** Local embeddings + vector store over text docs (musical knowledge, bach/Max docs);
  user can add their own folder. Used by the "+ text" engines. *Depends on:* M5.1.
- [ ] **M12.2 Hook in research results.** Plug in LoRAs / fine-tuned LLMs from the LLM research team when available. ⚑ external.

### M13 — Packaging and release (ongoing)

- [ ] **M13.1 Install story.** One documented install path on M-series macOS; optional extras per engine.
- [ ] **M13.2 Registry publish.** Publish com5fy to the ComfyUI registry / Manager (GPL-3.0, matching ComfyUI).
- [ ] **M13.3 User docs.** One page per node + example workflows with screenshots.
- [ ] **M13.4 CI.** GitHub Actions running m5 + com5fy fast tests on each push.

---

## 6. Dependencies on other teams

| Need | From | Used by | Until then |
|---|---|---|---|
| Local-LLM results (model choice, LoRAs) | LLM/MCP team | M5, M12.2 | llama.cpp with a general model |
| Audio editing with text model | Analyse-Synthèse (Guillaume, Alfredo) | M6.3 | mock EQ engine |
| AFTER code + checkpoints | AFTER authors / ACIDS | M6.1, M9.2 | non-AI score render (M4.7) |
| RAVE models | ACIDS | M9.1 | mock engine |
| Composer sketches and workflows | Testing team (Aaron, Curtis) | M6.5, W-tests | spec use cases |

## 7. Out of scope (from the spec)

- Real-time generation or performance use. Everything is offline / studio.
- Editing musical representations inside the display nodes (display only; editing happens with transformation nodes or external software).
- Collaborative performer scores (spec open question; not planned unless the user adds it).

## 8. Open questions and gaps

The first round of questions was answered on 2026-11-02 (recorded at the top of §2).
What's below is still missing. A session that reaches one of these should ask the user, not guess.

**Inputs only the user or other teams can provide**

1. ~~Orchidea sound database location~~ — done in M1.2: `models/m5/orchidea_db` dropdown. On the dev machine
   `models/m5/orchidea_db/TinySOL` is a symlink to `/Users/luke/Orchidea/TinySOL`; the old local edit of
   `m5/orch_config.txt` is no longer needed.
2. AFTER code and checkpoints, RAVE models, and the Analyse-Synthèse audio-editing model (M6.1, M6.3, M9).
3. Which GGUF model(s) to use by default with llama.cpp, and how much RAM the target Macs have.
4. Test audio and scores that are musically meaningful for the composers (not just sine waves).

**Musical behavior not yet specified** (decide when the task comes up; mock first if needed)

5. Score → audio without AFTER (M4.7): sample database, soundfont, or simple synth?
6. Which descriptors matter, their units and ranges, and whether partials data is needed (M2.6, M4.3).
7. How proportional notation should look in the Score node (M2.3, M3.3).
8. What counts as "good enough" for Score + text editing — e.g. a pass rate on the W7 test set (M5.4).

**Integration details to work out with the user's setup**

9. Ableton: Live version, and whether a Max for Live device or AbletonOSC is acceptable to install (M7.5).
10. Premiere: version, and whether a UXP panel can be installed (M7.6).
11. MuseScore: version (3 or 4) installed (M7.3).

**Design work to do with the user before building**

12. Timeline UI (M11.2) and the text → workflow sidebar (M10.2): rough layout and interaction.
13. Training / fine-tuning nodes (M9.5) and model-from-GitHub-URL (M9.4): scope.

## 9. Session log

One line per session: `YYYY-MM-DD · task IDs · what changed · open items`.

- 2026-11-02 · — · Created this plan from the technical spec and the existing m5/com5fy code. · Waiting on answers to §8.
- 2026-11-02 · — · Moved plan to `com5fy/docs/`; recorded the user's answers (§2); added the end-of-session test-workflow
  handoff (§0); added M0.6 (TS/React); macOS-only; MuseScore/Ableton/Premiere priority; listed remaining gaps (§8). · Next: M0.1.
- 2026-11-02 · — · Test-workflow handoff now required per new feature, not per session. · Next: M0.1.
- 2026-11-02 · M0.1 · Added `CLAUDE.md` in the ComfyUI root (local only, not a repo), `mmmmm/` and `com5fy/`; fixed the
  boundary helper name in §1 (`_to_comfy_audio`). Checked setup/run commands (`--quick-test-for-ci` loads com5fy). ·
  pytest isn't in the env yet (`uv run --with pytest` until M0.2 adds it); existing nodes use categories `audio`/`music`,
  not `m5/…` (§3). Next: M0.2.
- 2026-11-02 · M0.2 · `mmmmm/tests/`: pytest as a `dev` dependency group, config + `slow`/`external` markers in
  `pyproject.toml` (skipped by default), fixtures in `tests/data/` (1 s sine WAV, 4-bar MusicXML, hand-written
  `connection.txt` + tiny samples under `sounds/`, `make_fixtures.py`). 52 tests for Audio, Event, Sequence, Score
  (quantize, from_file, from_sequence), render_sequence, the connection parser/Sequence builder and config overrides;
  one slow test runs the real binary (passes locally with TinySOL). No code changes needed. · Next: M0.3.
- 2026-11-02 · M0.3 · `custom_nodes/com5fy/tests/`: conftest puts the ComfyUI root on `sys.path` (package imports as
  `custom_nodes.com5fy`), declares `slow`/`external` and skips them unless `-m` is given; fixtures (stereo sine AUDIO,
  nested Sequence, copy of the 4-bar MusicXML). 27 tests: extension node ids, AUDIO ⇄ m5.Audio helpers, Sequence Viewer
  payload, every node's `execute` (Orchidea with `m5.orchestrate` mocked). No code changes needed. · Next: M0.5, M0.4.
- 2026-11-02 · M0.5 · `nodes.py` → `nodes/` package: `types` (M5_SCORE, M5_SEQUENCE), `boundary` (AUDIO ⇄ m5.Audio),
  `convert` (Orchidea, Sequence to Audio), `data` (Score/Sequence Viewer, Audio Playback + payload helpers), `io`
  (Load Score); `nodes/__init__.py` holds the extension. Code moved unchanged; node ids and top-level exports unchanged.
  ComfyUI's `io` is imported after the submodules in `nodes/__init__.py` (importing `.io` rebinds the name). · Next: M0.4.
- 2026-11-02 · M0.4 · `workflows/run.py` (stdlib only): starts ComfyUI on a free port (or uses `--server`), copies
  `workflows/inputs/` into `input/`, posts each `workflows/api/*.json` to `/prompt`, polls `/history`, reports validation
  and execution errors. Workflows carry `"m5": {"markers": [...]}`; slow/external skipped unless `--all`.
  `api/smoke_viewers.json` (no deps) and `api/W1_audio_to_score.json` (slow+external; passes locally with TinySOL, ~1 s on
  the sine fixture). `tests/test_workflows.py` (slow) runs them through pytest plus two failure-reporting tests; conftest
  now treats `-m ""` as "run everything". Runner workflows are API format; UI-format W1 comes with M1.4. · Next: M0.6.
- 2026-11-02 · M0.6 · (done by a subagent, reviewed here) `ui/` (Vite + TS + React, template's i18n/jest/eslint/sidebar
  dropped) ports Score Viewer, Sequence Viewer and Audio Playback line for line; builds to `js/com5fy.js` + lazy
  `js/chunks/*.mjs`; old hand-written JS and untracked `js/lib/` removed; `.gitignore` `lib/` anchored to `/lib/`.
  `npm ci && npm run build` reproduces `js/` byte for byte; checked in the browser (score render + wheel scroll, audio
  play/seek/spectrogram/serialize, sequence viewer with a hand-made payload; no console errors of ours). Viewers now unmount
  their React roots on removal. · Open: in Vue-nodes mode the score node's `size[1]` sometimes stays 240 after fitting
  (likely pre-existing); `npm audit` flags OSMD's optional `gl` dep (build-time only). Next: M1.
- 2026-11-02 · M1.1–M1.4 · m5: `SoundDatabase` (`.db` file + inferred samples folder), `orchestrate(..., database=)`,
  missing-database check before running the binary (it otherwise exits 0 with no output), clear error off macOS,
  `arch -arm64` under Rosetta; bundled binary confirmed universal with an arm64 slice. com5fy: `nodes/paths.py` registers
  `models/m5/orchidea_db`; Orchidea's `db_files`/`sound_paths` strings replaced by a `database` dropdown (placeholder +
  setup instructions when empty); new inputs styles, dynamics, reverb, and advanced onsets_timegate, segmentation,
  pop_size, max_epochs; TinySOL setup in description/tooltip and README. Runner: `expect_outputs` (W1 must fill all four
  viewers/players). `workflows/M1.4_w1_audio_to_score.json` checked in the browser; all tests pass with the committed
  (unedited) `orch_config.txt`. · Open: no musically meaningful shipped test audio yet (§8.4); ranges/defaults want
  composer feedback. Next: M2.
- 2026-11-03 · M2.1 · m5: `Score.to_sequence(bpm=None)` (parts → sub-Sequences, tempo marks incl. changes and
  referents, ties merged, dynamics/text styles as state, articulations, velocity, editorial → custom fields,
  microtones → per-pitch `detuning_cents`); `from_sequence` now parses m5 pitch names (`b` flats, `x`, `C-1`), applies
  per-pitch detuning, and turns articulation names into articulations (decisions in §2.3). com5fy: `m5_ScoreToSequence`,
  `m5_SequenceToScore` (category `m5/convert`), fixture `tests/data/duo_tempo_dynamics.musicxml`, workflow
  `M2.1_score_sequence` (UI + API, checked in the browser). · Open: `from_sequence` doesn't write rests in gaps, and
  overlapping notes in a part make music21 put the whole part into two voices (extra measure rests); a Sequence carries
  no tempo, so re-quantizing a score with tempo changes at one bpm is approximate (M2.2); OSMD titles untitled scores
  "Untitled Score". Next: M2.2.
- 2026-11-05 · M2.1 feedback · m5: `DEFAULT_BPM` 60 → 120; `estimate_bpm` (new `tempo.py`), used by
  `from_sequence(bpm=None)`; dynamics/text styles only on the event where the marking appears; microtones named as the
  nearest pitch ± ≤50 cents; ±50 written as quarter-tone accidentals; tempo mark now exported (it was lost); fixture
  `duo_tempo_dynamics.musicxml` copied to m5's tests; `m5.ARTICULATIONS`. com5fy: Score to Sequence loses `bpm`;
  Sequence to Score `bpm` 0 = estimate (default); Sequence Viewer `pixels_per_second` → `zoom` (redraws live), shows
  dynamics, text styles, articulation symbols, quarter-tone accidentals and cents labels; Score Viewer retries with
  pinned rest positions to dodge an OSMD 1.9.0 crash (2nd-voice rest next to a quarter tone); Orchidea node pins 60 BPM.
  Workflows M2.1 and M1.4 updated; checked in the browser. · Open: the half/double-tempo choice is a heuristic; a
  Sequence still carries no tempo map (M2.2). Next: M2.2.
- 2026-11-10 · M2.2 · m5: `TimeMap` (new `timemap.py`; `TempoChange` with referent, `MeterChange` keyed by quarter
  position, pickup, first measure; ms ⇄ quarters ⇄ (measure, beat); `from_score` / `Score.time_map`,
  `from_midi_events` / `to_midi_events`, `from_midi_file` via music21); `Sequence.time_map` (optional);
  `to_sequence` sets it, `from_sequence(time_map=)` writes tempo marks, time signatures and a pickup bar back (private
  `_tempo_map` removed); forced `bpm` keeps only the first meter. Fixture `meters_tempi.musicxml` (both repos).
  com5fy: Sequence to Score `bpm` 0 = the Sequence's map, else estimate (tooltips); workflow `M2.2_timemap` (UI + API,
  checked in the browser); M2.1 Note updated. · Open: no accel./rit. ramps; measure numbers computed, not read;
  Sequence Viewer draws no barlines yet. Next: M2.3 / M2.4.
