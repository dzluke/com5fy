"""Conversions between ComfyUI's types and m5's, at the node boundary."""

import numpy as np
import torch

from comfy_api.latest import io

import m5


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
