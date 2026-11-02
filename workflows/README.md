# Workflows

- `*.json` here: **UI-format** workflows for people — drag onto the ComfyUI canvas or open from the Workflows sidebar.
  Each new feature adds one (`<task-id>_<short-name>.json`, plan §0).
- `api/*.json`: **API-format** workflows (`{node_id: {"class_type", "inputs"}}`) that `run.py` posts to ComfyUI's
  `/prompt` and checks finish without errors. An optional top-level `"m5"` entry holds a description and markers:
  `"m5": {"description": "...", "markers": ["slow", "external"]}` (stripped before posting). Workflows marked
  `slow`/`external` are skipped by default, like the pytest markers.
- `inputs/`: files copied into ComfyUI's `input/` before running, so workflows can load them with Load Audio
  (prefix names with `m5_`). Score files are loaded by path, relative to the ComfyUI root
  (e.g. `custom_nodes/com5fy/tests/data/four_bars.musicxml`).

To get an API-format file from the UI: build the graph, then *Workflow → Export (API)*.

```bash
# from the ComfyUI root
uv run python custom_nodes/com5fy/workflows/run.py                  # start a server on a free port, run the default set
uv run python custom_nodes/com5fy/workflows/run.py --all            # include slow/external (W1 needs Orchidea + TinySOL)
uv run python custom_nodes/com5fy/workflows/run.py W1_audio_to_score --server http://127.0.0.1:8188
uv run --with pytest pytest custom_nodes/com5fy/tests -m ""         # same, through pytest (tests/test_workflows.py)
```

A server started by the runner logs to `temp/m5_workflow_runner.log` in the ComfyUI root.
