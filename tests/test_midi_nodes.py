"""M2.4: the MIDI nodes (Load MIDI, Save MIDI, MIDI to Sequence, Sequence to MIDI, MIDI to BPF)
and the M5_MIDI type."""

import shutil
from pathlib import Path

import pytest

import folder_paths
import m5

from custom_nodes.com5fy.nodes.convert import MidiToBPF, MidiToSequence, SequenceToMidi
from custom_nodes.com5fy.nodes.data import _sequence_to_payload
from custom_nodes.com5fy.nodes.io import LoadMidi, SaveMidi
from custom_nodes.com5fy.nodes.types import m5Midi

DUO = Path(__file__).resolve().parents[1] / "workflows" / "inputs" / "m5_duo_cc.mid"


@pytest.fixture
def input_dir(tmp_path):
    """A temporary ComfyUI input/ folder holding the workflow's MIDI fixture."""
    old = folder_paths.get_input_directory()
    folder_paths.set_input_directory(str(tmp_path))
    shutil.copy(DUO, tmp_path / DUO.name)
    (tmp_path / "notes.txt").write_text("not MIDI")
    yield tmp_path
    folder_paths.set_input_directory(old)


@pytest.fixture
def output_dir(tmp_path):
    old = folder_paths.get_output_directory()
    out = tmp_path / "output"
    out.mkdir()
    folder_paths.set_output_directory(str(out))
    yield out
    folder_paths.set_output_directory(old)


@pytest.fixture
def midi():
    return m5.Midi.from_file(DUO)


def test_midi_type_id():
    assert m5Midi.io_type == "M5_MIDI"


def test_load_midi_lists_and_reads_input_files(input_dir):
    schema = LoadMidi.define_schema()
    assert schema.inputs[0].options == [DUO.name]  # only .mid/.midi
    out = LoadMidi.execute(DUO.name).result[0]
    assert isinstance(out, m5.Midi) and [t.name for t in out.tracks] == ["Clarinet", "Piano"]
    assert LoadMidi.validate_inputs(DUO.name) is True
    assert "not found" in LoadMidi.validate_inputs("missing.mid")
    assert LoadMidi.fingerprint_inputs(DUO.name) == LoadMidi.fingerprint_inputs(DUO.name)


def test_midi_to_sequence_shows_in_viewer(midi):
    seq = MidiToSequence.execute(midi).result[0]
    assert len(seq.events) == 2 and seq.time_map is not None
    payload = _sequence_to_payload(seq)
    assert payload  # the Sequence Viewer can draw it


def test_sequence_to_midi_and_save(midi, output_dir):
    seq = MidiToSequence.execute(midi).result[0]
    out = SequenceToMidi.execute(seq, bend_range=2.0).result[0]
    assert [len(t.notes) for t in out.tracks] == [6, 12]
    result = SaveMidi.execute(out, "m5/test")
    path = Path(result.result[0])
    assert path.parent == output_dir / "m5" and path.name == "test_00001_.mid"
    assert result.ui["text"] == ["m5/test_00001_.mid"]
    again = m5.Midi.from_file(path)
    assert [n.pitch for n in again.tracks[0].notes] == [67, 69, 71, 69, 67, 72]
    # the second save gets the next number
    assert Path(SaveMidi.execute(out, "m5/test").result[0]).name == "test_00002_.mid"


def test_midi_to_bpf_lanes(midi):
    mod = MidiToBPF.execute(midi, "CC", 1, 0, -1).result[0]
    assert mod.name == "CC1 modulation" and len(mod.points) == 9
    pedal = MidiToBPF.execute(midi, "CC", 64, 2, 1).result[0]  # channel 2 (1-based), track 1
    assert pedal.points == [(1800.0, 127.0), (3600.0, 0.0)]
    bend = MidiToBPF.execute(midi, "pitch bend", 1, 0, -1).result[0]
    assert bend.unit == "cents" and bend.points[0] == (1800.0, 50.0)
    with pytest.raises(ValueError, match="no CC7"):
        MidiToBPF.execute(midi, "CC", 7, 0, -1)
