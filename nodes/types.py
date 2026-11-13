"""Custom ComfyUI types carrying m5 objects between nodes."""

from typing import Any

from comfy_api.latest import io


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


@io.comfytype(io_type="M5_BPF")
class m5BPF(io.ComfyTypeIO):
    """An m5.BPF (break-point function / automation curve: (time_ms, value) points +
    interpolation + range) passed between m5 nodes. Drawn in (and shown by) the BPF node;
    produced by LoadBPF, BPFRescale, BPFResample."""
    Type = Any


@io.comfytype(io_type="M5_DESCRIPTOR")
class m5Descriptor(io.ComfyTypeIO):
    """An m5.Descriptor (named analysis tracks over time: time series such as f0 or loudness
    with units and ranges, and frame matrices such as partials) passed between m5 nodes.
    Produced by LoadDescriptor; consumed by DescriptorToSequence and DescriptorToBPF; shown as
    text by ComfyUI's Preview as Text until the Descriptor viewer (M3.5)."""
    Type = Any


@io.comfytype(io_type="M5_MIDI")
class m5Midi(io.ComfyTypeIO):
    """An m5.Midi (tracks of notes, controller lanes and pitch bends, timed in ms, plus the file's
    tempo/meter map) passed between m5 nodes. Produced by LoadMidi and SequenceToMidi; consumed by
    MidiToSequence, MidiToBPF and SaveMidi; shown as text by ComfyUI's Preview as Text until the
    MIDI viewer (M3.4)."""
    Type = Any
