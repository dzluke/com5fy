"""Nodes that convert between representations (audio, score, sequence)."""

from comfy_api.latest import io

import m5

from . import paths
from .boundary import _to_comfy_audio, _to_m5_audio
from .types import m5BPF, m5Descriptor, m5Midi, m5Score, m5Sequence


# Shown in the database dropdown when no database is installed, so the workflow
# still validates and the node can explain what to do when it runs.
NO_DATABASE = "(no database found: see tooltip)"

DATABASE_SETUP = (
    "Orchidea needs a sound database. To install TinySOL (the small one Orchidea "
    "ships for testing): download it from https://www.orch-idea.org/datasets/, unzip "
    "it, and move (or symlink) the TinySOL folder, the one holding TinySOL.spectrum.db "
    f"and the TinySOL/ samples folder, into {paths.ORCHIDEA_DB_DIR}/. Then restart "
    "ComfyUI or press R to refresh the node definitions. Any database laid out as "
    "<Name>.<features>.db next to a <Name>/ samples folder works."
)


# Orchidea's segments come from onset detection, not a beat, so its score keeps
# the fixed tempo it always had (one quarter = one second) rather than an
# estimated one.
ORCHIDEA_BPM = 60.0


class OrchideaNode(io.ComfyNode):
    """
    Orchestrate an input audio signal into an M5 score using m5.orchestrate.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        databases = paths.orchidea_databases() or [NO_DATABASE]
        return io.Schema(
            node_id="m5_Orchidea",
            display_name="Orchidea",
            category="audio",
            description=(
                "Assisted orchestration with Orchidea: finds a combination of "
                "instrument samples from a sound database that sounds like the "
                "input audio, segment by segment. " + DATABASE_SETUP
            ),
            inputs=[
                io.Audio.Input("audio", tooltip="The target sound to orchestrate."),
                io.Combo.Input(
                    "database",
                    options=databases,
                    default=databases[0],
                    tooltip=(
                        "Sound database the orchestration is built from: the .db "
                        "analysis files found in models/m5/orchidea_db. "
                        + DATABASE_SETUP
                    ),
                ),
                io.String.Input(
                    "orchestra",
                    default=(
                        "Fl Fl Ob Ob ClBb ClBb Bn Bn Hn Hn TpC TpC "
                        "Tbn Tbn BTb Vn Vn Va Va Vc Vc Cb Cb"
                    ),
                    multiline=True,
                    tooltip=(
                        "Space-separated instrument abbreviations that make up the "
                        "orchestra (names depend on the sound database). Use '|' "
                        "between instruments to mark a doubling played by one player, "
                        "e.g. 'Fl|Picc'. Default is the full TinySOL orchestra."
                    ),
                ),
                io.Float.Input(
                    "onsets_threshold",
                    default=0.6,
                    min=0.0,
                    max=2.0,
                    step=0.01,
                    tooltip=(
                        "Sensitivity of onset detection for dynamic (temporal) "
                        "orchestration. 0 segments at any minimal spectral variation; "
                        "raise it to reduce sensitivity. Above 1 there are no onsets "
                        "and the target is treated as static (one chord)."
                    ),
                ),
                io.Float.Input(
                    "sparsity",
                    default=0.001,
                    min=0.0,
                    max=1.0,
                    step=0.001,
                    tooltip=(
                        "How freely the algorithm may drop instruments from a "
                        "solution. 0 forces every instrument to be used; higher "
                        "values raise the chance of dropping instruments. Suggested: "
                        "0.01 for general targets, 0.001 for symphonic targets, 0.1 "
                        "for single notes."
                    ),
                ),
                io.Boolean.Input(
                    "partials_filtering",
                    default=False,
                    label_on="on",
                    label_off="off",
                    tooltip=(
                        "Whether to filter the sound database by the target's "
                        "partials. Off uses all sounds (best for inharmonic/noisy "
                        "targets where timbre matters more than pitch). On keeps only "
                        "sounds matching the target's partials (best when pitch "
                        "matters); strictness is set by partials_filtering_threshold_db."
                    ),
                ),
                io.Float.Input(
                    "partials_filtering_threshold_db",
                    default=-12.0,
                    min=-60.0,
                    max=0.0,
                    step=1.0,
                    tooltip=(
                        "Only used when partials_filtering is on. Threshold in dB "
                        "between the loudest and softest partial kept in the search: "
                        "lower (more negative) retains more partials, higher keeps "
                        "only the strongest. Useful range is roughly -24 to -12."
                    ),
                ),
                io.String.Input(
                    "styles",
                    default="",
                    tooltip=(
                        "Only use samples with these playing styles (space-separated "
                        "tags from the database, e.g. 'ord' or 'ord pizz_lv flatt'; "
                        "grep-like patterns work). Blank = no filter."
                    ),
                ),
                io.String.Input(
                    "dynamics",
                    default="",
                    tooltip=(
                        "Only use samples with these dynamics (space-separated, e.g. "
                        "'pp p mf'; N = untagged). Blank = no filter."
                    ),
                ),
                io.Boolean.Input(
                    "reverb",
                    default=True,
                    label_on="on",
                    label_off="off",
                    tooltip=(
                        "Add Orchidea's reverb to the rendered orchestration audio "
                        "(not to the score or the Sequence). Off = dry samples."
                    ),
                ),
                io.Float.Input(
                    "onsets_timegate",
                    default=0.1,
                    min=0.01,
                    max=10.0,
                    step=0.01,
                    advanced=True,
                    tooltip=(
                        "Minimum time in seconds between two detected onsets: raise "
                        "it for fewer, longer segments."
                    ),
                ),
                io.Combo.Input(
                    "segmentation",
                    options=["flux", "powerflux", "frames"],
                    default="flux",
                    advanced=True,
                    tooltip=(
                        "How the target is cut into segments: by spectral flux, by "
                        "power-weighted flux, or into fixed frames."
                    ),
                ),
                io.Int.Input(
                    "pop_size",
                    default=300,
                    min=10,
                    max=2000,
                    step=10,
                    advanced=True,
                    tooltip=(
                        "Population size of the genetic search. Bigger searches wider "
                        "but runs longer; ~100 suits long dynamic targets, ~500 static ones."
                    ),
                ),
                io.Int.Input(
                    "max_epochs",
                    default=300,
                    min=10,
                    max=2000,
                    step=10,
                    advanced=True,
                    tooltip=(
                        "Generations of the genetic search. More can find closer "
                        "matches, at the cost of time."
                    ),
                ),
            ],
            outputs=[
                m5Score.Output("score"),
                io.Audio.Output(
                    "audio",
                    display_name="audio",
                    tooltip=(
                        "Audio realization of the orchestration (Orchidea's "
                        "connection.wav): the chosen instrument samples rendered "
                        "and mixed down. Empty for targets that produce no "
                        "realization."
                    ),
                ),
                m5Sequence.Output(
                    "sequence",
                    tooltip=(
                        "The raw, unquantized orchestration as an m5.Sequence "
                        "(before it is quantized into the Score). Feed it to a "
                        "Sequence Viewer to see the exact onset times as "
                        "proportional, time-based notation."
                    ),
                ),
            ],
        )

    @classmethod
    def execute(
        cls,
        audio: io.Audio.Type,
        database: str,
        orchestra: str,
        sparsity: float,
        partials_filtering: bool,
        partials_filtering_threshold_db: float,
        onsets_threshold: float,
        styles: str = "",
        dynamics: str = "",
        reverb: bool = True,
        onsets_timegate: float = 0.1,
        segmentation: str = "flux",
        pop_size: int = 300,
        max_epochs: int = 300,
    ) -> io.NodeOutput:
        db_path = paths.orchidea_database_path(database)
        if db_path is None:
            found = paths.orchidea_databases()
            raise FileNotFoundError(
                (f"Orchidea sound database {database!r} not found. " if database != NO_DATABASE
                 else "No Orchidea sound database is installed. ")
                + (f"Installed: {', '.join(found)}. " if found else "")
                + DATABASE_SETUP
            )
        sound_db = m5.SoundDatabase.from_db_file(db_path)
        m5_audio = _to_m5_audio(audio)

        # These override the matching keys in the Orchidea config file.
        parameters = {
            "sparsity": sparsity,
            "partials_filtering": partials_filtering,
            "partials_filtering_threshold_db": partials_filtering_threshold_db,
            "onsets_threshold": onsets_threshold,
            "onsets_timegate": onsets_timegate,
            "segmentation": segmentation,
            "pop_size": pop_size,
            "max_epochs": max_epochs,
            "bypass_reverb": not reverb,
        }
        # The string widgets override their config keys only when non-blank: a
        # blank orchestra falls back to the config's, and blank styles/dynamics
        # mean "no filter" (the config leaves those keys commented out). The
        # binary rejects an empty value as "invalid syntax". Whitespace,
        # newlines included, collapses into the single line the config expects.
        for key, value in (("orchestra", orchestra), ("styles", styles), ("dynamics", dynamics)):
            if value.strip():
                parameters[key] = " ".join(value.split())

        orchestration = m5.orchestrate(m5_audio, parameters=parameters, database=sound_db)
        # orchestrate() returns the orchestration as an m5.Sequence;
        # build the music21-backed Score the viewer/image rendering needs.
        # The raw orchestration.sequence is also exposed as an output so it can
        # be shown unquantized (proportional notation) by the Sequence Viewer.
        score = m5.Score.from_sequence(orchestration.sequence, bpm=ORCHIDEA_BPM)

        if orchestration.audio is None:
            raise RuntimeError(
                "Orchidea produced no audio realization (connection.wav). This "
                "can happen if the constraints were too strict. Try reducing the "
                "partials filtering or including more dynamics and playing styles."
            )
        return io.NodeOutput(
            score, _to_comfy_audio(orchestration.audio), orchestration.sequence
        )

class SequenceToAudio(io.ComfyNode):
    """Render an m5.Sequence to audio.

    Every event carrying audio in its ``audio`` field (e.g. the instrument
    samples an Orchidea orchestration picked) is mixed in at its onset, playing
    for at most the event's duration: longer audio is cut to fit the event.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_SequenceToAudio",
            display_name="Sequence to Audio",
            category="audio",
            inputs=[
                m5Sequence.Input("sequence"),
                io.Boolean.Input(
                    "normalize",
                    default=True,
                    label_on="on",
                    label_off="off",
                    tooltip=(
                        "Scale the mix down to full scale if summing the events "
                        "makes it clip. Off leaves the raw sum untouched."
                    ),
                ),
            ],
            outputs=[io.Audio.Output("audio")],
        )

    @classmethod
    def execute(cls, sequence, normalize: bool) -> io.NodeOutput:
        rendered = m5.render_sequence(sequence, normalize=normalize)
        return io.NodeOutput(_to_comfy_audio(rendered))


