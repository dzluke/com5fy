"""Nodes that read (and later write) files."""

import hashlib
import os

import folder_paths
from comfy_api.latest import io

import m5

from .types import m5BPF, m5Descriptor, m5Midi, m5Score

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


DESCRIPTOR_EXTENSIONS = (".json", ".csv")


def _descriptor_files() -> list[str]:
    """Descriptor files (``.json`` / ``.csv``) in ComfyUI's ``input/`` folder, for the dropdown."""
    input_dir = folder_paths.get_input_directory()
    os.makedirs(input_dir, exist_ok=True)
    return sorted(f for f in os.listdir(input_dir) if f.lower().endswith(DESCRIPTOR_EXTENSIONS))


class LoadDescriptor(io.ComfyNode):
    """Load a Descriptor (analysis tracks: f0, loudness, onsets, partials…) from a JSON or CSV
    file in ComfyUI's ``input/`` folder (formats: ``m5.Descriptor.from_json`` / ``from_csv``)."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_LoadDescriptor",
            display_name="Load Descriptor",
            category="m5/io",
            inputs=[
                io.Combo.Input(
                    "file",
                    options=_descriptor_files(),
                    tooltip=(
                        "A .json or .csv file in ComfyUI's input/ folder (press R to refresh the "
                        'list). JSON: {"series": {name: {"unit", "range", "times_ms", "values"}}, '
                        '"matrices": {name: {"columns", "units", "times_ms", "frames"}}, "length_ms"}. '
                        "CSV: a time column (time_ms, or time_s for seconds), then one column per "
                        "series with optional [unit] in the header; if times repeat, the file is "
                        "one frame matrix (e.g. partials) named after the file."
                    ),
                ),
            ],
            outputs=[m5Descriptor.Output("descriptor")],
        )

    @classmethod
    def execute(cls, file: str) -> io.NodeOutput:
        return io.NodeOutput(m5.Descriptor.from_file(folder_paths.get_annotated_filepath(file)))

    @classmethod
    def fingerprint_inputs(cls, file: str) -> str:
        # Re-run when the file's contents change, not only when another file is picked.
        with open(folder_paths.get_annotated_filepath(file), "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()

    @classmethod
    def validate_inputs(cls, file: str) -> bool | str:
        if not folder_paths.exists_annotated_filepath(file):
            return f"Descriptor file not found in input/: {file}"
        return True


MIDI_EXTENSIONS = (".mid", ".midi")


def _midi_files() -> list[str]:
    """MIDI files in ComfyUI's ``input/`` folder, for the dropdown."""
    input_dir = folder_paths.get_input_directory()
    os.makedirs(input_dir, exist_ok=True)
    return sorted(f for f in os.listdir(input_dir) if f.lower().endswith(MIDI_EXTENSIONS))


class LoadMidi(io.ComfyNode):
    """Load a Standard MIDI File from ComfyUI's ``input/`` folder (``m5.Midi.from_file``)."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_LoadMidi",
            display_name="Load MIDI",
            category="m5/io",
            description=(
                "Reads a .mid file: its tracks (notes, controllers, pitch bends) and its tempo and "
                "time-signature map. A type-0 file is split into one track per channel."
            ),
            inputs=[
                io.Combo.Input(
                    "file",
                    options=_midi_files(),
                    tooltip="A .mid or .midi file in ComfyUI's input/ folder (press R to refresh the list).",
                ),
            ],
            outputs=[m5Midi.Output("midi")],
        )

    @classmethod
    def execute(cls, file: str) -> io.NodeOutput:
        return io.NodeOutput(m5.Midi.from_file(folder_paths.get_annotated_filepath(file)))

    @classmethod
    def fingerprint_inputs(cls, file: str) -> str:
        # Re-run when the file's contents change, not only when another file is picked.
        with open(folder_paths.get_annotated_filepath(file), "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()

    @classmethod
    def validate_inputs(cls, file: str) -> bool | str:
        if not folder_paths.exists_annotated_filepath(file):
            return f"MIDI file not found in input/: {file}"
        return True


class SaveMidi(io.ComfyNode):
    """Write an m5.Midi as a type-1 ``.mid`` file in ComfyUI's ``output/`` folder."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_SaveMidi",
            display_name="Save MIDI",
            category="m5/io",
            description=(
                "Writes a type-1 MIDI file into ComfyUI's output/ folder (numbered like Save Audio), "
                "with the tempo and time signatures in its first track. Outputs the saved path."
            ),
            inputs=[
                m5Midi.Input("midi"),
                io.String.Input(
                    "filename_prefix",
                    default="m5/midi",
                    tooltip="Name of the file, a subfolder of output/ allowed (e.g. m5/melody); a counter is added.",
                ),
            ],
            outputs=[io.String.Output("path", tooltip="Where the file was saved.")],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, midi, filename_prefix: str = "m5/midi") -> io.NodeOutput:
        folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory()
        )
        path = midi.to_file(os.path.join(folder, f"{filename}_{counter:05}_.mid"))
        name = os.path.join(subfolder, path.name)
        return io.NodeOutput(str(path), ui={"text": [name]})
