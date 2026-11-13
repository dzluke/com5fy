"""Display nodes: viewers and playback for scores, sequences, MIDI and audio."""

import contextlib
import os
import uuid
from typing import Any

import numpy as np

from comfy_api.latest import io
import folder_paths

import m5
import music21

from .boundary import _to_m5_audio
from .types import m5Midi, m5Score, m5Sequence


@contextlib.contextmanager
def _no_placeholder_metadata():
    """Suppress music21's placeholder title/composer while exporting a score.

    music21's MusicXML exporter falls back to global defaults
    (``defaults.title`` = "Music21 Fragment", ``defaults.author`` = "Music21")
    whenever a score carries no real title/composer, so a score that simply
    lacks metadata comes out stamped with those placeholders. Blanking the two
    defaults for the duration of an export makes the exporter emit no
    movement-title/creator at all in that case, while any *real* metadata the
    score does hold is still written through untouched (the exporter only
    reaches for the defaults when nothing real is found). Restored afterwards so
    we don't mutate music21's global state for anything else."""
    saved_title = music21.defaults.title
    saved_author = music21.defaults.author
    music21.defaults.title = ""
    music21.defaults.author = ""
    try:
        yield
    finally:
        music21.defaults.title = saved_title
        music21.defaults.author = saved_author


def _first(values):
    """First value of an Event field list (or None). Event fields hold a list of
    values (one per chord member / voice)."""
    return values[0] if values else None


# Sharp spellings only, so a MIDI-derived pitch name is always unambiguous for the
# frontend. (music21's nameWithOctave spells flats with "-", e.g. "B-4", which
# collides with a negative octave when parsed in JS; the symbolic pitches Orchidea
# emits already use "#".)
_MIDI_SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _midi_to_name(midi: int) -> str:
    """Convert a MIDI note number to a sharp-spelled pitch name like "C#4"
    (MIDI 60 ⇒ "C4", following the convention that MIDI 60 is middle C / C4)."""
    return f"{_MIDI_SHARP_NAMES[midi % 12]}{midi // 12 - 1}"


def _flatten_sequence(sequence, base_ms: float = 0.0) -> list[tuple[float, Any]]:
    """Flatten a (possibly nested) m5.Sequence into ``(absolute_start_ms, Event)``
    pairs, accumulating the onset of each enclosing Sequence.

    Mirrors ``m5.score._flatten`` so the Sequence Viewer reads a Sequence's
    hierarchy exactly as ``Score.from_sequence`` does, kept local so this node
    doesn't depend on a private name in m5.
    """
    out: list[tuple[float, Any]] = []
    for start, item in sequence.events:
        if isinstance(item, m5.Sequence):
            out.extend(_flatten_sequence(item, base_ms + start))
        else:
            out.append((base_ms + start, item))
    out.sort(key=lambda pair: pair[0])
    return out


def _note_payload(start_ms: float, event, shown: dict) -> dict:
    """Serialize one m5.Event into a plain dict for the Sequence Viewer frontend.

    ``pitches`` is always a list of symbolic pitch-name strings: the Event's own
    ``pitch`` values when present, otherwise derived from its ``midi_note`` values
    (so the frontend always gets names and never has to know MIDI). An empty list
    means an unpitched event. Onset and duration stay in milliseconds.

    Markings are written the way a score shows them: ``dynamic`` and
    ``playing_style`` (a text expression such as "pizz.") only where they
    change on the staff (``shown`` tracks the last ones written), since some
    Sequences, like Orchidea's, repeat them on every event; ``articulations``
    (``"staccato"``…) on every note that has them. ``detuning_cents`` has one
    value per pitch, only when some pitch is detuned.
    """
    if event.pitch:
        pitches = list(event.pitch)
    elif event.midi_note:
        pitches = [_midi_to_name(m) for m in event.midi_note]
    else:
        pitches = []

    note = {
        "start_ms": start_ms,
        "duration_ms": event.duration,
        "pitches": pitches,
    }
    # Optional per-note annotations, included only when present so the payload
    # stays small and the frontend can treat them as truly optional.
    dynamic = _first(event.dynamic)
    if dynamic and dynamic != shown.get("dynamic"):
        note["dynamic"] = shown["dynamic"] = dynamic
    style = next((s for s in event.playing_style if s not in m5.ARTICULATIONS), None)
    if style and style != shown.get("playing_style"):
        note["playing_style"] = shown["playing_style"] = style
    articulations = [s for s in event.playing_style if s in m5.ARTICULATIONS]
    if articulations:
        note["articulations"] = articulations
    detuning = list(event.custom_fields.get("detuning_cents") or [])
    if pitches and any(detuning):
        # One value per pitch; a single value applies to every pitch.
        if len(detuning) != len(pitches):
            detuning = [detuning[0]] * len(pitches)
        note["detuning_cents"] = detuning
    return note


