"""Music server: one program that can run in two places.

- At home (PC or Raspberry Pi):   ENABLE_YOUTUBE=1 ENABLE_SOUNDCLOUD=1   (full catalogue)
- In the cloud (always on):        ENABLE_YOUTUBE=0 ENABLE_SOUNDCLOUD=1   (SoundCloud only)

The phone web app talks to both: SoundCloud search goes to whichever server is set for it, YouTube
search goes to the home server, and when home is off a YouTube song falls back to SoundCloud.

Settings (environment variables):
  ENABLE_YOUTUBE     1/0  (default 1)
  ENABLE_SOUNDCLOUD  1/0  (default 1)
  ACCESS_KEY         if set, every /api call needs ?k=<key> (keep strangers off a public server)
  DEMO               1 = fake songs and test tones, for trying the app without any music service
  PORT               default 8000
  HOST               who can connect: 127.0.0.1 (default) = only this PC, which includes your phone through
                     `tailscale serve`; 0.0.0.0 = every device on the network (the cloud server uses this)
  DATA_DIR           where this copy keeps its playlists, likes, stats and caches (default: ./data)

They can also go in a private `.env` file next to README.md (see .env.example and settings.py).
"""

from __future__ import annotations

import io
import json
import math
import os
import re
import struct
import threading
import time
from pathlib import Path
from urllib.parse import urljoin

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

import settings  # noqa: F401  (first: reads .env and picks this copy's data folder)


def _flag(name: str, default: str = "1") -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


APP_NAME = os.environ.get("APP_NAME", "Tristakfy")
DEMO = _flag("DEMO", "0")
ENABLE_YT = _flag("ENABLE_YOUTUBE") and not DEMO
ENABLE_SC = _flag("ENABLE_SOUNDCLOUD") and not DEMO
ACCESS_KEY = os.environ.get("ACCESS_KEY", "").strip()
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

if ENABLE_YT:
    import youtube as yt
if ENABLE_SC:
    import soundcloud as sc

import artproxy
import discover
import genres
import mp4fix

app = FastAPI(title=APP_NAME, docs_url=None, redoc_url=None)
# The web app may be served by a different server (cloud) than the one it calls (home), so allow
# any origin. Nothing here uses cookies, and ACCESS_KEY protects the data.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "PUT"], allow_headers=["*"],
                   expose_headers=["Content-Length", "Content-Range", "Accept-Ranges"])

http = httpx.AsyncClient(timeout=httpx.Timeout(20, read=60), follow_redirects=True)


@app.middleware("http")
async def access_key(request: Request, call_next):
    path = request.url.path
    if ACCESS_KEY and path.startswith("/api/") and path != "/api/health" and request.method != "OPTIONS":
        if request.query_params.get("k") != ACCESS_KEY and request.headers.get("x-access-key") != ACCESS_KEY:
            return JSONResponse({"error": "Wrong or missing access key"}, status_code=401)
    return await call_next(request)


def _need(enabled: bool, name: str):
    if not enabled:
        raise HTTPException(503, f"{name} is turned off on this server")


def _fail(e: Exception, status: int = 502):
    raise HTTPException(status, str(e) or e.__class__.__name__)


# ------------------------------------------------------------------ library sync
# The phone and the PC each keep a copy of likes/playlists. This server keeps the shared copy in one
# JSON file; the app merges before it uploads. `rev` lets the server refuse an upload made from an
# out-of-date copy (409), so two devices can't silently overwrite each other.
LIB_FILE = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data")) / "library.json"
_lib_lock = threading.Lock()


def _lib_read() -> dict:
    try:
        return json.loads(LIB_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"rev": 0, "data": {}}


@app.get("/api/library")
def library_get():
    with _lib_lock:
        return _lib_read()


