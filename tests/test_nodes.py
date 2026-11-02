"""Call each node's ``execute`` directly, plus the AUDIO ⇄ m5.Audio boundary helpers."""

import asyncio
from pathlib import Path

import numpy as np
import pytest
import torch

import folder_paths
import m5

import custom_nodes.com5fy as com5fy
from custom_nodes.com5fy.nodes.boundary import _to_comfy_audio, _to_m5_audio
from custom_nodes.com5fy.nodes.data import _midi_to_name, _sequence_to_payload

NODE_IDS = {
    "m5_Orchidea",
    "m5_ScoreViewer",
    "m5_SequenceViewer",
    "m5_SequenceToAudio",
    "m5_LoadScore",
    "m5_AudioPlayback",
}


# --- extension / registration -------------------------------------------------

def test_extension_lists_every_node_with_stable_ids():
    extension = asyncio.run(com5fy.comfy_entrypoint())
    nodes = asyncio.run(extension.get_node_list())
    # Node ids are what saved workflows reference: they must never change.
    assert {node.define_schema().node_id for node in nodes} == NODE_IDS


def test_package_exports_web_directory():
    assert com5fy.WEB_DIRECTORY == "./js"


# --- boundary helpers ----------------------------------------------------------

def test_to_m5_audio_drops_batch_axis(comfy_audio):
    audio = _to_m5_audio(comfy_audio)
    assert isinstance(audio, m5.Audio)
    assert audio.sample_rate == 8000
    assert audio.waveform.shape == (2, 4000)
    assert audio.waveform.dtype == np.float32
    np.testing.assert_array_equal(audio.waveform, comfy_audio["waveform"][0].numpy())


def test_to_m5_audio_casts_to_float32(comfy_audio):
    comfy_audio["waveform"] = comfy_audio["waveform"].double()
    assert _to_m5_audio(comfy_audio).waveform.dtype == np.float32


@pytest.mark.parametrize("shape", [(2, 4000), (2, 2, 4000)])
def test_to_m5_audio_rejects_bad_shapes(shape):
    with pytest.raises(ValueError):
        _to_m5_audio({"waveform": torch.zeros(shape), "sample_rate": 8000})


def test_audio_round_trip(comfy_audio):
    back = _to_comfy_audio(_to_m5_audio(comfy_audio))
    assert back["sample_rate"] == comfy_audio["sample_rate"]
    assert back["waveform"].dtype == torch.float32
    assert torch.equal(back["waveform"], comfy_audio["waveform"])


def test_to_comfy_audio_adds_batch_axis():
    audio = m5.Audio(waveform=np.zeros((1, 10), dtype=np.float32), sample_rate=100)
    assert _to_comfy_audio(audio)["waveform"].shape == (1, 1, 10)


# --- Sequence Viewer payload ----------------------------------------------------

@pytest.mark.parametrize("midi, name", [(60, "C4"), (61, "C#4"), (21, "A0"), (0, "C-1"), (127, "G9")])
def test_midi_to_name_is_sharp_spelled(midi, name):
    assert _midi_to_name(midi) == name


def test_sequence_payload_has_one_staff_per_subsequence(sequence):
    payload = _sequence_to_payload(sequence)
    flute, oboe, loose = payload["staves"]
    assert flute["instrument"] == "Fl"
    assert oboe["instrument"] == "Ob"
    assert loose["instrument"] is None
    assert payload["duration_ms"] == 1250.0

    assert flute["notes"][0] == {
        "start_ms": 0.0, "duration_ms": 500, "pitches": ["C4"], "dynamic": "mf", "playing_style": "ord",
    }
    # MIDI-only notes get a sharp-spelled name; optional keys are left out when absent.
    assert flute["notes"][1] == {"start_ms": 500.0, "duration_ms": 500, "pitches": ["C#4"]}
    # Onsets of nested sequences are absolute.
    assert oboe["notes"][0]["start_ms"] == 250.0
    assert oboe["notes"][0]["detuning_cents"] == 50
    assert loose["notes"] == [{"start_ms": 100.0, "duration_ms": 200, "pitches": []}]


def test_sequence_payload_of_empty_sequence():
    assert _sequence_to_payload(m5.Sequence()) == {"staves": [], "duration_ms": 0.0}


# --- nodes ----------------------------------------------------------------------

def test_load_score(score_path):
    out = com5fy.LoadScore.execute(path=str(score_path))
    (score,) = out.args
    assert isinstance(score, m5.Score)
    assert len(score.score.flatten().notes) == 13


def test_load_score_missing_file_raises(tmp_path):
    with pytest.raises(Exception):
        com5fy.LoadScore.execute(path=str(tmp_path / "nope.musicxml"))


def test_score_viewer_sends_musicxml(score_path):
    score = m5.Score.from_file(score_path)
    out = com5fy.ScoreViewer.execute(score=score)
    assert out.args == ()
    (musicxml,) = out.ui["musicxml"]
    assert musicxml.lstrip().startswith("<?xml")
    assert "<score-partwise" in musicxml


def test_score_viewer_leaves_out_placeholder_metadata(sequence):
    # A score built from a Sequence has no title/composer; music21 would stamp
    # "Music21 Fragment" / "Music21" on it unless the node suppresses that.
    score = m5.Score.from_sequence(sequence)
    (musicxml,) = com5fy.ScoreViewer.execute(score=score).ui["musicxml"]
    assert musicxml.count("<score-part ") == 3
    assert "Music21" not in musicxml


