"""Shared setup for the com5fy tests.

The tests import the node classes and call ``execute`` directly, without a running
ComfyUI. That needs the ComfyUI root on ``sys.path`` (for ``comfy_api`` and
``folder_paths``) so this package imports as ``custom_nodes.com5fy``. The root
``pytest.ini`` already sets ``pythonpath = .``; adding it here too keeps the tests
working when pytest is started from somewhere else.
"""

import sys
from pathlib import Path

import numpy as np
import pytest
import torch

COMFY_ROOT = Path(__file__).resolve().parents[3]
if str(COMFY_ROOT) not in sys.path:
    sys.path.insert(0, str(COMFY_ROOT))

import m5  # noqa: E402

DATA = Path(__file__).resolve().parent / "data"


def pytest_configure(config):
    # The ComfyUI root pytest.ini doesn't know m5's markers; declare them here.
    config.addinivalue_line("markers", "slow: takes more than a few seconds (e.g. runs Orchidea)")
    config.addinivalue_line(
        "markers",
        "external: needs something not shipped in the repo (Orchidea sound database, a model, an LLM server)",
    )


def pytest_collection_modifyitems(config, items):
    # Same default as m5 (plan §3): skip slow/external tests unless a -m expression is
    # given. Checks the command line rather than the option value so that -m "" (run
    # everything) counts too.
    if any(arg.startswith("-m") for arg in config.invocation_params.args):
        return
    skip = pytest.mark.skip(reason="slow/external: run with -m slow, -m external or -m ''")
    for item in items:
        if "slow" in item.keywords or "external" in item.keywords:
            item.add_marker(skip)


@pytest.fixture
def score_path() -> Path:
    """Four bars of 4/4 for flute: 12 quarter notes, then a C major whole-note chord
    (a copy of m5's fixture, so this repo's tests don't depend on mmmmm's layout)."""
    return DATA / "four_bars.musicxml"


@pytest.fixture
def duo_path() -> Path:
    """Flute and cello, ♩=90 then ♩=120, with dynamics, articulations, pizz./arco,
    a tie and a quarter-flat (the M2.1 workflow's input)."""
    return DATA / "duo_tempo_dynamics.musicxml"


@pytest.fixture
def comfy_audio() -> dict:
    """A ComfyUI AUDIO dict: 0.5 s stereo 440 Hz sine at 8 kHz, shape (1, 2, 4000)."""
    rate = 8000
    t = np.arange(rate // 2) / rate
    mono = 0.5 * np.sin(2 * np.pi * 440 * t)
    waveform = torch.from_numpy(np.stack([mono, -mono]).astype(np.float32)).unsqueeze(0)
    return {"waveform": waveform, "sample_rate": rate}


@pytest.fixture
def sequence() -> m5.Sequence:
    """Two instrument staves (nested Sequences) plus one loose event.

    Flute: C4 at 0 ms (mf, ordinario) and a MIDI-only note (61 ⇒ C#4) at 500 ms.
    Oboe (starts at 250 ms): an A4 a quarter-tone sharp. Loose: an unpitched event.
    """
    flute = m5.Sequence()
    flute.add(0, m5.Event(duration=500, pitch=["C4"], dynamic=["mf"], playing_style=["ord"],
                          custom_fields={"instrument": ["Fl"]}))
    flute.add(500, m5.Event(duration=500, midi_note=[61], custom_fields={"instrument": ["Fl"]}))
    oboe = m5.Sequence()
    oboe.add(0, m5.Event(duration=1000, pitch=["A4"],
                         custom_fields={"instrument": ["Ob"], "detuning_cents": [50]}))
    seq = m5.Sequence()
    seq.add(0, flute)
    seq.add(250, oboe)
    seq.add(100, m5.Event(duration=200))
    return seq