# The Sequence to Score quantization dropdown: m5's grids from coarse to fine,
# plus "none" for raw (unquantized) timings.
QUANTIZATION_OPTIONS = list(m5.QUANTIZE_GRID) + ["none"]


class ScoreToSequence(io.ComfyNode):
    """Convert an m5.Score into an m5.Sequence (``Score.to_sequence``): one
    sub-Sequence per part, one event per note or chord at its time in ms."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_ScoreToSequence",
            display_name="Score to Sequence",
            category="m5/convert",
            description=(
                "Turns a score into a Sequence: notes and chords at their times "
                "in milliseconds, one sub-Sequence per part. Keeps pitch (with "
                "microtones), instrument, dynamics, text playing styles, "
                "articulations and velocities. Timings follow the score's tempo "
                "marks, tempo changes included (120 BPM if it has none). Ties are "
                "merged into one note; rests become gaps. The Sequence also "
                "carries the score's tempo and meter map, so Sequence to Score "
                "can write the same tempos, time signatures and pickup back."
            ),
            inputs=[
                m5Score.Input("score"),
            ],
            outputs=[m5Sequence.Output("sequence")],
        )

    @classmethod
    def execute(cls, score) -> io.NodeOutput:
        # Timings come from the score's own metronome marks (120 BPM without
        # any), and the Sequence carries the score's TimeMap; m5's
        # Score.to_sequence(bpm=...) can still force one tempo.
        return io.NodeOutput(score.to_sequence())


class SequenceToScore(io.ComfyNode):
    """Quantize an m5.Sequence into an m5.Score (``Score.from_sequence``)."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_SequenceToScore",
            display_name="Sequence to Score",
            category="m5/convert",
            description=(
                "Turns a Sequence into a metered score: each sub-Sequence becomes "
                "a part, and onsets and durations are snapped to a rhythmic grid. "
                "A Sequence made from a score keeps that score's tempo changes, "
                "time signatures and pickup; otherwise the tempo is estimated "
                "from the onsets (4/4). bpm forces one tempo."
            ),
            inputs=[
                m5Sequence.Input("sequence"),
                io.Combo.Input(
                    "quantization",
                    options=QUANTIZATION_OPTIONS,
                    default="thirty-second",
                    tooltip=(
                        "Grid that onsets and durations snap to. Notes shorter "
                        "than one cell keep one cell. 'none' keeps the exact "
                        "timings (hard to read as notation)."
                    ),
                ),
                io.Float.Input(
                    "bpm",
                    default=0.0,
                    min=0.0,
                    max=1000.0,
                    step=1.0,
                    tooltip=(
                        "Tempo used to turn milliseconds into beats; written into "
                        "the score as a metronome mark. 0 uses the Sequence's own "
                        "tempo map (tempo and meter changes, from Score to "
                        "Sequence) when it has one, else estimates one tempo from "
                        "the notes: the one that puts the onsets on the simplest "
                        "beat subdivisions, near a moderate tempo. A bpm other "
                        "than 0 replaces the tempo changes with this one tempo "
                        "and keeps only the first time signature."
                    ),
                ),
            ],
            outputs=[m5Score.Output("score")],
        )

    @classmethod
    def execute(cls, sequence, quantization: str, bpm: float) -> io.NodeOutput:
        grid = None if quantization == "none" else quantization
        return io.NodeOutput(m5.Score.from_sequence(sequence, quantization=grid, bpm=bpm or None))


