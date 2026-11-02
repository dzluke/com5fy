# com5fy

ComfyUI custom nodes (and their frontend) for Musica ex Machina. They are thin wrappers around the `m5` library
(`../../mmmmm/`, separate repo): declare inputs/outputs, convert ComfyUI types ⇄ m5 types at the boundary, call m5,
return UI payloads. Core logic belongs in m5, not here.

**What to work on and how:** [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — read §0, §1, §3 and your
milestone first; tick the task and add a §9 session-log line when done. Project overview and setup: `../../CLAUDE.md`.

## Writing nodes (`nodes.py`)

- Use the `comfy_api.latest.io` schema API: subclass `io.ComfyNode`, implement `define_schema()` → `io.Schema(...)`
  and the classmethod `execute(...)` → `io.NodeOutput(...)`. Add the class to `m5Extension.get_node_list()`
  and export it from `__init__.py`.
- Node ids are `m5_<Name>` (e.g. `m5_ScoreViewer`); never rename an existing id (it breaks saved workflows).
  Plan §3 wants categories under `m5/…` (`m5/convert`, `m5/edit`, `m5/io`…); the existing nodes still use
  `audio` / `music`.
- Custom types: `@io.comfytype(io_type="M5_…")` on an `io.ComfyTypeIO` subclass (`M5_SCORE`, `M5_SEQUENCE` so far),
  carrying the m5 object as-is.
- Audio crosses node boundaries as ComfyUI's builtin `AUDIO` (`{"waveform": torch (B, C, T), "sample_rate"}`) so it
  connects to Load/Save Audio. Convert only with `_to_m5_audio` / `_to_comfy_audio` in `nodes.py` — the only places
  that touch torch.
- Display-only nodes set `is_output_node=True` and return `io.NodeOutput(ui={...})`; the JS reads `message.<key>[0]`.
- `nodes.py` becomes a package in M0.5 (`nodes/{types,boundary,convert,data,io}.py`).

## Frontend

- Now: plain JS in `js/` (`WEB_DIRECTORY = "./js"`), one `app.registerExtension` per viewer:
  `score-viewer.js` (OSMD), `sequence-viewer.js`, `audio-playback.js`. Reload the browser after JS changes;
  restart ComfyUI after Python changes.
- `js/lib/` (vendored OSMD + VexFlow) is **untracked** because `.gitignore` has a `lib/` rule, so a fresh clone has
  broken score viewers. Don't commit around it ad hoc.
- **M0.6** moves to TypeScript + React in `ui/` (Vite, npm deps), built with `npm run build` into `js/` (committed), and
  fixes the `.gitignore` rule. See plan §2.9.

## Testing

```bash
uv run python main.py --quick-test-for-ci            # from the ComfyUI root: loads all nodes, then exits
uv run --with pytest pytest custom_nodes/com5fy/tests  # from the ComfyUI root
```

Tests import the package as `custom_nodes.com5fy` (conftest puts the ComfyUI root on `sys.path`) and call each node's
`execute` directly; slow/external tests are skipped unless `-m` is given. Workflow JSONs in `workflows/` will run headlessly through
ComfyUI's `/prompt` API (M0.4). For UI changes, check the node in a running ComfyUI in the browser.

## New-feature handoff (required, plan §0)

Every user-facing feature (node, type, conversion, UI, visible behavior change) ends with:

1. a test workflow `workflows/<task-id>_<short-name>.json` (UI format, with a Note node saying what to look at, using
   only files that exist), checked to load and run;
2. a change note `docs/changes/<YYYY-MM-DD>_<task-id>.md` (what changed + commits, how to test, known limitations,
   feedback wanted), also pasted into the final message.

Internal work (tests, refactors, docs) skips this and just summarizes what changed.