def _sequence_to_payload(sequence) -> dict:
    """Serialize an m5.Sequence into the JSON payload the Sequence Viewer renders.

    The Sequence is interpreted hierarchically the same way ``Score.from_sequence``
    does: each top-level item that is itself a Sequence becomes one staff, and any
    bare top-level Events are collected into a single default staff. Each staff is
    flattened to absolute-millisecond onsets and named from its events'
    ``instrument`` custom field. The result is::

        {"staves": [{"instrument": str|None, "notes": [note, ...]}, ...],
         "duration_ms": float}
    """
    staff_seqs: list = []
    loose: list[tuple[float, Any]] = []
    for start, item in sequence.events:
        if isinstance(item, m5.Sequence):
            staff_seqs.append((start, item))
        else:
            loose.append((start, item))
    if loose:
        staff_seqs.append((0.0, m5.Sequence(events=loose)))

    staves: list[dict] = []
    duration_ms = 0.0
    for base_ms, staff_seq in staff_seqs:
        events = _flatten_sequence(staff_seq, base_ms)
        instrument = next(
            (
                _first(event.custom_fields.get("instrument"))
                for _, event in events
                if _first(event.custom_fields.get("instrument"))
            ),
            None,
        )
        shown: dict = {}
        notes = [_note_payload(start_ms, event, shown) for start_ms, event in events]
        for note in notes:
            duration_ms = max(duration_ms, note["start_ms"] + note["duration_ms"])
        staves.append({"instrument": instrument, "notes": notes})

    return {"staves": staves, "duration_ms": duration_ms}

class ScoreViewer(io.ComfyNode):
    """Display any m5.Score as engraved notation (via OpenSheetMusicDisplay).

    Generic by design: it knows nothing about Orchidea — it serializes whatever
    m5.Score it is given to MusicXML and hands that to the frontend widget, so a
    score from LoadScore renders exactly like one from Orchidea. All musical
    meaning (dynamics, articulations, playing styles) lives in the Score itself.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_ScoreViewer",
            display_name="Score Viewer",
            category="music",
            inputs=[m5Score.Input("score")],
            outputs=[],
            # No graph outputs, so mark it an output node: that makes ComfyUI
            # always execute it and deliver the returned `ui` to the frontend.
            is_output_node=True,
        )

    @classmethod
    def execute(cls, score) -> io.NodeOutput:
        # score is the m5.Score object carried by M5_SCORE. to_musicxml() exports
        # it headlessly (no MuseScore). The frontend reads message.musicxml[0].
        # Suppress music21's placeholder title/composer so a score without
        # metadata isn't shown titled "Music21 Fragment" / "Music21"; real
        # title/composer/subtitle in the score are preserved.
        with _no_placeholder_metadata():
            musicxml = score.to_musicxml()
        return io.NodeOutput(ui={"musicxml": [musicxml]})


# Pixels per second of the Sequence Viewer at zoom 1 (the frontend's
# BASE_PIXELS_PER_SECOND matches).
BASE_PIXELS_PER_SECOND = 120.0


class SequenceViewer(io.ComfyNode):
    """Display a raw, unquantized m5.Sequence as proportional, time-based notation.

    Unlike the Score Viewer (which engraves a quantized Score in conventional
    metered notation), this viewer has no bar lines, meters or beats: every event
    is an identical notehead placed horizontally at its absolute onset *time*, one
    stacked staff per instrument over a shared time axis, with overlapping voices
    allowed within a staff. It serializes the Sequence to a plain JSON payload and
    hands it to the frontend widget, which renders it with VexFlow.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_SequenceViewer",
            display_name="Sequence Viewer",
            category="music",
            inputs=[
                m5Sequence.Input("sequence"),
                io.Float.Input(
                    "zoom",
                    default=1.0,
                    min=0.05,
                    max=20.0,
                    step=0.05,
                    round=0.01,
                    tooltip=(
                        "Horizontal zoom of the time axis: 1 shows one second as "
                        f"{BASE_PIXELS_PER_SECOND:g} pixels, 2 spreads events twice as "
                        "far apart, 0.5 fits twice as much. Changing it redraws the "
                        "viewer right away, without running the workflow. Scroll "
                        "the viewer horizontally to travel through time."
                    ),
                ),
            ],
            outputs=[],
            # No graph outputs, so mark it an output node: that makes ComfyUI
            # always execute it and deliver the returned `ui` to the frontend.
            is_output_node=True,
        )

    @classmethod
    def execute(cls, sequence, zoom: float = 1.0) -> io.NodeOutput:
        # `sequence` is the m5.Sequence carried by M5_SEQUENCE. Serialize it to the
        # plain JSON payload the frontend renders; the frontend reads
        # message.sequence_data[0] and message.zoom[0] (and then follows the
        # zoom widget live).
        payload = _sequence_to_payload(sequence)
        return io.NodeOutput(ui={"sequence_data": [payload], "zoom": [zoom]})