@app.put("/api/library")
async def library_put(request: Request, rev: int = Query(0)):
    try:
        data = await request.json()
        if not isinstance(data, dict) or not isinstance(data.get("playlists", []), list) or not isinstance(data.get("liked", []), list):
            raise ValueError
    except Exception:
        raise HTTPException(400, "Not a library")
    with _lib_lock:
        cur = _lib_read()
        if cur["rev"] != rev:
            return JSONResponse(cur, status_code=409)
        new = {"rev": cur["rev"] + 1, "data": data}
        LIB_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = LIB_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(new), encoding="utf-8")
        tmp.replace(LIB_FILE)
        return {"rev": new["rev"]}


# ------------------------------------------------------------------ genres
# Used by the Stats and Discover screens. Asks Deezer (cached per artist); never needs a key.


@app.get("/api/genre")
def genre_lookup(artist: str = Query("", max_length=200), title: str = Query("", max_length=200)):
    if DEMO:
        return {"genre": ["Rap/Hip Hop", "Pop", "Electro", "Rock"][sum(map(ord, artist)) % 4]}
    try:
        return {"genre": genres.lookup(artist, title)}
    except Exception:
        return {"genre": None}


# ------------------------------------------------------------------ discover (charts, artists, similar songs)


def _demo_dz(seed_text: str, n: int = 24) -> list[dict]:
    """Fake Deezer-style songs (with a playable 30 s tone as the "preview") for trying the screens."""
    out = []
    pool = demo_search(seed_text, "yt")[:n] + demo_search(seed_text + "b", "yt")[: max(0, n - 12)]
    for i, t in enumerate(pool):
        out.append({**t, "source": "dz", "id": str((sum(map(ord, seed_text)) % 9000 + 1) * 100 + i), "preview": f"/api/demo/stream/{t['id']}" + _key_suffix(),
                    "artist_id": 1, "rank": 0})
    return out


@app.get("/api/discover/chart")
def discover_chart(genre: str = Query(..., max_length=40), period: str = Query("today", pattern="^(today|week|month|year)$")):
    """Top songs in a genre: today's Deezer chart, or the week / month / year built from saved days."""
    if genre not in discover.GENRES:
        raise HTTPException(404, "Unknown genre")
    if DEMO:
        window = discover.PERIODS[period]
        tracks = _demo_dz(genre + period, 100)
        for i, t in enumerate(tracks):
            t["days"] = max(1, min(window, 12) - i % 5) if period != "today" else 0
        return {"tracks": tracks, "days": min(window, 12) if period != "today" else 1, "window": window, "first": time.time() - 11 * 86400}
    try:
        return discover.period_chart(genre, period)
    except Exception as e:
        _fail(e)


@app.get("/api/discover/trending")
def discover_trending():
    """The 15 artists doing best on Western country charts over the past week."""
    if DEMO:
        names = ["Nova Vale", "The Demo Band", "Test Tone Trio", "Sample Kid", "DJ Placeholder", "Luna Park", "Echo Hearts", "Velvet Sun", "Harbor Lights", "Kid Static", "Ruby Drive", "Golden Hour", "Midnight Oil Co", "Glass Animals Jr", "Ocean Room"]
        return {"artists": [{"id": i, "name": n, "picture": f"/api/demo/art/{(i * 41 + 15) % 360}.svg", "score": 1000 - i * 40} for i, n in enumerate(names, 1)], "days": 3, "window": 7}
    try:
        return discover.trending_artists()
    except Exception as e:
        _fail(e)


@app.get("/api/discover/preview")
def discover_preview(id: str = Query(..., pattern="^[0-9]{1,12}$")):
    if DEMO:
        return {"preview": ""}
    try:
        return {"preview": discover.fresh_preview(id)}
    except Exception as e:
        _fail(e)


@app.on_event("startup")
def _start_chart_history():
    """Save the genre charts once a day while the server runs (this is what the week/month/year views are built from)."""
    if DEMO:
        return

    def loop():
        while True:
            try:
                discover.maybe_snapshot_all()
            except Exception:
                pass
            time.sleep(3600)

    threading.Thread(target=loop, daemon=True, name="chart-history").start()


@app.get("/api/discover/genres")
def discover_genres():
    return list(discover.GENRES)