def test_sequence_viewer(sequence):
    out = com5fy.SequenceViewer.execute(sequence=sequence, pixels_per_second=200.0)
    assert out.ui["sequence_data"] == [_sequence_to_payload(sequence)]
    assert out.ui["pixels_per_second"] == [200.0]


def test_sequence_to_audio_mixes_event_audio():
    sr = 1000
    seq = m5.Sequence()
    seq.add(100, m5.Event(duration=200, audio=[m5.Audio(np.full((1, 200), 0.25, np.float32), sr)]))
    seq.add(0, m5.Event(duration=500))
    (audio,) = com5fy.SequenceToAudio.execute(sequence=seq, normalize=True).args
    assert audio["sample_rate"] == sr
    assert audio["waveform"].shape == (1, 1, 500)
    assert audio["waveform"].dtype == torch.float32
    assert torch.all(audio["waveform"][0, 0, 120:280] == 0.25)
    assert not audio["waveform"][0, 0, :100].any()


def test_audio_playback_passes_audio_through_and_writes_preview(comfy_audio, monkeypatch, tmp_path):
    monkeypatch.setattr(folder_paths, "get_temp_directory", lambda: str(tmp_path))
    out = com5fy.AudioPlayback.execute(audio=comfy_audio)
    assert out.args == (comfy_audio,)
    (preview,) = out.ui["playback_audio"]
    assert preview["type"] == "temp" and preview["subfolder"] == ""
    written = m5.Audio.read(tmp_path / preview["filename"])
    assert written.sample_rate == 8000
    assert written.waveform.shape == (2, 4000)


def test_audio_playback_clips_preview(monkeypatch, tmp_path):
    monkeypatch.setattr(folder_paths, "get_temp_directory", lambda: str(tmp_path))
    loud = {"waveform": torch.full((1, 1, 100), 2.0), "sample_rate": 8000}
    out = com5fy.AudioPlayback.execute(audio=loud)
    written = m5.Audio.read(Path(tmp_path) / out.ui["playback_audio"][0]["filename"])
    assert np.abs(written.waveform).max() <= 1.0
    # The pass-through output is untouched.
    assert out.args[0]["waveform"].max() == 2.0


# --- Orchidea (binary mocked; the real run is in M1.4's workflow test) -----------

class _FakeOrchestrate:
    """Stands in for m5.orchestrate and records what it was called with."""

    def __init__(self, sequence, audio):
        self.result = m5.Orchestration(sequence=sequence, audio=audio)
        self.calls = []

    def __call__(self, audio, parameters):
        self.calls.append((audio, parameters))
        return self.result


def _orchidea_kwargs(audio, **overrides):
    kwargs = dict(
        audio=audio, db_files="", sound_paths="", orchestra="", sparsity=0.01,
        partials_filtering=False, partials_filtering_threshold_db=-12.0, onsets_threshold=0.6,
    )
    kwargs.update(overrides)
    return kwargs


def test_orchidea_outputs_score_audio_and_sequence(comfy_audio, sequence, monkeypatch):
    rendered = m5.Audio(np.zeros((1, 100), np.float32), 8000)
    fake = _FakeOrchestrate(sequence, rendered)
    monkeypatch.setattr(m5, "orchestrate", fake)

    score, audio, seq = com5fy.OrchideaNode.execute(**_orchidea_kwargs(comfy_audio)).args
    assert isinstance(score, m5.Score)
    assert seq is sequence
    assert audio["waveform"].shape == (1, 1, 100)
    (target, _), = fake.calls
    assert target.waveform.shape == (2, 4000)


def test_orchidea_blank_strings_keep_config_values(comfy_audio, sequence, monkeypatch):
    fake = _FakeOrchestrate(sequence, m5.Audio(np.zeros((1, 10), np.float32), 8000))
    monkeypatch.setattr(m5, "orchestrate", fake)
    com5fy.OrchideaNode.execute(**_orchidea_kwargs(comfy_audio, db_files="  ", orchestra="\n"))
    (_, params), = fake.calls
    assert params == {
        "sparsity": 0.01, "partials_filtering": False,
        "partials_filtering_threshold_db": -12.0, "onsets_threshold": 0.6,
    }


def test_orchidea_strings_are_cleaned_and_passed(comfy_audio, sequence, monkeypatch):
    fake = _FakeOrchestrate(sequence, m5.Audio(np.zeros((1, 10), np.float32), 8000))
    monkeypatch.setattr(m5, "orchestrate", fake)
    com5fy.OrchideaNode.execute(**_orchidea_kwargs(
        comfy_audio, db_files=" /db/x.spectrum.db ", sound_paths="/db/x\n", orchestra="Fl  Ob\nVn|Va",
    ))
    (_, params), = fake.calls
    assert params["db_files"] == "/db/x.spectrum.db"
    assert params["sound_paths"] == "/db/x"
    assert params["orchestra"] == "Fl Ob Vn|Va"


def test_orchidea_without_audio_realization_raises(comfy_audio, sequence, monkeypatch):
    monkeypatch.setattr(m5, "orchestrate", _FakeOrchestrate(sequence, None))
    with pytest.raises(RuntimeError, match="no audio realization"):
        com5fy.OrchideaNode.execute(**_orchidea_kwargs(comfy_audio))