def _descriptor_name(text: str) -> str | None:
    """A descriptor-name widget: blank (or spaces) means "not used"."""
    return text.strip() or None


class DescriptorToSequence(io.ComfyNode):
    """Turn a Descriptor's onsets and/or partials into events (``Descriptor.to_sequence``),
    the Descriptor → Sequence step of the conversion hub (plan §2.3)."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_DescriptorToSequence",
            display_name="Descriptor to Sequence",
            category="m5/convert",
            description=(
                "Turns analysis data into notes. Onsets: one note per onset, lasting until "
                "the next, pitched at the median of the pitch track over that span (nearest "
                "pitch + cents). Partials: one note per partial, at its mean frequency. Each "
                "source becomes its own staff, named after the descriptor. Other tracks' "
                "mean values are kept on the notes as custom fields."
            ),
            inputs=[
                m5Descriptor.Input("descriptor"),
                io.String.Input(
                    "onsets",
                    default="onsets",
                    tooltip=(
                        "Name of the time series whose times are note starts (its values "
                        "aren't used). Blank = no onset notes."
                    ),
                ),
                io.String.Input(
                    "pitch",
                    default="f0",
                    tooltip=(
                        "Name of the time series that pitches the onset notes, in Hz, MIDI or "
                        "midicents (read from its unit). Blank = unpitched onset notes."
                    ),
                ),
                io.String.Input(
                    "partials",
                    default="partials",
                    tooltip=(
                        "Name of the frame matrix of partials (columns frequency, optionally "
                        "amplitude and index: rows with the same index are one partial). "
                        "Blank = no partial notes."
                    ),
                ),
                io.Float.Input(
                    "min_partial_ms",
                    default=0.0,
                    min=0.0,
                    max=60000.0,
                    step=10.0,
                    tooltip="Drop partials shorter than this (ms). 0 keeps them all.",
                ),
            ],
            outputs=[m5Sequence.Output("sequence")],
        )

    @classmethod
    def execute(cls, descriptor, onsets: str, pitch: str, partials: str,
                min_partial_ms: float = 0.0) -> io.NodeOutput:
        return io.NodeOutput(descriptor.to_sequence(
            onsets=_descriptor_name(onsets),
            pitch=_descriptor_name(pitch),
            partials=_descriptor_name(partials),
            min_partial_ms=min_partial_ms,
        ))


class DescriptorToBPF(io.ComfyNode):
    """Pick one of a Descriptor's time series as a BPF (``Descriptor.to_bpf``): a descriptor
    used as control data (spec: Descriptor → Control data)."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_DescriptorToBPF",
            display_name="Descriptor to BPF",
            category="m5/convert",
            description=(
                "One time series of a descriptor as a break-point function, keeping its "
                "name, unit and range. Missing values (e.g. unvoiced f0) are skipped, so the "
                "curve holds across them."
            ),
            inputs=[
                m5Descriptor.Input("descriptor"),
                io.String.Input("name", default="f0", tooltip="Name of the time series to take."),
                io.Combo.Input(
                    "interpolation",
                    options=list(m5.INTERPOLATIONS),
                    default="linear",
                    tooltip=(
                        "How the BPF moves between points: step (hold), linear, or exp "
                        "(geometric, for frequencies and amplitudes)."
                    ),
                ),
            ],
            outputs=[m5BPF.Output("bpf")],
        )

    @classmethod
    def execute(cls, descriptor, name: str, interpolation: str = "linear") -> io.NodeOutput:
        return io.NodeOutput(descriptor.to_bpf(name.strip(), interpolation=interpolation))


