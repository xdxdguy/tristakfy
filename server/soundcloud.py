"""SoundCloud source: search and stream links through SoundCloud's public web API.

SoundCloud's website uses a public "client_id" that is embedded in its JavaScript. We read it the
same way the website does (and the same way yt-dlp does), and refresh it when SoundCloud rotates it.
SoundCloud Go+ tracks only give free listeners a 30-second preview, so those are left out.
"""

from __future__ import annotations

import re
import threading
import time

import httpx

API = "https://api-v2.soundcloud.com"
# A desktop browser identity: with a phone identity SoundCloud serves its mobile site, whose scripts
# live on a different host and don't carry the id the same way.
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

_client = httpx.Client(timeout=15, headers={"User-Agent": UA}, follow_redirects=True)
_lock = threading.Lock()
_client_id: str | None = None
_client_id_at = 0.0


class SoundCloudError(Exception):
    pass


def _fetch_client_id() -> str:
    page = _client.get("https://soundcloud.com/").text
    # Any script served from SoundCloud's CDN (the host has changed over time), newest bundles last.
    scripts = re.findall(r'<script[^>]+src="(https://[a-z0-9.-]*sndcdn\.com/[^"]+\.js)"', page)
    if not scripts:
        raise SoundCloudError("Couldn't read SoundCloud's page (no scripts found)")
    pattern = re.compile(r'client_id\s*[:=]\s*"([0-9a-zA-Z]{32})"|[?&]client_id=([0-9a-zA-Z]{32})')
    for src in reversed(scripts):
        try:
            js = _client.get(src).text
        except httpx.HTTPError:
            continue
        m = pattern.search(js)
        if m:
            return m.group(1) or m.group(2)
    raise SoundCloudError("Couldn't find SoundCloud's client id in its scripts")


def client_id(force: bool = False) -> str:
    global _client_id, _client_id_at
    with _lock:
        if force or not _client_id or time.time() - _client_id_at > 6 * 3600:
            _client_id = _fetch_client_id()
            _client_id_at = time.time()
        return _client_id


def _get(path_or_url: str, params: dict | None = None) -> dict:
    url = path_or_url if path_or_url.startswith("http") else API + path_or_url
    for attempt in range(2):
        p = dict(params or {})
        p["client_id"] = client_id(force=attempt > 0)
        r = _client.get(url, params=p)
        if r.status_code in (401, 403) and attempt == 0:
            continue  # client id rotated: fetch a new one and retry once
        if r.status_code >= 400:
            raise SoundCloudError(f"SoundCloud answered {r.status_code}")
        return r.json()
    raise SoundCloudError("SoundCloud refused the request")


def _artwork(t: dict) -> str | None:
    art = t.get("artwork_url") or (t.get("user") or {}).get("avatar_url")
    # "-large" is 100x100; "-t500x500" is the big version.
    return art.replace("-large.", "-t500x500.") if art else None


def _is_preview_only(t: dict) -> bool:
    if t.get("policy") == "SNIP":
        return True
    trans = (t.get("media") or {}).get("transcodings") or []
    return bool(trans) and all(x.get("snipped") for x in trans)


def normalize(t: dict) -> dict:
    user = t.get("user") or {}
    return {
        "source": "sc",
        "id": str(t["id"]),
        "title": t.get("title") or "",
        "artist": (t.get("publisher_metadata") or {}).get("artist") or user.get("username") or "",
        "album": "SoundCloud",
        "duration": round((t.get("full_duration") or t.get("duration") or 0) / 1000),
        "artwork": _artwork(t),
        "url": t.get("permalink_url"),
        "genre": (t.get("genre") or "").strip(),
    }


def search(q: str, limit: int = 30) -> list[dict]:
    data = _get("/search/tracks", {"q": q, "limit": limit, "linked_partitioning": 1})
    out = []
    for t in data.get("collection", []):
        if t.get("kind") != "track" or not t.get("streamable", True) or _is_preview_only(t):
            continue
        out.append(normalize(t))
    return out


def related(track_id: str, limit: int = 20) -> list[dict]:
    data = _get(f"/tracks/{track_id}/related", {"limit": limit})
    return [normalize(t) for t in data.get("collection", []) if not _is_preview_only(t)]


# Preference for what to hand the phone. Progressive MP3 plays everywhere; HLS plays natively on
# iPhone Safari (desktop Chrome can't play HLS, which only matters for testing on a computer).
_PREF = [
    ("progressive", "audio/mpeg"),
    ("hls", "audio/mp4"),  # AAC
    ("hls", "audio/mpeg"),
    ("hls", "audio/ogg"),  # Opus
]

_stream_cache: dict[str, tuple[float, dict]] = {}


def stream(track_id: str) -> dict:
    """Return {"url", "protocol", "mime"} for a playable stream of this track."""
    hit = _stream_cache.get(track_id)
    if hit and time.time() - hit[0] < 10 * 60:
        return hit[1]
    t = _get(f"/tracks/{track_id}")
    trans = [x for x in (t.get("media") or {}).get("transcodings") or [] if not x.get("snipped")]
    if not trans:
        raise SoundCloudError("This track can't be streamed")

    def rank(x: dict) -> int:
        key = ((x.get("format") or {}).get("protocol"), ((x.get("format") or {}).get("mime_type") or "").split(";")[0])
        return _PREF.index(key) if key in _PREF else len(_PREF)

    trans.sort(key=rank)
    params = {}
    if t.get("track_authorization"):
        params["track_authorization"] = t["track_authorization"]
    last_err = None
    for x in trans:
        try:
            res = _get(x["url"], params)
            info = {
                "url": res["url"],
                "protocol": (x.get("format") or {}).get("protocol"),
                "mime": (x.get("format") or {}).get("mime_type"),
            }
            _stream_cache[track_id] = (time.time(), info)
            return info
        except Exception as e:  # try the next format
            last_err = e
    raise SoundCloudError(f"No playable stream ({last_err})")
