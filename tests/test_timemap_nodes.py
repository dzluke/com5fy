"""M2.2: the Score/Sequence conversion nodes carry a score's TimeMap."""

from pathlib import Path

import music21
import pytest

import m5
import custom_nodes.com5fy as com5fy

DATA = Path(__file__).resolve().parent / "data"


@pytest.fixture
def meters_path():
    """Pickup + bars 1–2 in 3/4 at ♩=72, bars 3–4 in 6/8 at ♩.=60, bar 5 in 2/4 at ♩=96
    (a copy of m5's fixture)."""
    return DATA / "meters_tempi.musicxml"


def _round_trip(path, bpm=0.0):
    score = m5.Score.from_file(path)
    (seq,) = com5fy.ScoreToSequence.execute(score=score).args
    (again,) = com5fy.SequenceToScore.execute(sequence=seq, quantization="sixteenth", bpm=bpm).args
    return score, seq, again


def test_score_to_sequence_carries_the_time_map(meters_path):
    score, seq, _ = _round_trip(meters_path)
    assert seq.time_map == score.time_map
    assert seq.time_map.ms_to_measure_beat(0) == (0, 3.0)  # pickup on beat 3 of 3/4


def test_sequence_to_score_writes_tempos_meters_and_pickup_back(meters_path):
    score, _, again = _round_trip(meters_path)
    assert again.time_map == score.time_map
    xml = again.to_musicxml()
    exported = music21.converter.parseData(xml, format="musicxml")
    measures = list(exported.parts[0].getElementsByClass("Measure"))
    assert [m.number for m in measures] == [0, 1, 2, 3, 4, 5]
    signatures = [ts.ratioString for ts in exported.recurse().getElementsByClass("TimeSignature")]
    assert signatures[:3] == ["3/4", "6/8", "2/4"]


def test_duo_keeps_its_tempo_change(duo_path):
    _, _, again = _round_trip(duo_path)
    marks = again.score.recurse().getElementsByClass("MetronomeMark")
    assert [m.number for m in marks] == [90, 120]


def test_bpm_still_forces_one_tempo(meters_path):
    _, _, again = _round_trip(meters_path, bpm=60.0)
    assert [m.number for m in again.score.recurse().getElementsByClass("MetronomeMark")] == [60]
