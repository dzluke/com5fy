"""Nodes that transform one representation without changing its type (``m5/edit``)."""

from comfy_api.latest import io

import m5

from .types import m5BPF


class BPFResample(io.ComfyNode):
    """Sample a BPF on a regular grid (``m5.BPF.resample``): e.g. keyframes or a control rate for
    software that wants evenly spaced frames."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_BPFResample",
            display_name="BPF Resample",
            category="m5/edit",
            inputs=[
                m5BPF.Input("bpf"),
                io.Float.Input("step_ms", default=100.0, min=1.0, max=60000.0, step=1.0,
                               tooltip="Grid spacing in ms. The last point's time is always included."),
            ],
            outputs=[m5BPF.Output("bpf")],
        )

    @classmethod
    def execute(cls, bpf: m5.BPF, step_ms: float) -> io.NodeOutput:
        return io.NodeOutput(bpf.resample(step_ms))


class BPFRescale(io.ComfyNode):
    """Map a BPF's values linearly onto a new range (``m5.BPF.rescale``), e.g. a descriptor in Hz
    onto 0–1 or 0–127 to drive a parameter. low > high inverts the curve."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_BPFRescale",
            display_name="BPF Rescale",
            category="m5/edit",
            inputs=[
                m5BPF.Input("bpf"),
                io.Float.Input("low", default=0.0, min=-1e9, max=1e9, step=0.01,
                               tooltip="Value the bottom of the BPF's range maps to."),
                io.Float.Input("high", default=1.0, min=-1e9, max=1e9, step=0.01,
                               tooltip="Value the top of the BPF's range maps to."),
            ],
            outputs=[m5BPF.Output("bpf")],
            description=(
                "The source range is the BPF's declared range (e.g. from its JSON file), "
                "or the min/max of its points when it has none."
            ),
        )

    @classmethod
    def execute(cls, bpf: m5.BPF, low: float, high: float) -> io.NodeOutput:
        return io.NodeOutput(bpf.rescale(low, high))
