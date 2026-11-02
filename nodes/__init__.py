"""The m5 ComfyUI nodes, grouped by module:

- ``types``: the custom ComfyUI types (M5_SCORE, M5_SEQUENCE)
- ``boundary``: ComfyUI AUDIO ⇄ m5.Audio conversion, the only code that touches torch
- ``convert``: nodes that convert between representations
- ``data``: viewers and playback
- ``io``: file loading (and later export)
"""

from typing_extensions import override

from .convert import OrchideaNode, SequenceToAudio
from .data import AudioPlayback, ScoreViewer, SequenceViewer
from .io import LoadScore
from .types import m5Score, m5Sequence

# Imported after the submodules on purpose: importing ``.io`` binds the name ``io`` in
# this package to that submodule, so ComfyUI's ``io`` must be bound afterwards.
from comfy_api.latest import ComfyExtension, io  # noqa: E402

# Any .js file in this directory is loaded by the ComfyUI frontend as an extension.
# Relative to the com5fy package root, which ComfyUI resolves it against.
WEB_DIRECTORY = "./js"


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


__all__ = [
    "WEB_DIRECTORY",
    "m5Score",
    "m5Sequence",
    "OrchideaNode",
    "ScoreViewer",
    "SequenceViewer",
    "SequenceToAudio",
    "LoadScore",
    "AudioPlayback",
    "m5Extension",
    "comfy_entrypoint",
]
