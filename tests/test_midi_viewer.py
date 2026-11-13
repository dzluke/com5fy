"""M3.4: the MIDI Viewer (piano-roll payload + synth preview) and MIDI to Audio."""

import json
from pathlib import Path

import pytest

import folder_paths
import m5

from custom_nodes.com5fy.nodes.convert import MidiToAudio
from custom_nodes.com5fy.nodes.data import MidiViewer, _midi_to_payload

DUO = Path(__file__).resolve().parents[1] / "workflows" / "inputs" / "m5_duo_cc.mid"


@pytest.fixture
def midi():
    return m5.Midi.from_file(DUO)


def test_payload_tracks_notes_and_microtone(midi):
    data = _midi_to_payload(midi)
    json.dumps(data)  # plain JSON for the frontend
    assert [t["name"] for t in data["tracks"]] == ["Clarinet", "Piano"]
    assert data["tracks"][0]["channels"] == [1] and data["tracks"][1]["channels"] == [2]
    clarinet = data["tracks"][0]["notes"]
    assert [n[2] for n in clarinet] == [67, 69, 71, 69, 67, 72]
    assert [n[5] for n in clarinet] == [0.0, 0.0, 0.0, 50.0, 0.0, 0.0]  # the quarter-tone bend
    assert clarinet[0][:5] == [0.0, pytest.approx(600, abs=2), 67, 90, 1]
    assert len(data["tracks"][1]["notes"]) == 12
    assert data["duration_ms"] == pytest.approx(midi.duration)
    assert data["tempo"] == "♩ = 100" and data["meter"] == "3/4"


def test_payload_grid_follows_tempo_and_meter_changes(midi):
    data = _midi_to_payload(midi)
    # 3/4 at 100 BPM (1800 ms bars), 75 BPM from bar 3, 4/4 from bar 4 (3200 ms bars).
    bars = [(b["measure"], round(b["ms"])) for b in data["bars"]]
    # The file ends at 8400 ms, inside bar 4, so bar 5 (9200 ms) isn't drawn.
    assert bars == [(1, 0), (2, 1800), (3, 3600), (4, 6000)]
    assert data["beats"][:2] == [pytest.approx(600), pytest.approx(1200)]
    assert data["beats"][-3:] == [pytest.approx(6800), pytest.approx(7600), pytest.approx(8400)]


def test_viewer_passes_midi_through_with_payload_and_audio(midi, monkeypatch, tmp_path):
    monkeypatch.setattr(folder_paths, "get_temp_directory", lambda: str(tmp_path))
    out = MidiViewer.execute(midi, zoom=2.0)
    assert out.result[0] is midi
    assert out.ui["zoom"] == [2.0]
    assert out.ui["midi_data"][0]["tracks"][0]["name"] == "Clarinet"
    preview = out.ui["playback_audio"][0]
    assert preview["type"] == "temp" and (tmp_path / preview["filename"]).exists()


def test_viewer_on_empty_midi_has_no_audio(monkeypatch, tmp_path):
    monkeypatch.setattr(folder_paths, "get_temp_directory", lambda: str(tmp_path))
    out = MidiViewer.execute(m5.Midi(), zoom=1.0)
    assert "playback_audio" not in out.ui
    assert out.ui["midi_data"][0]["tracks"] == []


def test_midi_to_audio(midi):
    audio = MidiToAudio.execute(midi, sample_rate=16000).result[0]
    assert audio["sample_rate"] == 16000
    assert tuple(audio["waveform"].shape[:2]) == (1, 1)
    assert audio["waveform"].shape[2] / 16000 * 1000 >= midi.duration