@app.get("/api/discover/artist")
def discover_artist(q: str = Query(..., min_length=1, max_length=100)):
    if DEMO:
        t = _demo_dz("top" + q, 24)
        return {"artist": {"id": 1, "name": q.title(), "picture": "/api/demo/art/210.svg", "fans": 1234567}, "top": t, "featured": _demo_dz("feat" + q, 8),
                "related": [{"id": i, "name": n, "picture": f"/api/demo/art/{i * 70}.svg", "fans": 1000 * i} for i, n in enumerate(["Test Tone Trio", "Sample Kid", "The Demo Band", "DJ Placeholder"], 1)]}
    try:
        data = discover.artist_profile(q)
    except Exception as e:
        _fail(e)
    if not data:
        raise HTTPException(404, "No artist found")
    return data


@app.get("/api/discover/related")
def discover_related(artist: str = Query(..., min_length=1, max_length=200)):
    """Artists related to this one (Deezer), for Smart mix."""
    if DEMO:
        names = ["Test Tone Trio", "Sample Kid", "The Demo Band", "DJ Placeholder", "Nova Vale"]
        i = sum(map(ord, artist)) % len(names)
        return {"related": [names[i], names[(i + 1) % len(names)]]}
    try:
        return {"related": discover.related_names(artist)}
    except Exception as e:
        _fail(e)


@app.get("/api/discover/tracks")
def discover_tracks(q: str = Query(..., min_length=1, max_length=150)):
    if DEMO:
        return _demo_dz("find" + q, 10)
    try:
        return discover.search_tracks(q)
    except Exception as e:
        _fail(e)


@app.get("/api/similar")
def similar_songs(artist: str = "", title: str = "", artist_id: int = 0, duration: int = 0):
    out: dict = {"radio": [], "artists": []}
    if DEMO:
        out["radio"] = demo_search("radio" + title, "yt")
        out["artists"] = _demo_dz("sim" + title, 15)
        return out
    try:
        out["artists"] = discover.similar(artist_id or None, artist, title)
    except Exception:
        pass
    # the best "sounds like this" list: YouTube Music's radio for the song (or SoundCloud's related tracks)
    try:
        if ENABLE_YT:
            best = best_match(yt.search(f"{artist} {title}".strip(), "songs", limit=10), title, re.split(r"\s*[;,&]\s*", artist)[0] if artist else "", duration, min_score=1.9)
            if best:
                out["radio"] = yt.radio(best["id"])[:25]
        elif ENABLE_SC:
            best = best_match(sc.search(f"{artist} {title}".strip(), limit=20), title, artist, duration)
            if best:
                out["radio"] = sc.related(best["id"])[:25]
    except Exception:
        pass
    return out


# ------------------------------------------------------------------ cover art
# Every cover goes through here: fetched once, shrunk to the size the screen needs, cached on disk.


@app.get("/api/art")
def cover_art(u: str = Query(..., max_length=2000), s: int = Query(320, ge=32, le=2000)):
    try:
        data, ctype = artproxy.get(u, s)
    except artproxy.ArtError as e:
        raise HTTPException(e.status, str(e))
    return Response(content=data, media_type=ctype, headers={"Cache-Control": "public, max-age=31536000, immutable"})


# ------------------------------------------------------------------ health


@app.get("/api/health")
def health():
    return {"name": APP_NAME, "demo": DEMO, "keyRequired": bool(ACCESS_KEY),
            "sources": {"youtube": ENABLE_YT or DEMO, "soundcloud": ENABLE_SC or DEMO}}


# ------------------------------------------------------------------ SoundCloud


@app.get("/api/sc/search")
def sc_search(q: str = Query(..., min_length=1, max_length=200)):
    if DEMO:
        return demo_search(q, "sc")
    _need(ENABLE_SC, "SoundCloud")
    try:
        return sc.search(q)
    except Exception as e:
        _fail(e)


@app.get("/api/sc/related/{track_id}")
def sc_related(track_id: str):
    if DEMO:
        return demo_search("related" + track_id, "sc")
    _need(ENABLE_SC, "SoundCloud")
    try:
        return sc.related(track_id)
    except Exception as e:
        _fail(e)


