"""Nodes that create data from what the user enters in the node (``m5/create``)."""

import json

from comfy_api.latest import io

import m5

from .types import m5BPF

# A rising ramp over the default 4 s: something visible to start drawing from.
DEFAULT_DURATION_MS = 4000.0
DEFAULT_POINTS = json.dumps([[0.0, 0.0], [DEFAULT_DURATION_MS, 1.0]])


def _bpf_from_editor(
    points: str,
    duration_ms: float,
    low: float,
    high: float,
    interpolation: str = "linear",
    name: str = "",
    unit: str = "",
) -> m5.BPF:
    """Build the m5.BPF drawn in the BPF node's curve editor.

    ``points`` is the editor's widget value: a JSON list of ``[time_ms, value]`` pairs. The
    editor keeps points inside its box (0–``duration_ms`` × ``low``–``high``); points outside
    it (a hand-edited workflow, or a range narrowed after drawing) are clipped to the box, so
    the output is what the editor shows. The box's value bounds become the BPF's ``range``.
    """
    if not high > low:
        raise ValueError(f"BPF: max ({high}) must be greater than min ({low})")
    if not duration_ms > 0:
        raise ValueError(f"BPF: duration_ms must be > 0, got {duration_ms}")
    try:
        pairs = json.loads(points or "[]")
        pairs = [(float(t), float(v)) for t, v in pairs]
    except (ValueError, TypeError) as e:
        raise ValueError(f"BPF: points must be a JSON list of [time_ms, value] pairs ({e})") from None
    clipped = [(min(max(t, 0.0), duration_ms), min(max(v, low), high)) for t, v in pairs]
    return m5.BPF(clipped, interpolation, range=(low, high), name=name, unit=unit)


def _bpf_payload(bpf: m5.BPF, source: str, duration_ms: float | None = None) -> dict:
    """What the curve editor needs to draw a BPF (sent as the node's ``ui``)."""
    lo, hi = bpf.value_range
    return {
        "points": [list(p) for p in bpf.points],
        "interpolation": bpf.interpolation,
        "range": [lo, hi],
        "duration": duration_ms if duration_ms is not None else bpf.duration,
        "name": bpf.name,
        "unit": bpf.unit,
        "source": source,
    }


class BPFNode(io.ComfyNode):
    """Draw a break-point function (automation curve) in the node, like Max's ``function``
    object or a DAW automation lane: click to add a point, drag to move, double-click or
    right-click to delete.

    With a BPF connected to ``input``, the node shows that curve instead (read-only) and passes
    it through, so it also serves as the BPF viewer; its "Edit a copy" button copies the
    incoming curve into the editor.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_BPF",
            display_name="BPF",
            category="m5/create",
            is_output_node=True,
            inputs=[
                m5BPF.Input(
                    "input", optional=True,
                    tooltip="Optional. A BPF to show (read-only) and pass through instead of the drawn curve.",
                ),
                io.String.Input(
                    "points", default=DEFAULT_POINTS, socketless=True,
                    tooltip="The drawn points, a JSON list of [time_ms, value] (edited in the curve editor).",
                ),
                io.Float.Input("duration_ms", default=DEFAULT_DURATION_MS, min=1.0, max=3_600_000.0, step=100.0,
                               tooltip="Length of the editor's time axis in ms."),
                io.Float.Input("min", default=0.0, min=-1e9, max=1e9, step=0.1,
                               tooltip="Bottom of the value axis (and of the BPF's range)."),
                io.Float.Input("max", default=1.0, min=-1e9, max=1e9, step=0.1,
                               tooltip="Top of the value axis (and of the BPF's range)."),
                io.Combo.Input("interpolation", options=list(m5.INTERPOLATIONS), default="linear",
                               tooltip="step: hold each value; linear; exp: geometric (for Hz, amplitudes)."),
                io.String.Input("name", default="", tooltip="Optional: what the curve controls (e.g. brightness)."),
                io.String.Input("unit", default="", tooltip="Optional: the values' unit (e.g. Hz)."),
            ],
            outputs=[m5BPF.Output("bpf")],
        )

    @classmethod
    def execute(
        cls,
        points: str,
        duration_ms: float,
        min: float,  # noqa: A002 (the widget's name)
        max: float,  # noqa: A002
        interpolation: str,
        name: str = "",
        unit: str = "",
        input: m5.BPF | None = None,  # noqa: A002
    ) -> io.NodeOutput:
        if input is not None:
            return io.NodeOutput(input, ui={"bpf": [_bpf_payload(input, "input")]})
        bpf = _bpf_from_editor(points, duration_ms, min, max, interpolation, name, unit)
        return io.NodeOutput(bpf, ui={"bpf": [_bpf_payload(bpf, "editor", duration_ms)]})
