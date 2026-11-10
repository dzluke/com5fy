"""Nodes that read (and later write) files."""

import hashlib
import os

import folder_paths
from comfy_api.latest import io

import m5

from .types import m5BPF, m5Score

BPF_EXTENSIONS = (".json", ".csv")
FROM_FILE = "from file"


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



def _bpf_files() -> list[str]:
    """BPF files (``.json`` / ``.csv``) in ComfyUI's ``input/`` folder, for the dropdown."""
    input_dir = folder_paths.get_input_directory()
    os.makedirs(input_dir, exist_ok=True)
    return sorted(f for f in os.listdir(input_dir) if f.lower().endswith(BPF_EXTENSIONS))


class LoadBPF(io.ComfyNode):
    """Load a break-point function (automation curve) from a JSON or CSV file in ComfyUI's
    ``input/`` folder (formats: ``m5.BPF.from_json`` / ``from_csv``)."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_LoadBPF",
            display_name="Load BPF",
            category="m5/io",
            inputs=[
                io.Combo.Input(
                    "file",
                    options=_bpf_files(),
                    tooltip=(
                        "A .json or .csv file in ComfyUI's input/ folder (press R to refresh the list). "
                        'JSON: {"points": [[time_ms, value], ...], "interpolation", "range", "name", "unit"} '
                        "or just the list of pairs. CSV: time_ms,value rows, optional header."
                    ),
                ),
                io.Combo.Input(
                    "interpolation",
                    options=[FROM_FILE, *m5.INTERPOLATIONS],
                    default=FROM_FILE,
                    tooltip=(
                        "How values move between points: step (hold), linear, or exp (geometric, for "
                        "frequencies/amplitudes). 'from file' uses the JSON's setting (linear for CSV)."
                    ),
                ),
            ],
            outputs=[m5BPF.Output("bpf")],
        )

    @classmethod
    def execute(cls, file: str, interpolation: str = FROM_FILE) -> io.NodeOutput:
        overrides = {} if interpolation == FROM_FILE else {"interpolation": interpolation}
        return io.NodeOutput(m5.BPF.from_file(folder_paths.get_annotated_filepath(file), **overrides))

    @classmethod
    def fingerprint_inputs(cls, file: str, interpolation: str = FROM_FILE) -> str:
        # Re-run when the file's contents change, not only when another file is picked.
        with open(folder_paths.get_annotated_filepath(file), "rb") as f:
            return hashlib.sha256(f.read()).hexdigest() + interpolation

    @classmethod
    def validate_inputs(cls, file: str, interpolation: str = FROM_FILE) -> bool | str:
        if not folder_paths.exists_annotated_filepath(file):
            return f"BPF file not found in input/: {file}"
        return True
