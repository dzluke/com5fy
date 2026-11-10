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
