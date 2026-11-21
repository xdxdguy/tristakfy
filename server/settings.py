"""Per-copy settings, read before anything else.

Each copy of Tristakfy (yours, or a friend's) can have a private `.env` file next to README.md. It's
never in git, so whatever it says stays on that PC. Lines look like `NAME=value`; see `.env.example`.
Real environment variables win over the file (except empty ones).

This module also decides where the copy keeps its data (playlists, likes, stats, chart history, cover
cache): DATA_DIR from `.env` or the environment, otherwise the `data` folder inside the app (git ignores
it). If DATA_DIR points somewhere new and the old `data` folder still has data, it is moved there once.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = ROOT / "data"


def _load_env(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = (part.strip() for part in line.split("=", 1))
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if name and not os.environ.get(name):
            os.environ[name] = value


def _data_dir() -> Path:
    raw = os.environ.get("DATA_DIR", "").strip()
    d = Path(os.path.expandvars(os.path.expanduser(raw))) if raw else DEFAULT_DATA
    if not d.is_absolute():
        d = ROOT / d                         # relative paths are relative to the app folder
    return d.resolve()


def _move_old_data(new: Path) -> None:
    """DATA_DIR was changed: bring the data along once, so nothing seems lost."""
    old = DEFAULT_DATA
    if new == old.resolve() or not old.is_dir() or (new / "library.json").exists():
        return
    items = list(old.iterdir())
    if not items:
        return
    moved = 0
    for item in items:
        target = new / item.name
        if target.exists():
            continue
        shutil.move(str(item), str(target))
        moved += 1
    try:
        old.rmdir()                           # only if it's empty now
    except OSError:
        pass
    if moved:
        print(f"  Moved your data from {old} to {new}", flush=True)


_load_env(ROOT / ".env")
DATA_DIR = _data_dir()
DATA_DIR.mkdir(parents=True, exist_ok=True)
_move_old_data(DATA_DIR)
os.environ["DATA_DIR"] = str(DATA_DIR)        # the other modules read it from here
