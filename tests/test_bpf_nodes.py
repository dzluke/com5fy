"""M2.5: the BPF nodes (Load BPF, BPF Resample, BPF Rescale) and the M5_BPF type."""

import shutil
from pathlib import Path

import pytest

import folder_paths
import m5

from custom_nodes.com5fy.nodes.edit import BPFRescale, BPFResample
from custom_nodes.com5fy.nodes.io import FROM_FILE, LoadBPF

SWELL = Path(__file__).resolve().parents[1] / "workflows" / "inputs" / "m5_swell.bpf.json"


@pytest.fixture
def input_dir(tmp_path):
    """A temporary ComfyUI input/ folder holding the workflow's BPF fixture and a CSV."""
    old = folder_paths.get_input_directory()
    folder_paths.set_input_directory(str(tmp_path))
    shutil.copy(SWELL, tmp_path / SWELL.name)
    (tmp_path / "ramp.csv").write_text("time_ms,gain\n0,0\n1000,1\n")
    (tmp_path / "notes.txt").write_text("not a bpf")
    yield tmp_path
    folder_paths.set_input_directory(old)


def test_load_bpf_lists_json_and_csv_from_input(input_dir):
    options = LoadBPF.define_schema().inputs[0].options
    assert options == ["m5_swell.bpf.json", "ramp.csv"]


def test_load_bpf_json_keeps_file_settings(input_dir):
    bpf = LoadBPF.execute("m5_swell.bpf.json", FROM_FILE).result[0]
    assert isinstance(bpf, m5.BPF)
    assert (bpf.name, bpf.unit, bpf.interpolation, bpf.range) == ("brightness", "Hz", "linear", (0.0, 8000.0))
    assert bpf.points[1] == (1000.0, 4000.0)


def test_load_bpf_interpolation_override_and_csv(input_dir):
    assert LoadBPF.execute("m5_swell.bpf.json", "step").result[0].interpolation == "step"
    bpf = LoadBPF.execute("ramp.csv", FROM_FILE).result[0]
    assert bpf.name == "gain" and bpf(500) == 0.5


def test_load_bpf_validation_and_fingerprint(input_dir):
    assert LoadBPF.validate_inputs("missing.json") != True  # noqa: E712 (a message string)
    assert LoadBPF.validate_inputs("ramp.csv") is True
    before = LoadBPF.fingerprint_inputs("ramp.csv", FROM_FILE)
    (input_dir / "ramp.csv").write_text("0,0\n1000,2\n")
    assert LoadBPF.fingerprint_inputs("ramp.csv", FROM_FILE) != before


def test_resample_node():
    out = BPFResample.execute(m5.BPF([(0, 0), (1000, 10)]), 250).result[0]
    assert [t for t, _ in out.points] == [0, 250, 500, 750, 1000]


def test_rescale_node_uses_declared_range():
    out = BPFRescale.execute(m5.BPF([(0, 0), (1, 64)], range=(0, 128)), 0.0, 1.0).result[0]
    assert out.values.tolist() == [0, 0.5] and out.range == (0, 1)


# --- the BPF node (curve editor) ------------------------------------------------

from custom_nodes.com5fy.nodes.create import DEFAULT_POINTS, BPFNode, _bpf_from_editor  # noqa: E402


def test_bpf_from_editor_json_sets_range_and_clips_to_box():
    bpf = _bpf_from_editor("[[0, 0.5], [5000, 2], [1000, -1]]", 4000, 0, 1, "exp", "gain", "dB")
    assert bpf.points == [(0, 0.5), (1000, 0), (4000, 1)]
    assert (bpf.interpolation, bpf.range, bpf.name, bpf.unit) == ("exp", (0, 1), "gain", "dB")


def test_bpf_from_editor_rejects_bad_input():
    with pytest.raises(ValueError, match="max"):
        _bpf_from_editor(DEFAULT_POINTS, 4000, 1, 1)
    with pytest.raises(ValueError, match="JSON"):
        _bpf_from_editor("not json", 4000, 0, 1)
    assert _bpf_from_editor("", 4000, 0, 1).points == []


def test_bpf_node_outputs_drawn_curve_and_ui_payload():
    out = BPFNode.execute(DEFAULT_POINTS, 4000.0, 0.0, 1.0, "linear")
    bpf = out.result[0]
    assert bpf.points == [(0, 0), (4000, 1)]
    payload = out.ui["bpf"][0]
    assert payload["source"] == "editor" and payload["duration"] == 4000.0 and payload["range"] == [0, 1]


def test_bpf_node_passes_input_through_for_display():
    incoming = m5.BPF([(0, 200), (500, 8000)], name="b")
    out = BPFNode.execute(DEFAULT_POINTS, 4000.0, 0.0, 1.0, "linear", input=incoming)
    assert out.result[0] is incoming
    assert out.ui["bpf"][0]["source"] == "input" and out.ui["bpf"][0]["range"] == [200, 8000]