@app.get("/api/sc/stream/{track_id}")
def sc_stream(track_id: str):
    if DEMO:
        return RedirectResponse(f"/api/demo/stream/{track_id}" + _key_suffix())
    _need(ENABLE_SC, "SoundCloud")
    if not track_id.isdigit():
        raise HTTPException(400, "Bad track id")
    try:
        info = sc.stream(track_id)
    except Exception as e:
        _fail(e)
    # SoundCloud's links aren't tied to our IP, so the phone can play straight from SoundCloud.
    # (HLS plays natively on iPhone Safari.)
    return RedirectResponse(info["url"], status_code=302)


@app.get("/api/sc/file/{track_id}")
async def sc_file(track_id: str):
    """A SoundCloud song as one whole file, for saving on the phone (the normal stream just redirects, and
    SoundCloud's servers may not let the app fetch that directly, so the file comes through here)."""
    if DEMO:
        return RedirectResponse(f"/api/demo/stream/{track_id}" + _key_suffix())
    _need(ENABLE_SC, "SoundCloud")
    if not track_id.isdigit():
        raise HTTPException(400, "Bad track id")
    try:
        info = await run_in_threadpool(sc.stream, track_id)
    except Exception as e:
        _fail(e)
    url = info["url"]
    mime = (info.get("mime") or "audio/mpeg").split(";")[0]
    if info.get("protocol") != "hls" and ".m3u8" not in url:
        req = http.build_request("GET", url)
        r = await http.send(req, stream=True)
        if r.status_code >= 400:
            await r.aclose()
            raise HTTPException(502, "SoundCloud refused the download")

        async def whole():
            try:
                async for b in r.aiter_bytes(64 * 1024):
                    yield b
            finally:
                await r.aclose()

        headers = {"Cache-Control": "no-store"}
        if r.headers.get("content-length"):
            headers["Content-Length"] = r.headers["content-length"]
        return StreamingResponse(whole(), media_type=r.headers.get("content-type", mime).split(";")[0], headers=headers)

    # HLS: the song is a list of short pieces; stitch them together in order
    text = (await http.get(url)).text
    if "#EXT-X-STREAM-INF" in text:                                  # a menu of qualities: take the first
        first = next(l.strip() for l in text.splitlines() if l.strip() and not l.startswith("#"))
        url = urljoin(url, first)
        text = (await http.get(url)).text
    init = re.search(r'#EXT-X-MAP:URI="([^"]+)"', text)
    pieces = [urljoin(url, l.strip()) for l in text.splitlines() if l.strip() and not l.startswith("#")]
    if not pieces:
        raise HTTPException(502, "Couldn't read this song's pieces")

    async def stitched():
        if init:
            yield (await http.get(urljoin(url, init.group(1)))).content
        for u in pieces:
            piece = await http.get(u)
            if piece.status_code >= 400:
                return
            yield piece.content

    return StreamingResponse(stitched(), media_type=mime, headers={"Cache-Control": "no-store"})


def _words(s: str) -> set[str]:
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s.lower())
    return {w for w in re.findall(r"[a-z0-9]+", s) if len(w) > 1}


_BAD_VERSIONS = {"remix", "sped", "slowed", "nightcore", "reverb", "cover", "8d", "mashup", "bootleg", "edit",
                 "instrumental", "karaoke", "flip", "extended", "acoustic", "live"}
_VERSION_TAIL = re.compile(r"\s[-–]\s*(\d{4}\s*)?(remaster(ed)?|mono|stereo|single version|album version|radio edit|from\b|deluxe|bonus).*$", re.I)


