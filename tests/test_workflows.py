"""Run the API-format workflows in ``workflows/api/`` through a real ComfyUI server.

Marked ``slow`` (starting ComfyUI takes a few seconds): ``-m slow`` runs the workflows
with no external needs, ``-m ""`` runs all of them, including those marked ``external``.
"""

import pytest

from custom_nodes.com5fy.workflows import run as runner

pytestmark = pytest.mark.slow


@pytest.fixture(scope="module")
def server():
    runner.copy_inputs()
    with runner.comfy_server() as base:
        yield base


def _params():
    return [
        pytest.param(w, id=w.name, marks=[getattr(pytest.mark, m) for m in w.markers])
        for w in runner.find_workflows(include_all=True)
    ]


@pytest.mark.parametrize("workflow", _params())
def test_workflow_runs(server, workflow):
    result = runner.run_workflow(server, workflow)
    assert result.ok, result.message
    assert result.outputs, "no node sent a ui payload"


def test_validation_error_is_reported(server):
    bad = runner.Workflow("bad", {"1": {"class_type": "m5_ScoreViewer", "inputs": {}}})
    result = runner.run_workflow(server, bad)
    assert not result.ok
    assert "rejected by /prompt" in result.message


def test_execution_error_is_reported(server):
    bad = runner.Workflow("bad", {
        "1": {"class_type": "m5_LoadScore", "inputs": {"path": "does/not/exist.musicxml"}},
        "2": {"class_type": "m5_ScoreViewer", "inputs": {"score": ["1", 0]}},
    })
    result = runner.run_workflow(server, bad)
    assert not result.ok
    assert "m5_LoadScore (node 1)" in result.message
