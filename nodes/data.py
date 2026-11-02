"""Display nodes: viewers and playback for scores, sequences and audio."""

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
from .types import m5Score, m5Sequence


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


def _note_payload(start_ms: float, event) -> dict:
    """Serialize one m5.Event into a plain dict for the Sequence Viewer frontend.

    ``pitches`` is always a list of symbolic pitch-name strings: the Event's own
    ``pitch`` values when present, otherwise derived from its ``midi_note`` values
    (so the frontend always gets names and never has to know MIDI). An empty list
    means an unpitched event. Onset and duration stay in milliseconds.
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
    if dynamic is not None:
        note["dynamic"] = dynamic
    style = _first(event.playing_style)
    if style is not None:
        note["playing_style"] = style
    detuning = _first(event.custom_fields.get("detuning_cents"))
    if detuning:
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
        notes = [_note_payload(start_ms, event) for start_ms, event in events]
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
                    "pixels_per_second",
                    default=120.0,
                    min=4.0,
                    max=2000.0,
                    step=4.0,
                    tooltip=(
                        "Horizontal time scale: how many pixels one second of the "
                        "timeline occupies. Larger values spread events out; scroll "
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
    def execute(cls, sequence, pixels_per_second: float) -> io.NodeOutput:
        # `sequence` is the m5.Sequence carried by M5_SEQUENCE. Serialize it to the
        # plain JSON payload the frontend renders; the frontend reads
        # message.sequence_data[0] and message.pixels_per_second[0].
        payload = _sequence_to_payload(sequence)
        return io.NodeOutput(
            ui={
                "sequence_data": [payload],
                "pixels_per_second": [pixels_per_second],
            }
        )

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