class MidiToSequence(io.ComfyNode):
    """An m5.Midi as a Sequence (``Midi.to_sequence``), the MIDI → Sequence step of the hub
    (plan §2.3); with Sequence to Score it turns a MIDI file into notation."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_MidiToSequence",
            display_name="MIDI to Sequence",
            category="m5/convert",
            description=(
                "One staff per track (named after the track, or its General MIDI instrument); notes "
                "that start and end together are one chord. Pitch bends at a note's start become "
                "microtones (cents). The file's tempo and time signatures go along, so Sequence to "
                "Score writes the same meters and tempo marks."
            ),
            inputs=[m5Midi.Input("midi")],
            outputs=[m5Sequence.Output("sequence")],
        )

    @classmethod
    def execute(cls, midi) -> io.NodeOutput:
        return io.NodeOutput(midi.to_sequence())


class SequenceToMidi(io.ComfyNode):
    """A Sequence as an m5.Midi (``Midi.from_sequence``), the Sequence → MIDI step of the hub."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_SequenceToMidi",
            display_name="Sequence to MIDI",
            category="m5/convert",
            description=(
                "One track per staff (sub-Sequence), named after its instrument. Velocities come "
                "from the notes, else from the dynamic markings (p = 49, mf = 80, f = 96…), else 80. "
                "Microtones become pitch bends, with notes spread over channels so that differently "
                "detuned notes never share one. Keeps the Sequence's tempo map (from a score or a "
                "MIDI file), else 120 BPM in 4/4; the note times in ms are kept either way."
            ),
            inputs=[
                m5Sequence.Input("sequence"),
                io.Float.Input(
                    "bend_range",
                    default=2.0,
                    min=0.5,
                    max=48.0,
                    step=0.5,
                    tooltip=(
                        "Semitones of a full pitch bend, as the synth playing the file is set "
                        "(2 is the General MIDI default; other values are written into the file "
                        "with RPN 0)."
                    ),
                    advanced=True,
                ),
            ],
            outputs=[m5Midi.Output("midi")],
        )

    @classmethod
    def execute(cls, sequence, bend_range: float = 2.0) -> io.NodeOutput:
        return io.NodeOutput(m5.Midi.from_sequence(sequence, bend_range=bend_range))


