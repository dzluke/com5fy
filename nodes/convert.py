"""Nodes that convert between representations (audio, score, sequence)."""

from comfy_api.latest import io

import m5

from .boundary import _to_comfy_audio, _to_m5_audio
from .types import m5Score, m5Sequence


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
                io.Audio.Input("audio"),
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
                m5Sequence.Output(
                    "sequence",
                    tooltip=(
                        "The raw, unquantized orchestration as an m5.Sequence "
                        "(before it is quantized into the Score). Feed it to a "
                        "Sequence Viewer to see the exact onset times as "
                        "proportional, time-based notation."
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
        # The raw orchestration.sequence is also exposed as an output so it can
        # be shown unquantized (proportional notation) by the Sequence Viewer.
        score = m5.Score.from_sequence(orchestration.sequence)

        if orchestration.audio is None:
            raise RuntimeError(
                "Orchidea produced no audio realization (connection.wav). This "
                "can happen if the constraints were too strict. Try reducing the "
                "partials filtering or including more dynamics and playing styles."
            )
        return io.NodeOutput(
            score, _to_comfy_audio(orchestration.audio), orchestration.sequence
        )

class SequenceToAudio(io.ComfyNode):
    """Render an m5.Sequence to audio.

    Every event carrying audio in its ``audio`` field (e.g. the instrument
    samples an Orchidea orchestration picked) is mixed in at its onset, playing
    for at most the event's duration: longer audio is cut to fit the event.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="m5_SequenceToAudio",
            display_name="Sequence to Audio",
            category="audio",
            inputs=[
                m5Sequence.Input("sequence"),
                io.Boolean.Input(
                    "normalize",
                    default=True,
                    label_on="on",
                    label_off="off",
                    tooltip=(
                        "Scale the mix down to full scale if summing the events "
                        "makes it clip. Off leaves the raw sum untouched."
                    ),
                ),
            ],
            outputs=[io.Audio.Output("audio")],
        )

    @classmethod
    def execute(cls, sequence, normalize: bool) -> io.NodeOutput:
        rendered = m5.render_sequence(sequence, normalize=normalize)
        return io.NodeOutput(_to_comfy_audio(rendered))

