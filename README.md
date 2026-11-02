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

To run audio to score with Orchidea, you will need to download a dataset from https://www.orch-idea.org/datasets/. It is recommended to start with the TinySOL database. The Orchidea orchestrate executable is bundled in the m5 package.