def _write_preview_audio(audio: m5.Audio) -> dict:
    """Write an m5.Audio to ComfyUI's temp directory as FLAC for the frontend to
    play, returning the ``{filename, subfolder, type}`` reference that the /view
    route resolves.

    Samples are clipped to [-1, 1] first: libsndfile converts float to integer
    PCM without clipping by default, so an out-of-range sample would wrap
    around into a loud click instead of saturating.
    """
    temp_dir = folder_paths.get_temp_directory()
    os.makedirs(temp_dir, exist_ok=True)
    filename = f"m5_playback_{uuid.uuid4().hex[:12]}.flac"
    waveform = np.clip(audio.waveform, -1.0, 1.0)
    m5.Audio(waveform=waveform, sample_rate=audio.sample_rate).write(
        os.path.join(temp_dir, filename)
    )
    return {"filename": filename, "subfolder": "", "type": "temp"}


class AudioPlayback(io.ComfyNode):
    """Play audio inside the node, with a waveform view, a scrubbable playhead
    and an optional spectrogram.

    Takes a ComfyUI AUDIO (e.g. Load Audio's output) and passes it on unchanged.
    The waveform, spectrogram, playback and scrubbing are all done by the
    frontend widget (js/audio-playback.js).
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_AudioPlayback",
            display_name="Audio Playback",
            category="audio",
            inputs=[
                io.Audio.Input(
                    "audio",
                    tooltip="Audio to play (e.g. from Load Audio or Orchidea).",
                ),
            ],
            outputs=[io.Audio.Output("audio")],
            # Always execute and deliver the returned `ui` to the frontend, even
            # when nothing downstream consumes the audio output.
            is_output_node=True,
        )

    @classmethod
    def execute(cls, audio: io.Audio.Type) -> io.NodeOutput:
        # The frontend reads message.playback_audio[0]. (Deliberately not the
        # "audio" key: ComfyUI's builtin audio extension would claim that and
        # look for a player widget this node doesn't have.)
        preview = _write_preview_audio(_to_m5_audio(audio))
        return io.NodeOutput(audio, ui={"playback_audio": [preview]})



# Most barlines the MIDI Viewer draws: a long file still gets a grid, but a broken time map
# (say 1000 BPM) can't produce a huge payload.
MAX_BARS = 4000


def _midi_grid(midi) -> tuple[list[dict], list[float]]:
    """Barlines ``{ms, measure}`` and beat times (ms, without the barlines) of ``midi``'s time
    map, from 0 to the end of the file. A pickup measure starts at 0 with its own number."""
    tm, end_ms = midi.time_map, midi.duration
    bars: list[dict] = []
    beats: list[float] = []
    measure = tm.first_measure - (1 if tm.pickup > 0 else 0)
    while len(bars) < MAX_BARS:
        start_q = tm.measure_start_quarters(measure)
        start_ms = tm.quarters_to_ms(max(start_q, 0.0))
        if start_ms > end_ms + 1e-6 and bars:
            break
        bars.append({"ms": start_ms, "measure": measure})
        meter = tm.meter_at(measure)
        for beat in range(1, meter.numerator):
            q = start_q + beat * meter.beat_quarters
            if q > 1e-9:
                beats.append(tm.quarters_to_ms(q))
        measure += 1
    return bars, beats


def _midi_to_payload(midi) -> dict:
    """Serialize an m5.Midi into the JSON payload the MIDI Viewer's piano roll draws::

        {"tracks": [{"name": str, "channels": [1-based…],
                     "notes": [[start_ms, duration_ms, pitch, velocity, channel (1-based), cents], …]}],
         "duration_ms": float, "bars": [{"ms", "measure"}…], "beats": [ms…],
         "tempo": "♩ = 100" (first tempo), "meter": "3/4" (first meter)}

    Notes are compact lists, not dicts: a piano part easily has thousands. ``cents`` is the
    pitch bend at the note's start (``Midi.detuning_cents``), so microtones sit between keys.
    Tracks without notes (controller-only) are kept, so track numbers match MIDI to BPF's.
    """
    tracks = []
    for track in midi.tracks:
        notes = [
            [
                round(n.start_ms, 3),
                round(n.duration_ms, 3),
                n.pitch,
                n.velocity,
                n.channel + 1,
                round(midi.detuning_cents(n), 1),
            ]
            for n in sorted(track.notes, key=lambda n: (n.start_ms, n.pitch))
        ]
        tracks.append({"name": track.name, "channels": [c + 1 for c in track.channels], "notes": notes})
    bars, beats = _midi_grid(midi)
    tempo, meter = midi.time_map.tempos[0], midi.time_map.meters[0]
    return {
        "tracks": tracks,
        "duration_ms": midi.duration,
        "bars": bars,
        "beats": beats,
        "tempo": f"\u2669 = {tempo.quarter_bpm:g}",
        "meter": f"{meter.numerator}/{meter.denominator}",
    }


class MidiViewer(io.ComfyNode):
    """Show an m5.Midi as a piano roll and play it with m5's basic synth.

    The piano roll is drawn by the frontend from a compact JSON payload (one row per key,
    tracks in colors, barlines from the file's time map); playback is a FLAC of
    ``m5.synthesize_midi`` in ComfyUI's temp folder, like Audio Playback's. The MIDI passes
    through unchanged.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_MidiViewer",
            display_name="MIDI Viewer",
            category="m5/data",
            description=(
                "Piano roll of the MIDI: one row per key, one color per track, barlines and "
                "measure numbers from the file's tempo and meter, notes fainter when softer; "
                "microtones (pitch bend at a note's start) sit between rows. Hover a note for "
                "its pitch, velocity, channel and timing. Play listens through a basic synth "
                "(a soft additive tone; channel 10 drums are noise hits) that follows velocity, "
                "pitch bend and the sustain pedal. Click or drag on the roll to move the playhead."
            ),
            inputs=[
                m5Midi.Input("midi"),
                io.Float.Input(
                    "zoom",
                    default=1.0,
                    min=0.1,
                    max=50.0,
                    step=0.1,
                    round=0.01,
                    tooltip=(
                        "Horizontal zoom: 1 fits the whole file into the node's width, 2 shows "
                        "half of it at a time, and so on (scroll sideways to travel). Changing "
                        "it redraws right away, without running the workflow."
                    ),
                ),
            ],
            outputs=[m5Midi.Output("midi")],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, midi, zoom: float = 1.0) -> io.NodeOutput:
        # The frontend reads message.midi_data[0] and message.playback_audio[0].
        payload = _midi_to_payload(midi)
        preview = _write_preview_audio(m5.synthesize_midi(midi)) if midi.duration > 0 else None
        ui = {"midi_data": [payload], "zoom": [zoom]}
        if preview:
            ui["playback_audio"] = [preview]
        return io.NodeOutput(midi, ui=ui)
