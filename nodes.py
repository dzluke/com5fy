import contextlib
import os
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image
from typing_extensions import override

from comfy_api.latest import ComfyExtension, io

import m5
import music21

# Any .js file in this directory is loaded by the ComfyUI frontend as an extension.
WEB_DIRECTORY = "./js"


@contextlib.contextmanager
def _no_placeholder_metadata():
    """Suppress music21's placeholder title/composer while exporting a score.

    music21's MusicXML exporter falls back to global defaults
    (``defaults.title`` = "Music21 Fragment", ``defaults.author`` = "Music21")
    whenever a score carries no real title/composer, so a score that simply
    lacks metadata comes out stamped with those placeholders. Blanking the two
    defaults for the duration of an export makes the exporter emit no
    movement-title/creator at all in that case, while any *real* metadata the
    score does hold is still written through untouched (the exporter only
    reaches for the defaults when nothing real is found). Restored afterwards so
    we don't mutate music21's global state for anything else."""
    saved_title = music21.defaults.title
    saved_author = music21.defaults.author
    music21.defaults.title = ""
    music21.defaults.author = ""
    try:
        yield
    finally:
        music21.defaults.title = saved_title
        music21.defaults.author = saved_author


@io.comfytype(io_type="M5_SCORE")
class m5Score(io.ComfyTypeIO):
    """An m5.Score (a music21-backed Score) passed between m5 nodes. Produced by
    Orchidea and LoadScore; consumed by ScoreViewer."""
    Type = Any


def _to_m5_audio(audio: io.Audio.Type) -> m5.Audio:
    """Convert a ComfyUI AUDIO dict to an m5.Audio, coercing the waveform to a
    numpy array and transposing from Comfy's (batch, channels, frames) layout to
    m5's (channels, frames) layout."""
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
    # Remove batch axis and transpose to (frames, channels).
    waveform_np = waveform[0].numpy(force=True) # type: np.ndarray
    return m5.Audio(waveform=waveform_np, sample_rate=sample_rate)


def _render_score_to_image(m21_score: music21.stream.Score) -> torch.Tensor:
    """Render a music21 Score to a ComfyUI IMAGE tensor.

    music21 hands the score to its configured backend (MuseScore), which writes one
    PNG per page (``score-1.png``, ``score-2.png``, ...). Those PNGs are RGBA with
    the notation carried in the alpha channel over a transparent, black-RGB
    background, so each page is composited onto white before being turned into the
    ``[batch, height, width, channel]`` float tensor (RGB, 0-1) that ComfyUI uses
    for IMAGE. Multi-page scores are padded to a common size (with white) and
    returned as a single image batch, which a Preview Image node shows page by page.
    """
    with tempfile.TemporaryDirectory() as tmp:
        fp = os.path.join(tmp, "score.png")
        # write() returns the path MuseScore actually produced (page 1); we glob
        # the directory instead so every page is picked up. Suppress music21's
        # placeholder title/composer so an untitled score isn't engraved with
        # "Music21 Fragment" / "Music21".
        with _no_placeholder_metadata():
            m21_score.write("musicxml.png", fp=fp)

        stem = Path(fp).stem
        pages = sorted(
            Path(tmp).glob(f"{stem}-*.png"),
            key=lambda p: int(p.stem.rsplit("-", 1)[-1]),
        )
        if not pages:
            raise RuntimeError(
                f"music21/MuseScore produced no PNG for the score in {tmp!r}. "
                "Check that a MuseScore backend is installed and configured "
                "(music21.environment musicxmlPath / musescoreDirectPNGPath)."
            )

        images: list[np.ndarray] = []
        for page in pages:
            img = Image.open(page)
            if "A" in img.getbands():
                background = Image.new("RGB", img.size, (255, 255, 255))
                background.paste(img, mask=img.getchannel("A"))
                img = background
            else:
                img = img.convert("RGB")
            images.append(np.asarray(img, dtype=np.float32) / 255.0)

        height = max(im.shape[0] for im in images)
        width = max(im.shape[1] for im in images)
        # White canvas so shorter pages are padded with blank paper, not black.
        batch = np.ones((len(images), height, width, 3), dtype=np.float32)
        for i, im in enumerate(images):
            batch[i, : im.shape[0], : im.shape[1], :] = im

        return torch.from_numpy(batch)


