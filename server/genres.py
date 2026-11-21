"""Works out a song's genre using Deezer's public search (no account or key needed).

Genres are looked up per artist and cached in data/genres.json, so a given artist is only asked
about once. Used for the Stats and Discover screens.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

import httpx

_FILE = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data")) / "genres.json"
_lock = threading.Lock()
_cache: dict[str, dict] | None = None
_RETRY_MISSES_AFTER = 7 * 86400


def _load() -> dict:
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(_FILE.read_text(encoding="utf-8"))
        except Exception:
            _cache = {}
    return _cache


def _save() -> None:
    try:
        _FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_cache or {}), encoding="utf-8")
        tmp.replace(_FILE)
    except Exception:
        pass


def _first_artist(name: str) -> str:
    name = re.sub(r"\s*-\s*topic$", "", name or "", flags=re.I)
    return re.split(r"\s*(?:,|&|;|/|\bfeat\.?|\bft\.?|\bx\b|\band\b)\s*", name, maxsplit=1, flags=re.I)[0].strip()


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _album_genre(c: httpx.Client, album_id: int) -> str | None:
    r = c.get(f"https://api.deezer.com/album/{album_id}")
    r.raise_for_status()
    data = r.json()
    genres = ((data.get("genres") or {}).get("data")) or []
    return genres[0].get("name") if genres else None


def _ask(c: httpx.Client, query: str, artist_norm: str) -> str | None:
    r = c.get("https://api.deezer.com/search", params={"q": query, "limit": 6})
    r.raise_for_status()
    for item in (r.json().get("data") or []):
        # only trust results by the same artist
        if _norm((item.get("artist") or {}).get("name", "")) != artist_norm:
            continue
        album_id = (item.get("album") or {}).get("id")
        if album_id:
            g = _album_genre(c, album_id)
            if g:
                return g
    return None


def lookup(artist: str, title: str = "") -> str | None:
    a = _first_artist(artist)
    if not a:
        return None
    key = _norm(a)
    with _lock:
        hit = _load().get(key)
    if hit and (hit.get("g") or time.time() - hit.get("at", 0) < _RETRY_MISSES_AFTER):
        return hit.get("g")
    genre = None
    with httpx.Client(timeout=8, headers={"User-Agent": "Tristakfy/1.0"}) as c:
        if title:
            genre = _ask(c, f"{a} {title}", key)
        if not genre:
            genre = _ask(c, a, key)
    with _lock:
        _load()[key] = {"g": genre, "at": time.time()}
        _save()
    return genre
