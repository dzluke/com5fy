"""Model and data folders m5 registers with ComfyUI's ``folder_paths`` (plan §2.8).

Each lives under ``models/m5/<name>``; users can add more locations for the same
name through ComfyUI's ``extra_model_paths.yaml``.
"""

import os

import folder_paths

# Orchidea sound databases: each is an analysis file (``*.db``, e.g.
# ``TinySOL.spectrum.db``) with its samples folder of the same name next to it.
ORCHIDEA_DB = "orchidea_db"
ORCHIDEA_DB_DIR = os.path.join(folder_paths.models_dir, "m5", ORCHIDEA_DB)


def register() -> None:
    """Register m5's folders and create the default ones, so users can see where
    to put things. Safe to call more than once."""
    folder_paths.add_model_folder_path(ORCHIDEA_DB, ORCHIDEA_DB_DIR, is_default=True)
    folder_paths.folder_names_and_paths[ORCHIDEA_DB][1].add(".db")
    os.makedirs(ORCHIDEA_DB_DIR, exist_ok=True)


def orchidea_databases() -> list[str]:
    """Analysis files found under the ``orchidea_db`` folders, relative to them
    (e.g. ``TinySOL/TinySOL.spectrum.db``), spectrum databases first (the
    features Orchidea's default config is tuned for)."""
    names = folder_paths.get_filename_list(ORCHIDEA_DB)
    return sorted(names, key=lambda n: (not n.endswith(".spectrum.db"), n))


def orchidea_database_path(name: str) -> str | None:
    """Full path of a database listed by :func:`orchidea_databases`, or ``None``."""
    return folder_paths.get_full_path(ORCHIDEA_DB, name)


register()
