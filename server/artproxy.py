"""Album covers, served by your own server.

The app asks /api/art for every cover. The server downloads it once (retrying if the music service's
image host hiccups), shrinks it to the size the screen actually needs, saves it on disk and sends it
back with a "keep this forever" header. Result: small files, loaded from one fast place, and a cover
that has been seen once never has to be downloaded again, so covers can't half-load or go missing.
"""
from __future__ import annotations

import hashlib
import io
import os
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx

try:
    from PIL import Image, ImageOps
except Exception:  # Pillow missing: covers are still proxied and cached, just not shrunk
    Image = None
    ImageOps = None

ART_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data")) / "art"
SIZES = (128, 320, 720)
MAX_BYTES = 12 * 1024 * 1024
MAX_CACHE_BYTES = 350 * 1024 * 1024
# only the image hosts of the services this app uses (so this can't be used to fetch arbitrary addresses)
HOSTS = ("ytimg.com", "ggpht.com", "googleusercontent.com", "sndcdn.com", "dzcdn.net", "deezer.com")

_client = httpx.Client(timeout=httpx.Timeout(12, connect=6), follow_redirects=True,
                       headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"})
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_misses: dict[str, float] = {}
_writes = 0


class ArtError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def allowed(url: str) -> bool:
    try:
        u = urlparse(url)
    except Exception:
        return False
    host = (u.hostname or "").lower()
    return u.scheme in ("http", "https") and any(host == h or host.endswith("." + h) for h in HOSTS)


def _bucket(size: int) -> int:
    return min(SIZES, key=lambda s: (abs(s - size), s))


def _prune() -> None:
    try:
        files = sorted(ART_DIR.glob("*.jpg"), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        for p in files:
            if total <= MAX_CACHE_BYTES * 0.75:
                break
            total -= p.stat().st_size
            p.unlink(missing_ok=True)
    except Exception:
        pass


def _download(url: str) -> tuple[bytes, str]:
    last: Exception | None = None
    for attempt in range(3):
        try:
            r = _client.get(url)
            if r.status_code in (404, 410):
                raise ArtError(404, "No such image")
            r.raise_for_status()
            if len(r.content) > MAX_BYTES:
                raise ArtError(413, "Image too large")
            return r.content, r.headers.get("content-type", "image/jpeg").split(";")[0]
        except ArtError:
            raise
        except Exception as e:
            last = e
            time.sleep(0.4 * (attempt + 1))
    raise ArtError(502, f"Couldn't fetch the image ({last.__class__.__name__})")


def _shrink(data: bytes, size: int) -> bytes:
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (20, 14, 30))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    else:
        im = im.convert("RGB")
    im.thumbnail((size, size), Image.LANCZOS)
    out = io.BytesIO()
    # plain (not progressive) JPEG, so a cover can never appear half-drawn
    im.save(out, "JPEG", quality=84, optimize=True, progressive=False)
    return out.getvalue()


def get(url: str, size: int = 320) -> tuple[bytes, str]:
    """Returns (image bytes, content type). Raises ArtError."""
    if not allowed(url):
        raise ArtError(400, "That image host isn't allowed")
    size = _bucket(size)
    key = hashlib.sha1(f"{url}|{size}".encode()).hexdigest()[:32]
    path = ART_DIR / f"{key}.jpg"
    if path.exists():
        try:
            os.utime(path, None)
            return path.read_bytes(), "image/jpeg"
        except OSError:
            pass
    if _misses.get(key, 0) > time.time():
        raise ArtError(404, "Image unavailable")
    with _locks_guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:                                       # many screens asking for the same cover: fetch it once
        if path.exists():
            return path.read_bytes(), "image/jpeg"
        try:
            data, ctype = _download(url)
        except ArtError as e:
            _misses[key] = time.time() + (600 if e.status == 404 else 20)
            raise
        if Image is None:
            return data, ctype
        try:
            data = _shrink(data, size)
        except Exception:
            raise ArtError(415, "Not a usable image")
        try:
            ART_DIR.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
            global _writes
            _writes += 1
            if _writes % 60 == 0:
                _prune()
        except OSError:
            pass
        return data, "image/jpeg"
