import contextlib
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any

import numpy as np
import torch
from typing_extensions import override

from comfy_api.latest import ComfyExtension, io
import folder_paths

import m5
import music21

# Any .js file in this directory is loaded by the ComfyUI frontend as an extension.
WEB_DIRECTORY = "./js"


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


@io.comfytype(io_type="M5_SCORE")
class m5Score(io.ComfyTypeIO):
    """An m5.Score (a music21-backed Score) passed between m5 nodes. Produced by
    Orchidea and LoadScore; consumed by ScoreViewer."""
    Type = Any


@io.comfytype(io_type="M5_SEQUENCE")
class m5Sequence(io.ComfyTypeIO):
    """A raw, unquantized m5.Sequence passed between m5 nodes. Produced by
    Orchidea (the orchestration before it is quantized into a Score); consumed by
    SequenceViewer, which renders it as proportional, time-based notation."""
    Type = Any


# Nodes pass audio between each other as ComfyUI's builtin AUDIO, so they connect
# to Load Audio, Save Audio and every other audio node. m5 works on m5.Audio, so
# each node converts at its boundary with these two functions: the only places
# that deal with Comfy's tensor layout.


def _to_m5_audio(audio: io.Audio.Type) -> m5.Audio:
    """Convert a ComfyUI AUDIO dict to an m5.Audio, coercing the waveform to a
    numpy array and dropping the batch axis to go from Comfy's (batch, channels,
    frames) layout to m5's (channels, frames) layout."""
    waveform = audio["waveform"]  # type: torch.Tensor
    sample_rate = audio["sample_rate"]  # type: ignore[typeddict-item]
    if waveform.ndim != 3:
        raise ValueError(
            f"Expected ComfyUI AUDIO waveform to have 3 dimensions "
            f"(batch, channels, frames), but got shape {waveform.shape}"
        )
    if waveform.shape[0] != 1:
        raise ValueError(
            f"Expected ComfyUI AUDIO batch size of 1, but got {waveform.shape[0]}"
        )
    # Remove the batch axis; m5.Audio casts to float32.
    return m5.Audio(waveform=waveform[0].float().numpy(force=True), sample_rate=sample_rate)


def _to_comfy_audio(audio: m5.Audio) -> dict:
    """Convert an m5.Audio to a ComfyUI AUDIO dict, adding the batch axis to go
    from m5's (channels, frames) layout to Comfy's (batch, channels, frames).
    m5.Audio is already float32, which is what Comfy's audio nodes expect."""
    return {
        "waveform": torch.from_numpy(np.ascontiguousarray(audio.waveform)).unsqueeze(0),
        "sample_rate": audio.sample_rate,
    }


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


class OrchideaNode(io.ComfyNode):
    """
    Orchestrate an input audio signal into an M5 score using m5.orchestrate.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_Orchidea",
            display_name="Orchidea",
            category="audio",
            inputs=[
                io.Audio.Input("audio"),
                io.String.Input(
                    "db_files",
                    default="",
                    tooltip=(
                        "Path to the Orchidea spectrum database file "
                        "(e.g. /Datasets/TinySOL/TinySOL.spectrum.db)."
                    ),
                ),
                io.String.Input(
                    "sound_paths",
                    default="",
                    tooltip=(
                        "Path to the folder containing the Orchidea sound samples "
                        "(e.g. /Datasets/TinySOL/TinySOL)."
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
                    max=1.0,
                    step=0.01,
                    tooltip=(
                        "Sensitivity of onset detection for dynamic (temporal) "
                        "orchestration. 0 segments at any minimal spectral variation; "
                        "raise it to reduce sensitivity. Above 1 there are no onsets "
                        "and the target is treated as static."
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
        db_files: str,
        sound_paths: str,
        orchestra: str,
        sparsity: float,
        partials_filtering: bool,
        partials_filtering_threshold_db: float,
        onsets_threshold: float,
    ) -> io.NodeOutput:
        m5_audio = _to_m5_audio(audio)

        # These override the matching keys in the Orchidea config file.
        parameters = {
            "sparsity": sparsity,
            "partials_filtering": partials_filtering,
            "partials_filtering_threshold_db": partials_filtering_threshold_db,
            "onsets_threshold": onsets_threshold,
        }
        # The string widgets override their config keys only when non-blank: a
        # blank widget must fall back to the value baked into the Orchidea
        # config, NOT overwrite it with an empty value (the binary rejects an
        # empty db_files/sound_paths/orchestra line as "invalid syntax"). The
        # orchestra widget is multiline for readability, so collapse any
        # whitespace (newlines included) into the single space-separated line
        # the config expects.
        if orchestra.strip():
            parameters["orchestra"] = " ".join(orchestra.split())
        if db_files.strip():
            parameters["db_files"] = db_files.strip()
        if sound_paths.strip():
            parameters["sound_paths"] = sound_paths.strip()

        orchestration = m5.orchestrate(m5_audio, parameters=parameters)
        # orchestrate() returns the orchestration as an m5.Sequence;
        # build the music21-backed Score the viewer/image rendering needs.
        # The raw orchestration.sequence is also exposed as an output so it can
        # be shown unquantized (proportional notation) by the Sequence Viewer.
        score = m5.Score.from_sequence(orchestration.sequence)

        if orchestration.audio is None:
            raise RuntimeError(
                "Orchidea produced no audio realization (connection.wav). This "
                "can happen if the constraints were too strict. Try reducing the "
                "partials filtering or including more dynamics and playing styles."
            )
        return io.NodeOutput(
            score, _to_comfy_audio(orchestration.audio), orchestration.sequence
        )


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


class LoadScore(io.ComfyNode):
    """Load a score from any file music21 can parse (MusicXML, MIDI, ...) into an
    m5.Score, so the Score Viewer can display arbitrary scores, not just
    orchestrations."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_LoadScore",
            display_name="Load Score",
            category="music",
            inputs=[
                io.String.Input(
                    "path",
                    default="",
                    tooltip=(
                        "Path to a score file music21 can parse "
                        "(e.g. a .musicxml, .xml, .mxl or .mid file)."
                    ),
                ),
            ],
            outputs=[m5Score.Output("score")],
        )

    @classmethod
    def execute(cls, path: str) -> io.NodeOutput:
        return io.NodeOutput(m5.Score.from_file(path))


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


class m5Extension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            OrchideaNode,
            ScoreViewer,
            SequenceViewer,
            SequenceToAudio,
            LoadScore,
            AudioPlayback,
        ]


async def comfy_entrypoint() -> m5Extension:
    return m5Extension()
