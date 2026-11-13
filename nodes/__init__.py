"""The m5 ComfyUI nodes, grouped by module:

- ``types``: the custom ComfyUI types (M5_SCORE, M5_SEQUENCE, M5_BPF, M5_DESCRIPTOR)
- ``boundary``: ComfyUI AUDIO ⇄ m5.Audio conversion, the only code that touches torch
- ``convert``: nodes that convert between representations
- ``create``: nodes that make data from what is entered in the node (the BPF curve editor)
- ``data``: viewers and playback
- ``edit``: transformations within one type (BPF resample/rescale)
- ``io``: file loading (and later export)
"""

from typing_extensions import override

from .convert import OrchideaNode, ScoreToSequence, SequenceToAudio, SequenceToScore
from .data import AudioPlayback, ScoreViewer, SequenceViewer
from .create import BPFNode
from .edit import BPFRescale, BPFResample
from .io import LoadBPF, LoadScore
from .types import m5BPF, m5Score, m5Sequence
from .convert import DescriptorToBPF, DescriptorToSequence
from .io import LoadDescriptor
from .types import m5Descriptor

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
            ScoreToSequence,
            SequenceToScore,
            LoadScore,
            AudioPlayback,
            BPFNode,
            LoadBPF,
            BPFResample,
            BPFRescale,
            LoadDescriptor,
            DescriptorToSequence,
            DescriptorToBPF,
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
    "ScoreToSequence",
    "SequenceToScore",
    "LoadScore",
    "AudioPlayback",
    "m5BPF",
    "BPFNode",
    "LoadBPF",
    "BPFResample",
    "BPFRescale",
    "m5Descriptor",
    "LoadDescriptor",
    "DescriptorToSequence",
    "DescriptorToBPF",
    "m5Extension",
    "comfy_entrypoint",
]