def best_match(results: list[dict], title: str, artist: str = "", duration: int = 0, min_score: float = 1.6) -> dict | None:
    """Pick the search result that is really this song: the right words, the right artist, about the
    right length, and never a different version (remix, slowed, live...) unless that was asked for."""
    title = _VERSION_TAIL.sub("", title)           # "Song - Remastered 2011" -> "Song"
    want_t, want_a = _words(title), _words(artist)
    if not want_t:
        return None
    wanted_raw = set(re.findall(r"[a-z0-9]+", title.lower()))
    best, best_score = None, 0.0
    for r in results:
        raw = set(re.findall(r"[a-z0-9]+", r["title"].lower()))
        if (_BAD_VERSIONS - wanted_raw) & raw:      # check the FULL title: "(slowed + reverb)" is in brackets
            continue
        have = _words(r["title"]) | _words(r["artist"]) | _words(r.get("album") or "")
        score = len(want_t & have) / len(want_t) * 2 + (len(want_a & have) / len(want_a) if want_a else 0)
        if duration and r["duration"]:
            score -= min(abs(r["duration"] - duration) / 60, 1)   # penalise very different lengths
        if score > best_score:
            best, best_score = r, score
    return best if best and best_score >= min_score else None


@app.get("/api/sc/match")
def sc_match(title: str, artist: str = "", duration: int = 0):
    """Best SoundCloud copy of a song, used when the YouTube (home) server is off."""
    if DEMO:
        return demo_search(title, "sc")[0]
    _need(ENABLE_SC, "SoundCloud")
    try:
        results = sc.search(f"{artist} {title}".strip(), limit=20)
    except Exception as e:
        _fail(e)
    best = best_match(results, title, artist, duration)
    if not best:
        raise HTTPException(404, "No good SoundCloud match")
    return best


# ------------------------------------------------------------------ YouTube Music


@app.get("/api/yt/search")
def yt_search(q: str = Query(..., min_length=1, max_length=200), kind: str = "songs"):
    if DEMO:
        return demo_search(q, "yt")
    _need(ENABLE_YT, "YouTube")
    try:
        return yt.search(q, kind)
    except Exception as e:
        _fail(e)


@app.get("/api/yt/match")
def yt_match(title: str, artist: str = "", duration: int = 0):
    """Best YouTube Music copy of a song (used when importing playlists from Spotify)."""
    if DEMO:
        return demo_search(title, "yt")[0]
    _need(ENABLE_YT, "YouTube")
    try:
        results = yt.search(f"{artist} {title}".strip(), "songs", limit=10)
    except Exception as e:
        _fail(e)
    # Spotify lists several artists; YouTube's artist line may show only some, so match on the first.
    best = best_match(results, title, re.split(r"\s*[;,&]\s*", artist)[0] if artist else "", duration, min_score=1.9)
    if not best:
        raise HTTPException(404, "No good YouTube match")
    return best


@app.get("/api/yt/suggest")
def yt_suggest(q: str = Query(..., min_length=1, max_length=200)):
    if DEMO:
        return [q + s for s in (" remix", " live", " acoustic")]
    _need(ENABLE_YT, "YouTube")
    try:
        return yt.suggestions(q)
    except Exception as e:
        _fail(e)


@app.get("/api/yt/radio/{video_id}")
def yt_radio(video_id: str):
    if DEMO:
        return demo_search("radio" + video_id, "yt")
    _need(ENABLE_YT, "YouTube")
    try:
        return yt.radio(video_id)
    except Exception as e:
        _fail(e)


CHUNK = 4 * 1024 * 1024  # googlevideo throttles big single requests, so fetch in pieces
_VID = re.compile(r"^[A-Za-z0-9_-]{11}$")


@app.get("/api/yt/stream/{video_id}")
async def yt_stream(video_id: str, request: Request, dl: int = 0):
    if DEMO:
        return RedirectResponse(f"/api/demo/stream/{video_id}" + _key_suffix())
    _need(ENABLE_YT, "YouTube")
    if not _VID.match(video_id):
        raise HTTPException(400, "Bad video id")
    try:
        info = await run_in_threadpool(yt.audio, video_id)
    except Exception as e:
        _fail(e)
    if dl and (info.get("has_video") or not str(info.get("mime", "")).startswith("audio/")):
        raise HTTPException(415, "That file contains video; downloads are audio only")     # never let a video be saved on the phone
    return await _serve_yt(request, info, lambda: yt.forget(video_id))


