"""Run com5fy workflows headlessly through ComfyUI's HTTP API and check they finish.

Workflows for this runner are in ComfyUI's *API* format (``workflows/api/*.json``:
``{node_id: {"class_type", "inputs"}}``), which is what ``/prompt`` takes. The UI-format
workflows in ``workflows/`` are for people (drag onto the canvas); converting those needs
the frontend, so they aren't run here. Each API workflow may carry a top-level ``"m5"``
entry, stripped before posting::

    "m5": {"description": "...", "markers": ["slow", "external"]}

``markers`` work like the pytest markers (plan §3): workflows marked ``slow`` or
``external`` are skipped unless ``--all`` is given or they are named explicitly.

Files in ``workflows/inputs/`` are copied into ComfyUI's ``input/`` folder first, so
workflows can load them with the builtin Load Audio node.

Usage (from the ComfyUI root)::

    uv run python custom_nodes/com5fy/workflows/run.py                    # start a server, run the default set
    uv run python custom_nodes/com5fy/workflows/run.py --all              # include slow/external workflows
    uv run python custom_nodes/com5fy/workflows/run.py W1_audio_to_score  # just this one (name or path)
    uv run python custom_nodes/com5fy/workflows/run.py --server http://127.0.0.1:8188  # use a running server

Exits non-zero if any workflow fails. Only uses the standard library, so it can also be
imported by the tests (``tests/test_workflows.py``).
"""

from __future__ import annotations

import argparse
import contextlib
import json
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
API_DIR = HERE / "api"
INPUTS_DIR = HERE / "inputs"
COMFY_ROOT = HERE.parents[2]
SKIP_BY_DEFAULT = {"slow", "external"}


@dataclass
class Workflow:
    name: str
    prompt: dict
    description: str = ""
    markers: list[str] = field(default_factory=list)
    # Node ids that must send a ui payload (e.g. every viewer): a run where one of
    # them shows nothing fails even though ComfyUI reports success.
    expect_outputs: list[str] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> "Workflow":
        data = json.loads(path.read_text())
        meta = data.pop("m5", {})
        return cls(
            path.stem, data, meta.get("description", ""), list(meta.get("markers", [])),
            [str(n) for n in meta.get("expect_outputs", [])],
        )


@dataclass
class Result:
    name: str
    ok: bool
    seconds: float
    message: str = ""
    outputs: dict = field(default_factory=dict)  # node id -> the node's ui payload keys


def find_workflows(names: list[str] | None = None, include_all: bool = False) -> list[Workflow]:
    """The workflows to run: the named ones (name or path), else every one in ``api/``
    except those marked slow/external (unless ``include_all``)."""
    if names:
        paths = [Path(n) if n.endswith(".json") else API_DIR / f"{n}.json" for n in names]
        return [Workflow.load(p) for p in paths]
    workflows = [Workflow.load(p) for p in sorted(API_DIR.glob("*.json"))]
    if include_all:
        return workflows
    return [w for w in workflows if not SKIP_BY_DEFAULT & set(w.markers)]


def copy_inputs() -> None:
    """Copy the repo's input fixtures into ComfyUI's input folder (Load Audio reads from there)."""
    target = COMFY_ROOT / "input"
    target.mkdir(exist_ok=True)
    for path in INPUTS_DIR.iterdir():
        if path.is_file():
            shutil.copy2(path, target / path.name)