class OrchideaNode(io.ComfyNode):
    """
    Orchestrate an input audio signal into an M5 score using m5.orchestrate.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_Orchidea",
            display_name="Orchidea",
            category="audio",
            inputs=[
                io.MultiType.Input("audio", types=[io.Audio, m5Score]),
                io.String.Input(
                    "db_files",
                    default="",
                    tooltip=(
                        "Path to the Orchidea spectrum database file "
                        "(e.g. /Datasets/TinySOL/TinySOL.spectrum.db)."
                    ),
                ),
                io.String.Input(
                    "sound_paths",
                    default="",
                    tooltip=(
                        "Path to the folder containing the Orchidea sound samples "
                        "(e.g. /Datasets/TinySOL/TinySOL)."
                    ),
                ),
                io.String.Input(
                    "orchestra",
                    default=(
                        "Fl Fl Ob Ob ClBb ClBb Bn Bn Hn Hn TpC TpC "
                        "Tbn Tbn BTb Vn Vn Va Va Vc Vc Cb Cb"
                    ),
                    multiline=True,
                    tooltip=(
                        "Space-separated instrument abbreviations that make up the "
                        "orchestra (names depend on the sound database). Use '|' "
                        "between instruments to mark a doubling played by one player, "
                        "e.g. 'Fl|Picc'. Default is the full TinySOL orchestra."
                    ),
                ),
                io.Float.Input(
                    "onsets_threshold",
                    default=0.6,
                    min=0.0,
                    max=1.0,
                    step=0.01,
                    tooltip=(
                        "Sensitivity of onset detection for dynamic (temporal) "
                        "orchestration. 0 segments at any minimal spectral variation; "
                        "raise it to reduce sensitivity. Above 1 there are no onsets "
                        "and the target is treated as static."
                    ),
                ),
                io.Float.Input(
                    "sparsity",
                    default=0.001,
                    min=0.0,
                    max=1.0,
                    step=0.001,
                    tooltip=(
                        "How freely the algorithm may drop instruments from a "
                        "solution. 0 forces every instrument to be used; higher "
                        "values raise the chance of dropping instruments. Suggested: "
                        "0.01 for general targets, 0.001 for symphonic targets, 0.1 "
                        "for single notes."
                    ),
                ),
                io.Boolean.Input(
                    "partials_filtering",
                    default=False,
                    label_on="on",
                    label_off="off",
                    tooltip=(
                        "Whether to filter the sound database by the target's "
                        "partials. Off uses all sounds (best for inharmonic/noisy "
                        "targets where timbre matters more than pitch). On keeps only "
                        "sounds matching the target's partials (best when pitch "
                        "matters); strictness is set by partials_filtering_threshold_db."
                    ),
                ),
                io.Float.Input(
                    "partials_filtering_threshold_db",
                    default=-12.0,
                    min=-60.0,
                    max=0.0,
                    step=1.0,
                    tooltip=(
                        "Only used when partials_filtering is on. Threshold in dB "
                        "between the loudest and softest partial kept in the search: "
                        "lower (more negative) retains more partials, higher keeps "
                        "only the strongest. Useful range is roughly -24 to -12."
                    ),
                ),
            ],
            outputs=[
                m5Score.Output("score"),
                io.Image.Output("score_image"),
                io.Audio.Output(
                    "audio",
                    display_name="audio",
                    tooltip=(
                        "Audio realization of the orchestration (Orchidea's "
                        "connection.wav): the chosen instrument samples rendered "
                        "and mixed down. Empty for targets that produce no "
                        "realization."
                    ),
                ),
            ],
        )

    @classmethod
    def execute(
        cls,
        audio: io.Audio.Type,
        db_files: str,
        sound_paths: str,
        orchestra: str,
        sparsity: float,
        partials_filtering: bool,
        partials_filtering_threshold_db: float,
        onsets_threshold: float,
    ) -> io.NodeOutput:
        m5_audio = _to_m5_audio(audio)

        # These override the matching keys in the Orchidea config file.
        parameters = {
            "sparsity": sparsity,
            "partials_filtering": partials_filtering,
            "partials_filtering_threshold_db": partials_filtering_threshold_db,
            "onsets_threshold": onsets_threshold,
        }
        # The string widgets override their config keys only when non-blank: a
        # blank widget must fall back to the value baked into the Orchidea
        # config, NOT overwrite it with an empty value (the binary rejects an
        # empty db_files/sound_paths/orchestra line as "invalid syntax"). The
        # orchestra widget is multiline for readability, so collapse any
        # whitespace (newlines included) into the single space-separated line
        # the config expects.
        if orchestra.strip():
            parameters["orchestra"] = " ".join(orchestra.split())
        if db_files.strip():
            parameters["db_files"] = db_files.strip()
        if sound_paths.strip():
            parameters["sound_paths"] = sound_paths.strip()

        orchestration = m5.orchestrate(m5_audio, parameters=parameters)
        # orchestrate() returns the orchestration as an m5.Sequence;
        # build the music21-backed Score the viewer/image rendering needs.
        score = m5.Score.from_sequence(orchestration.sequence)
        score_image = _render_score_to_image(score.score)

        if orchestration.audio is None:
            raise RuntimeError(
                "Orchidea produced no audio realization (connection.wav). This "
                "can happen if the constraints were too strict. Try reducing the "
                "partials filtering or including more dynamics and playing styles."
            )
        waveform_out = orchestration.audio.waveform
        if waveform_out.ndim == 1:
            waveform_out = waveform_out[None,: ]  # (frames,) -> (frames, 1)
        audio_out = {
            "waveform": torch.from_numpy(
                np.ascontiguousarray(waveform_out.T)
            ).unsqueeze(0),
            "sample_rate": orchestration.audio.sample_rate,
        }
        return io.NodeOutput(score, score_image, audio_out)


class ScoreViewer(io.ComfyNode):
    """Display any m5.Score as engraved notation (via OpenSheetMusicDisplay).

    Generic by design: it knows nothing about Orchidea — it serializes whatever
    m5.Score it is given to MusicXML and hands that to the frontend widget, so a
    score from LoadScore renders exactly like one from Orchidea. All musical
    meaning (dynamics, articulations, playing styles) lives in the Score itself.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_ScoreViewer",
            display_name="Score Viewer",
            category="music",
            inputs=[m5Score.Input("score")],
            outputs=[],
            # No graph outputs, so mark it an output node: that makes ComfyUI
            # always execute it and deliver the returned `ui` to the frontend.
            is_output_node=True,
        )

    @classmethod
    def execute(cls, score) -> io.NodeOutput:
        # score is the m5.Score object carried by M5_SCORE. to_musicxml() exports
        # it headlessly (no MuseScore). The frontend reads message.musicxml[0].
        # Suppress music21's placeholder title/composer so a score without
        # metadata isn't shown titled "Music21 Fragment" / "Music21"; real
        # title/composer/subtitle in the score are preserved.
        with _no_placeholder_metadata():
            musicxml = score.to_musicxml()
        return io.NodeOutput(ui={"musicxml": [musicxml]})


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


class m5Extension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            OrchideaNode,
            ScoreViewer,
            LoadScore,
        ]


async def comfy_entrypoint() -> m5Extension:
    return m5Extension()