_NOT_THE_VIDEO = {"lyric", "lyrics", "cover", "reaction", "karaoke", "instrumental", "remix", "live", "tutorial", "slowed", "sped",
                  "nightcore", "8d", "mashup", "bootleg", "parody", "review", "fanmade", "concert", "acoustic", "piano",
                  "guitar", "tribute", "stem", "stems", "choreography", "visualizer"}


def _pick_official_video(results: list[dict], title: str, artist: str, duration: int = 0) -> dict | None:
    """The song's official music video among YouTube Music's video results, or None.
    YouTube Music labels each video: OMV is the official music video, UGC is anyone's upload (lyric videos,
    covers, remixes, fan edits). Only OMV is ever picked, and it must be this song (the whole title) by this artist.
    Anything doubtful returns None, and then the app plays the song's own YouTube video."""
    want_t = _words(re.sub(r"\s[-–]\s*(\d{4}\s*)?(remaster(ed)?|mono|stereo|single version|album version|radio edit).*$", "", title, flags=re.I))
    first = re.split(r"\s*[;,&]\s*", artist)[0] if artist else ""
    artist_key = re.sub(r"[^a-z0-9]", "", first.lower())
    if not want_t or not artist_key:
        return None
    wanted_raw = set(re.findall(r"[a-z0-9]+", title.lower()))
    for r in results:                                           # YouTube Music lists the best match first
        if r.get("videoType") != "OMV":
            continue
        raw = set(re.findall(r"[a-z0-9]+", r["title"].lower()))
        if (_NOT_THE_VIDEO - wanted_raw) & raw or not want_t <= (_words(r["title"]) | raw):
            continue
        if artist_key not in re.sub(r"[^a-z0-9]", "", (r.get("artist") or "").lower()):
            continue                                            # an official video, but of someone else's song
        d = r.get("duration") or 0
        if duration and d and not (duration * 0.6 <= d <= duration * 1.8):
            continue                                            # music videos run a little long (intros), but not twice as long
        return r
    return None


_videoid_cache: dict[str, str] = {}


@app.get("/api/yt/videoid/{video_id}")
async def yt_videoid(video_id: str, title: str = "", artist: str = "", duration: int = 0):
    """The id of the official music video for a YouTube Music song: the linked one, else the best video search
    result that really is this song, else the song's own id."""
    if DEMO:
        return {"id": video_id}
    _need(ENABLE_YT, "YouTube")
    if not _VID.match(video_id):
        raise HTTPException(400, "Bad video id")
    if video_id in _videoid_cache:
        return {"id": _videoid_cache[video_id]}
    vid = await run_in_threadpool(yt.music_video_id, video_id)
    if vid == video_id and title:
        try:
            for query in (f"{artist} {title}".strip(), f"{artist} {title} official music video"):
                results = await run_in_threadpool(yt.search, query, "videos", 10)
                best = _pick_official_video(results, title, artist, duration)
                if best:
                    vid = best["id"]
                    break
        except Exception:
            pass
    _videoid_cache[video_id] = vid
    return {"id": vid}


