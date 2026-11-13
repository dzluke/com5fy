"""M2.6: the Descriptor nodes (Load Descriptor, Descriptor to Sequence, Descriptor to BPF) and
the M5_DESCRIPTOR type."""

import shutil
from pathlib import Path

import pytest

import folder_paths
import m5

from custom_nodes.com5fy.nodes.convert import DescriptorToBPF, DescriptorToSequence
from custom_nodes.com5fy.nodes.data import _sequence_to_payload
from custom_nodes.com5fy.nodes.io import LoadDescriptor
from custom_nodes.com5fy.nodes.types import m5Descriptor

MELODY = Path(__file__).resolve().parents[1] / "workflows" / "inputs" / "m5_melody.desc.json"


@pytest.fixture
def input_dir(tmp_path):
    """A temporary ComfyUI input/ folder holding the workflow's descriptor fixture and a CSV."""
    old = folder_paths.get_input_directory()
    folder_paths.set_input_directory(str(tmp_path))
    shutil.copy(MELODY, tmp_path / MELODY.name)
    (tmp_path / "centroid.csv").write_text("time_s,centroid [Hz]\n0,1000\n0.5,1500\n")
    (tmp_path / "notes.txt").write_text("not a descriptor")
    yield tmp_path
    folder_paths.set_input_directory(old)


@pytest.fixture
def melody() -> m5.Descriptor:
    return m5.Descriptor.from_file(MELODY)


def test_type_id():
    assert m5Descriptor.io_type == "M5_DESCRIPTOR"


def test_load_descriptor_lists_json_and_csv(input_dir):
    assert LoadDescriptor.define_schema().inputs[0].options == ["centroid.csv", "m5_melody.desc.json"]


def test_load_descriptor_json_and_csv(input_dir):
    d = LoadDescriptor.execute("m5_melody.desc.json").result[0]
    assert isinstance(d, m5.Descriptor) and d.names == ["f0", "loudness", "onsets", "partials"]
    c = LoadDescriptor.execute("centroid.csv").result[0]
    assert c.series["centroid"].times_ms.tolist() == [0.0, 500.0] and c.series["centroid"].unit == "Hz"


def test_load_descriptor_validation_and_fingerprint(input_dir):
    assert LoadDescriptor.validate_inputs("missing.json") != True  # noqa: E712 (a message string)
    assert LoadDescriptor.validate_inputs("centroid.csv") is True
    before = LoadDescriptor.fingerprint_inputs("centroid.csv")
    (input_dir / "centroid.csv").write_text("time_ms,centroid\n0,1\n")
    assert LoadDescriptor.fingerprint_inputs("centroid.csv") != before


def test_descriptor_to_sequence_defaults_feed_the_viewer(melody):
    seq = DescriptorToSequence.execute(melody, "onsets", "f0", "partials", 0.0).result[0]
    payload = _sequence_to_payload(seq)
    assert [s["instrument"] for s in payload["staves"]] == ["onsets", "partials"]
    onsets, partials = payload["staves"]
    assert [n["pitches"] for n in onsets["notes"]] == [["A3"], ["C4"], ["E4"], ["G4"]]
    assert onsets["notes"][-1]["detuning_cents"] == [-29.0]
    assert len(partials["notes"]) == 12
    assert payload["duration_ms"] == 3000.0


def test_descriptor_to_sequence_blank_names_are_skipped(melody):
    seq = DescriptorToSequence.execute(melody, "onsets", "  ", "", 0.0).result[0]
    [(_, part)] = seq.events
    assert all(e.pitch == [] for _, e in part.events)
    with pytest.raises(KeyError, match="brightness"):
        DescriptorToSequence.execute(melody, "brightness", "", "", 0.0)


def test_descriptor_to_bpf(melody):
    bpf = DescriptorToBPF.execute(melody, " loudness ", "step").result[0]
    assert isinstance(bpf, m5.BPF)
    assert (bpf.name, bpf.unit, bpf.range, bpf.interpolation) == ("loudness", "dB", (-60.0, 0.0), "step")