def _request(url: str, payload: dict | None = None, timeout: float = 10.0) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b"{}")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@contextlib.contextmanager
def comfy_server(url: str | None = None, startup_timeout: float = 120.0, log_path: Path | None = None):
    """Yield the base URL of a ComfyUI server: ``url`` if given (left running), else a
    server started here on a free port with this Python and stopped afterwards. The
    started server's output goes to ``log_path`` (default: a file next to this script's
    temp dir) so a failing run can be diagnosed."""
    if url:
        _request(f"{url}/system_stats")
        yield url.rstrip("/")
        return

    port = _free_port()
    log_path = log_path or Path(COMFY_ROOT / "temp" / "m5_workflow_runner.log")
    log_path.parent.mkdir(exist_ok=True)
    with open(log_path, "w") as log:
        process = subprocess.Popen(
            [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", str(port), "--disable-auto-launch"],
            cwd=COMFY_ROOT, stdout=log, stderr=subprocess.STDOUT,
        )
        base = f"http://127.0.0.1:{port}"
        try:
            deadline = time.monotonic() + startup_timeout
            while True:
                if process.poll() is not None:
                    raise RuntimeError(f"ComfyUI exited during startup; see {log_path}")
                try:
                    _request(f"{base}/system_stats", timeout=2)
                    break
                except (urllib.error.URLError, ConnectionError, OSError):
                    if time.monotonic() > deadline:
                        raise RuntimeError(f"ComfyUI didn't start within {startup_timeout:.0f} s; see {log_path}")
                    time.sleep(0.5)
            yield base
        finally:
            process.terminate()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()


def run_workflow(base: str, workflow: Workflow, timeout: float = 600.0) -> Result:
    """Queue one workflow and wait for it to finish. Fails on a validation error (the
    server's ``node_errors``), an execution error, a missing expected output, or a timeout."""
    start = time.monotonic()

    def fail(message: str) -> Result:
        return Result(workflow.name, False, time.monotonic() - start, message)

    try:
        queued = _request(f"{base}/prompt", {"prompt": workflow.prompt, "client_id": uuid.uuid4().hex})
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors="replace")
        with contextlib.suppress(ValueError):
            body = json.dumps(json.loads(body), indent=2)
        return fail(f"rejected by /prompt (HTTP {error.code}):\n{body}")
    prompt_id = queued["prompt_id"]

    deadline = start + timeout
    while True:
        history = _request(f"{base}/history/{prompt_id}").get(prompt_id)
        if history and history.get("status", {}).get("completed") is not None:
            status = history["status"]
            if status.get("status_str") == "success":
                break
            errors = [m[1] for m in status.get("messages", []) if m[0] == "execution_error"]
            detail = "\n".join(
                f"{e.get('node_type')} (node {e.get('node_id')}): {e.get('exception_type')}: {e.get('exception_message')}"
                for e in errors
            )
            return fail(f"execution failed:\n{detail or json.dumps(status, indent=2)}")
        if time.monotonic() > deadline:
            return fail(f"timed out after {timeout:.0f} s")
        time.sleep(0.25)

    outputs = {node: sorted(ui) for node, ui in history.get("outputs", {}).items()}
    missing = [n for n in workflow.expect_outputs if not outputs.get(n)]
    if missing:
        names = ", ".join(f"{workflow.prompt.get(n, {}).get('class_type', '?')} (node {n})" for n in missing)
        return fail(f"finished, but sent no ui payload: {names}")
    return Result(workflow.name, True, time.monotonic() - start, outputs=outputs)


def run(workflows: list[Workflow], server: str | None = None, timeout: float = 600.0) -> list[Result]:
    copy_inputs()
    with comfy_server(server) as base:
        return [run_workflow(base, w, timeout) for w in workflows]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("workflows", nargs="*", help="names in workflows/api/ or paths to API-format JSON files")
    parser.add_argument("--all", action="store_true", help="include workflows marked slow/external")
    parser.add_argument("--server", help="URL of a running ComfyUI (default: start one on a free port)")
    parser.add_argument("--timeout", type=float, default=600.0, help="seconds per workflow (default 600)")
    args = parser.parse_args(argv)

    workflows = find_workflows(args.workflows, args.all)
    if not workflows:
        print("No workflows to run.")
        return 0
    results = run(workflows, args.server, args.timeout)
    for result in results:
        status = "PASS" if result.ok else "FAIL"
        print(f"{status} {result.name} ({result.seconds:.1f} s)")
        if result.message:
            print("    " + result.message.replace("\n", "\n    "))
    return 0 if all(r.ok for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