async def _serve_yt(request: Request, info: dict, forget) -> Response:
    """Passes a YouTube file (audio or video) through to the phone with byte-range support, in pieces."""
    headers = {k: v for k, v in info["headers"].items() if k.lower() in ("user-agent", "accept-language", "origin", "referer")}
    size = info.get("size")
    if not size:
        probe = await http.get(info["url"], headers={**headers, "Range": "bytes=0-0"})
        m = re.search(r"/(\d+)$", probe.headers.get("content-range", ""))
        if probe.status_code == 403:
            forget()
            raise HTTPException(502, "YouTube refused the audio link; try again")
        size = int(m.group(1)) if m else None
    if not size:
        raise HTTPException(502, "Couldn't read the song's size")

    start, end = 0, size - 1
    rng = request.headers.get("range")
    if rng:
        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        if m:
            if m.group(1):
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
            elif m.group(2):  # "bytes=-500": the last 500 bytes
                start = max(size - int(m.group(2)), 0)
    if start > end:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})

    # iPhones show fragmented m4a songs at double length (silent second half) unless the header's length
    # fields say 0, so the header is fetched once, fixed (same size), and sent in place of the original bytes
    head = b""
    if info["mime"].startswith("audio/mp4") and start < 256 * 1024:
        head = info.get("_fixed_head")
        if head is None:
            head = b""
            try:
                r = await http.get(info["url"], headers={**headers, "Range": "bytes=0-65535"})
                data = r.content if r.status_code in (200, 206) else b""
                hend = mp4fix.header_end(data)
                if hend and hend > len(data) and hend <= 1024 * 1024:   # a long header: fetch the rest
                    r = await http.get(info["url"], headers={**headers, "Range": f"bytes=0-{hend - 1}"})
                    data = r.content if r.status_code in (200, 206) else b""
                if hend and len(data) >= hend:
                    head = mp4fix.patch_header(data[:hend])
            except Exception as e:
                print("could not fix the song header:", e)
            info["_fixed_head"] = head

    async def body():
        pos = start
        if pos < len(head):
            yield head[pos:min(end + 1, len(head))]
            pos = len(head)
        while pos <= end:
            piece_end = min(pos + CHUNK - 1, end)
            async with http.stream("GET", info["url"], headers={**headers, "Range": f"bytes={pos}-{piece_end}"}) as r:
                if r.status_code >= 400:
                    forget()  # the link went stale; the next request gets a fresh one
                    return
                async for b in r.aiter_bytes(64 * 1024):
                    yield b
            pos = piece_end + 1

    out_headers = {"Accept-Ranges": "bytes", "Content-Length": str(end - start + 1), "Cache-Control": "no-store"}
    status = 200
    if rng:
        status = 206
        out_headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(body(), status_code=status, media_type=info["mime"], headers=out_headers)


# ------------------------------------------------------------------ lyrics (LRCLIB, free, no key)


@app.get("/api/lyrics")
async def lyrics(title: str, artist: str = "", duration: int = 0):
    if DEMO:
        words = ["Neon lights are calling", "Hold the line with me", "Every echo fades away", "Into the open sea", "Drifting on the static", "Where the signal glows", "Carry me a little farther", "Wherever the wave goes"]
        return {"synced": "\n".join(f"[00:{i * 3:02d}.00] {w}" for i, w in enumerate(words)), "plain": None, "instrumental": False}
    clean = re.sub(r"\s*[\(\[].*?(official|video|audio|lyric|visualizer|remaster).*?[\)\]]", "", title, flags=re.I).strip()
    ua = {"User-Agent": f"{APP_NAME} personal music app (https://lrclib.net)"}
    try:
        params = {"track_name": clean, "artist_name": artist.split(",")[0].strip()}
        if duration:
            params["duration"] = duration
        r = await http.get("https://lrclib.net/api/get", params=params, headers=ua)
        if r.status_code == 200:
            return _lyrics_out(r.json())
        r = await http.get("https://lrclib.net/api/search", params={"q": f"{artist} {clean}".strip()}, headers=ua)
        for item in r.json() if r.status_code == 200 else []:
            if item.get("syncedLyrics") or item.get("plainLyrics"):
                if not duration or abs((item.get("duration") or duration) - duration) < 8:
                    return _lyrics_out(item)
    except Exception:
        pass
    raise HTTPException(404, "No lyrics found")


def _lyrics_out(d: dict) -> dict:
    return {"synced": d.get("syncedLyrics"), "plain": d.get("plainLyrics"), "instrumental": d.get("instrumental", False)}


# ------------------------------------------------------------------ demo mode (no music services)

_DEMO_WORDS = ["Neon", "Harbor", "Velvet", "Static", "Paper", "Golden", "Midnight", "Glass", "Ocean", "Ember"]
_DEMO_NOUNS = ["Lights", "Drive", "Dreams", "Signals", "Rooms", "Rain", "Hearts", "Echoes", "Skies", "Lines"]


