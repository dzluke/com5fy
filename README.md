# com5fy

This is a library of custom ComfyUI nodes that use the m5 (mmmmm) Python library, bringing support for musical representations, transformations, and editing to ComfyUI.

## Installation

### 1. Clone ComfyUI

```bash
git clone https://github.com/Comfy-Org/ComfyUI.git
cd ComfyUI
```

### 2. Clone the mmmmm repo into ComfyUI

From inside the `ComfyUI` directory:

```bash
git clone https://github.com/dzluke/mmmmm.git
```

### 3. Add custom nodes

From inside the `ComfyUI/custom_nodes/` folder, clone the [com5fy](https://github.com/dzluke/com5fy) repository.

```bash
cd custom_nodes
git clone https://github.com/dzluke/com5fy.git
```

### 4. Set up the Python environment

This project uses [uv](https://docs.astral.sh/uv/) for environment management. If you don't have it installed:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

From the `ComfyUI` directory, create a virtual environment and install dependencies:

```bash
uv venv
uv pip install -r requirements.txt
```

Then install the `mmmmm` package as a local editable install, which will add it as a [workspace](https://docs.astral.sh/uv/concepts/projects/workspaces/):

```bash
uv pip install -e mmmmm/
```

### 5. Run ComfyUI

```bash
uv run python main.py
```

You will now be able to create custom nodes in ComfyUI that come from the com5fy package and use the m5 (mmmmm) library.

## Frontend (developers only)

The viewers' frontend (score, sequence and audio playback) is written in TypeScript + React in `ui/` and built into
`js/`, which is committed, so using com5fy needs no Node.js. To change the frontend, edit `ui/src/` and rebuild
(Node 20+):

```bash
cd ui
npm ci
npm run build   # writes js/com5fy.js and js/chunks/*.mjs
```

Then reload ComfyUI in the browser, and commit `ui/` and `js/` together.

## Orchidea setup

The Orchidea `orchestrate` executable is bundled in the m5 package (a universal macOS binary that runs natively on
Apple Silicon; on other platforms set `ORCHIDEA_EXECUTABLE` to a binary you built). It needs a sound database, which
you install by hand:

1. Download one from https://www.orch-idea.org/datasets/. Start with **TinySOL**.
2. Unzip it and move (or symlink) its folder into ComfyUI's `models/m5/orchidea_db/` (created on first start):

   ```bash
   # from the ComfyUI root
   ln -s /path/to/TinySOL models/m5/orchidea_db/TinySOL
   ```

   A database is a `<Name>.<features>.db` analysis file with the `<Name>/` samples folder next to it, so this gives
   `models/m5/orchidea_db/TinySOL/TinySOL.spectrum.db` and `.../TinySOL/TinySOL/{Brass,Strings,Winds}`.
   Other locations can be added under the key `orchidea_db` in ComfyUI's `extra_model_paths.yaml`.
3. Restart ComfyUI (or press R in the browser) and pick it in the Orchidea node's `database` dropdown.

The other Orchidea settings come from m5's `orch_config.txt` unless the node overrides them.
