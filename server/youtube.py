"""YouTube Music source: search with ytmusicapi, audio links with yt-dlp.

YouTube's audio links only work from the IP address that asked for them, so the server passes the
audio through to the phone (see app.py). Run this source on a machine at home: YouTube quickly
blocks cloud servers ("Sign in to confirm you're not a bot").

Keep yt-dlp up to date (`pip install -U "yt-dlp[default]"`): YouTube changes often and old copies stop working.
"""

from __future__ import annotations

import threading
import time
from urllib.parse import parse_qs, urlparse

from ytmusicapi import YTMusic
import yt_dlp

_yt = YTMusic()
_lock = threading.Lock()


class YouTubeError(Exception):
    pass


def _best_thumb(thumbs: list[dict] | None) -> str | None:
    if not thumbs:
        return None
    url = max(thumbs, key=lambda t: t.get("width", 0)).get("url")
    # Google image links end in "=w120-h120-..."; ask for a big square version.
    if url and "googleusercontent.com" in url and "=w" in url:
        url = url.split("=w")[0] + "=w544-h544-l90-rj"
    return url


def _artists(item: dict) -> str:
    return ", ".join(a.get("name", "") for a in item.get("artists") or [] if a.get("name"))


def _normalize(item: dict) -> dict | None:
    vid = item.get("videoId")
    if not vid:
        return None
    return {
        "source": "yt",
        "id": vid,
        "title": item.get("title") or "",
        "artist": _artists(item),
        "album": (item.get("album") or {}).get("name") or "",
        "duration": item.get("duration_seconds") or 0,
        "artwork": _best_thumb(item.get("thumbnails") or item.get("thumbnail")),
        "url": f"https://music.youtube.com/watch?v={vid}",
        # YouTube Music labels videos: OMV = the official music video, UGC = anyone's upload (lyric videos, covers...)
        "videoType": (item.get("videoType") or "").replace("MUSIC_VIDEO_TYPE_", ""),
    }


def search(q: str, kind: str = "songs", limit: int = 30) -> list[dict]:
    kind = kind if kind in ("songs", "videos") else "songs"
    with _lock:
        results = _yt.search(q, filter=kind, limit=limit)
    return [n for n in (_normalize(r) for r in results) if n]


def suggestions(q: str) -> list[str]:
    with _lock:
        return _yt.get_search_suggestions(q)


def radio(video_id: str, limit: int = 25) -> list[dict]:
    """Songs that fit after this one (YouTube Music's radio), used for autoplay."""
    with _lock:
        wp = _yt.get_watch_playlist(videoId=video_id, radio=True, limit=limit)
    out = []
    for t in wp.get("tracks", []):
        t = dict(t)
        t.setdefault("thumbnails", t.get("thumbnail"))
        if isinstance(t.get("length"), str) and not t.get("duration_seconds"):
            parts = [int(p) for p in t["length"].split(":") if p.isdigit()]
            secs = 0
            for p in parts:
                secs = secs * 60 + p
            t["duration_seconds"] = secs
        n = _normalize(t)
        if n and n["id"] != video_id:
            out.append(n)
    return out


# ------------------------------------------------------------------ audio links

# AAC in an MP4 container plays on every iPhone; prefer it over Opus/WebM.
# [vcodec=none] on every choice: only audio-only files are ever picked, never one that carries video
_FORMAT = "bestaudio[ext=m4a][vcodec=none]/bestaudio[acodec^=mp4a][vcodec=none]/140/bestaudio[vcodec=none]"
_YDL_OPTS = {"quiet": True, "no_warnings": True, "noplaylist": True, "format": _FORMAT, "skip_download": True}

_cache: dict[str, dict] = {}
_cache_lock = threading.Lock()


def _expiry(url: str) -> float:
    try:
        return float(parse_qs(urlparse(url).query)["expire"][0])
    except Exception:
        return time.time() + 3600


def audio(video_id: str) -> dict:
    """{"url", "headers", "size", "mime"} for this song's audio, cached until the link expires."""
    with _cache_lock:
        hit = _cache.get(video_id)
        if hit and hit["expires"] - time.time() > 300:
            return hit
    try:
        with yt_dlp.YoutubeDL(_YDL_OPTS) as ydl:
            info = ydl.extract_info(f"https://music.youtube.com/watch?v={video_id}", download=False)
    except Exception as e:
        raise YouTubeError(str(e).splitlines()[0][:300])
    fmt = info.get("requested_formats", [info])[0] if info.get("requested_formats") else info
    url = fmt.get("url")
    if not url:
        raise YouTubeError("YouTube didn't give an audio link")
    ext = fmt.get("ext") or "m4a"
    res = {
        "url": url,
        "headers": fmt.get("http_headers") or {},
        # only the exact size: a guessed size would cut downloads short (the stream endpoint asks YouTube when it is missing)
        "size": fmt.get("filesize"),
        "mime": "audio/mp4" if ext in ("m4a", "mp4") else ("audio/webm" if ext == "webm" else "audio/mpeg"),
        "has_video": fmt.get("vcodec") not in (None, "none"),
        "expires": _expiry(url),
    }
    with _cache_lock:
        _cache[video_id] = res
    return res


def forget(video_id: str) -> None:
    with _cache_lock:
        _cache.pop(video_id, None)


# ------------------------------------------------------------------ music videos
# A YouTube Music "song" is the audio track. The app plays the matching official video in YouTube's own
# embedded player (YouTube no longer offers a single file with picture and sound, so the server can't
# pass a video through the way it does audio).
_counterparts: dict[str, str] = {}


def music_video_id(video_id: str) -> str:
    """The id of the official video that goes with this song, or the same id when there isn't one."""
    with _cache_lock:
        if video_id in _counterparts:
            return _counterparts[video_id]
    found = video_id
    try:
        with _lock:
            wp = _yt.get_watch_playlist(videoId=video_id, limit=1)
        track = (wp.get("tracks") or [{}])[0]
        found = ((track.get("counterpart") or {}).get("videoId")) or video_id
    except Exception:
        pass
    with _cache_lock:
        _counterparts[video_id] = found
    return found
