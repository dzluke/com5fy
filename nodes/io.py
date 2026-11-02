"""Nodes that read (and later write) files."""

from comfy_api.latest import io

import m5

from .types import m5Score


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