MIDI_LANES = ("CC", "pitch bend")


class MidiToBPF(io.ComfyNode):
    """One controller lane (or the pitch bend lane) of an m5.Midi as a BPF (``Midi.cc_to_bpf``):
    MIDI as control data (spec: MIDI → Control data)."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_MidiToBPF",
            display_name="MIDI to BPF",
            category="m5/convert",
            description=(
                "A controller (CC) lane, e.g. CC1 modulation, CC7 volume, CC64 sustain, as a step "
                "break-point function with range 0–127; or the pitch bend lane in cents. Preview "
                "the MIDI as text to see which lanes the file has."
            ),
            inputs=[
                m5Midi.Input("midi"),
                io.Combo.Input("lane", options=list(MIDI_LANES), default="CC",
                               tooltip="A controller lane (number below) or the pitch bend lane."),
                io.Int.Input("cc", default=1, min=0, max=127,
                             tooltip="Controller number, for lane = CC (1 modulation, 7 volume, 11 expression, 64 sustain…)."),
                io.Int.Input("channel", default=0, min=0, max=16,
                             tooltip="MIDI channel 1–16; 0 = any channel."),
                io.Int.Input("track", default=-1, min=-1, max=255,
                             tooltip="Track number as Preview as Text lists them (from 0); -1 = any track."),
            ],
            outputs=[m5BPF.Output("bpf")],
        )

    @classmethod
    def execute(cls, midi, lane: str = "CC", cc: int = 1, channel: int = 0, track: int = -1) -> io.NodeOutput:
        controller = m5.PITCH_BEND if lane == "pitch bend" else cc
        return io.NodeOutput(midi.cc_to_bpf(
            controller,
            channel=channel - 1 if channel > 0 else None,
            track=track if track >= 0 else None,
        ))