def _key_suffix() -> str:
    return f"?k={ACCESS_KEY}" if ACCESS_KEY else ""


def demo_search(q: str, source: str) -> list[dict]:
    seed = sum(map(ord, q + source))
    out = []
    for i in range(12):
        a, b = _DEMO_WORDS[(seed + i) % 10], _DEMO_NOUNS[(seed * 3 + i * 7) % 10]
        hue = (seed * 37 + i * 53) % 360
        out.append({
            "source": source, "id": f"{source}demo{(seed + i) % 997:03d}{i:02d}"[:11].ljust(11, "x"),
            "title": f"{a} {b}" + (" (Remix)" if source == "sc" and i % 3 == 0 else ""),
            "artist": ["The Demo Band", "Test Tone Trio", "Sample Kid", "DJ Placeholder"][(seed + i) % 4],
            "album": "Demo Album" if source == "yt" else "SoundCloud",
            "duration": 30, "artwork": f"/api/demo/art/{hue}.svg", "url": None,
        })
    return out


@app.get("/api/demo/art/{hue}.svg")
def demo_art(hue: int):
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
           f'<stop offset="0" stop-color="hsl({hue},70%,55%)"/><stop offset="1" stop-color="hsl({(hue + 60) % 360},70%,25%)"/></linearGradient></defs>'
           f'<rect width="100" height="100" fill="url(#g)"/><circle cx="50" cy="50" r="18" fill="none" stroke="rgba(255,255,255,.6)" stroke-width="3"/></svg>')
    return Response(svg, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/demo/stream/{track_id}")
def demo_stream(track_id: str):
    """A 30-second WAV chord, different per track, so the player can be tested without music services."""
    rate, secs = 22050, 30
    base = 196 + (sum(map(ord, track_id)) % 12) * 18
    buf = io.BytesIO()
    n = rate * secs
    buf.write(b"RIFF" + struct.pack("<I", 36 + n * 2) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
              + b"data" + struct.pack("<I", n * 2))
    frames = bytearray()
    for i in range(n):
        t = i / rate
        env = min(1, t * 4) * min(1, (secs - t) * 2) * (0.6 + 0.4 * math.sin(t * 2 * math.pi * 0.5))
        v = sum(math.sin(2 * math.pi * base * m * t) for m in (1, 1.25, 1.5)) / 3
        frames += struct.pack("<h", int(v * env * 9000))
    buf.write(frames)
    return Response(buf.getvalue(), media_type="audio/wav", headers={"Cache-Control": "public, max-age=3600", "Accept-Ranges": "bytes"})


# ------------------------------------------------------------------ the web app itself

if WEB_DIR.exists():
    class _AppFiles(StaticFiles):
        """The app's own files: phones must ask the server whether they changed (cheap: a 304 if not),
        otherwise iPhone Safari may keep showing an old copy of app.js for days after an update."""
        async def get_response(self, path, scope):
            r = await super().get_response(path, scope)
            r.headers["Cache-Control"] = "no-cache"
            return r

    app.mount("/", _AppFiles(directory=WEB_DIR, html=True), name="web")


def _free_port(start: int) -> int:
    """The wanted port if it's free, otherwise the next free one (an old copy may still be running)."""
    import socket

    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:  # nothing is listening there
                return port
    return start


if __name__ == "__main__":
    import threading
    import webbrowser

    import uvicorn

    port = _free_port(int(os.environ.get("PORT", "8000")))
    host = os.environ.get("HOST", "").strip() or "127.0.0.1"
    url = f"http://localhost:{port}"
    who = "only this PC (and your phone through Tailscale)" if host in ("127.0.0.1", "localhost") else f"any device that can reach {host}"
    print(f"\n  {APP_NAME} is running at {url}\n  Who can open it: {who}\n  Your data: {settings.DATA_DIR}\n"
          f"  (for your iPhone, see README.md: Tailscale)\n", flush=True)
    if _flag("OPEN_BROWSER", "0"):
        # a moment's delay so the page loads after the server is listening
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=host, port=port)
