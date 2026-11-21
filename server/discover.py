"""Music discovery: genre charts, artist profiles and similar songs.

Uses Deezer's public API (no key needed) for charts, artists and 30-second previews. Answers are cached for a while so browsing stays quick.

Songs found here have source "dz": they carry metadata and a preview link only. The app turns one into
something it can play (YouTube Music / SoundCloud) when you play or add it.
"""
from __future__ import annotations

import datetime
import json
import os
import re
import threading
import time
from pathlib import Path

import httpx

_DZ = "https://api.deezer.com"
_client = httpx.Client(timeout=12, headers={"User-Agent": "Tristakfy/1.0"})
_cache: dict[str, tuple[float, object]] = {}
_lock = threading.Lock()

# genre name used in the app -> Deezer genre id
GENRES: dict[str, int] = {
    "Hip-Hop": 116, "Pop": 132, "Rock": 152, "Electronic": 106, "Dance": 113, "R&B & Soul": 165,
    "Alternative": 85, "Metal": 464, "Jazz & Blues": 129, "Classical": 98, "Country": 84,
    "Folk": 466, "Latin": 197, "Reggae": 144, "Soundtrack": 173,
}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _get(path: str, params: dict | None = None, ttl: int = 3600):
    key = path + "?" + "&".join(f"{k}={v}" for k, v in sorted((params or {}).items()))
    now = time.time()
    with _lock:
        hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    r = _client.get(_DZ + path, params=params)
    r.raise_for_status()
    data = r.json()
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError((data["error"] or {}).get("message", "Deezer error"))
    with _lock:
        if len(_cache) > 600:
            _cache.clear()
        _cache[key] = (now, data)
    return data


def track(t: dict) -> dict | None:
    if not t or not t.get("id") or not t.get("readable", True):
        return None
    art = t.get("artist") or {}
    alb = t.get("album") or {}
    names = [c.get("name") for c in (t.get("contributors") or []) if c.get("name")]
    return {
        "source": "dz",
        "id": str(t["id"]),
        "title": t.get("title") or "",
        "artist": ", ".join(names) if names else art.get("name") or "",
        "artist_id": art.get("id"),
        "album": alb.get("title") or "",
        "duration": t.get("duration") or 0,
        "artwork": alb.get("cover_medium") or alb.get("cover_big") or art.get("picture_medium"),
        "preview": t.get("preview") or "",
        "url": t.get("link"),
        "rank": t.get("rank") or 0,
    }


def _tracks(items) -> list[dict]:
    out, seen = [], set()
    for t in items or []:
        n = track(t)
        if n and n["id"] not in seen:
            seen.add(n["id"])
            out.append(n)
    return out


def chart(genre: str, limit: int = 100) -> list[dict]:
    dz_id = GENRES.get(genre)
    if dz_id is None:
        return []
    return _tracks(_get(f"/chart/{dz_id}/tracks", {"limit": limit}, ttl=1800).get("data"))


def find_artist(q: str) -> dict | None:
    data = _get("/search/artist", {"q": q, "limit": 10}, ttl=86400).get("data") or []
    if not data:
        return None
    # Deezer has look-alike entries with the same name and a handful of fans: take the biggest exact match.
    qn = _norm(q)
    pool = [a for a in data if _norm(a.get("name", "")) == qn] or data
    return max(pool, key=lambda a: a.get("nb_fan") or 0)


def _artist_card(a: dict) -> dict:
    return {"id": a.get("id"), "name": a.get("name"), "picture": a.get("picture_medium") or a.get("picture_big"), "fans": a.get("nb_fan") or 0}


def artist_profile(q: str) -> dict | None:
    a = find_artist(q)
    if not a:
        return None
    aid, name = a["id"], a["name"]
    top = _tracks(_get(f"/artist/{aid}/top", {"limit": 50}, ttl=21600).get("data"))
    # songs where they're only a guest: titles say "feat. <name>" / "with <name>"
    pool = _get("/search", {"q": f"feat. {name}", "limit": 100}, ttl=21600).get("data") or []
    nn = _norm(name)
    feat = [t for t in pool if (t.get("artist") or {}).get("id") != aid and nn and nn in _norm(t.get("title", ""))]
    feat.sort(key=lambda t: t.get("rank") or 0, reverse=True)
    related = [_artist_card(r) for r in (_get(f"/artist/{aid}/related", {"limit": 12}, ttl=86400).get("data") or [])]
    return {"artist": _artist_card(a), "top": top, "featured": _tracks(feat)[:25], "related": related}


def related_names(q: str) -> list[str]:
    """Names of the artists Deezer lists as related to `q` (used by Smart mix)."""
    a = find_artist(q)
    if not a:
        return []
    return [r.get("name") for r in (_get(f"/artist/{a['id']}/related", {"limit": 20}, ttl=86400).get("data") or []) if r.get("name")]


def search_tracks(q: str, limit: int = 10) -> list[dict]:
    return _tracks(_get("/search", {"q": q, "limit": limit}, ttl=3600).get("data"))[:limit]


def similar(artist_id: int | None, artist: str, title: str) -> list[dict]:
    """Songs from the artist's 'radio': that artist and the artists around them."""
    if not artist_id:
        a = find_artist(artist)
        artist_id = a["id"] if a else None
    if not artist_id:
        return []
    items = _get(f"/artist/{artist_id}/radio", {"limit": 40}, ttl=21600).get("data") or []
    tn, out, per_artist = _norm(title), [], {}
    for t in _tracks(items):
        if _norm(t["title"]) == tn:
            continue
        key = _norm(t["artist"].split(",")[0])
        if per_artist.get(key, 0) >= 3:
            continue
        per_artist[key] = per_artist.get(key, 0) + 1
        out.append(t)
    return out


# ------------------------------------------------------------------ chart history (week / month / year)
# No free source publishes genre charts by week, month or year, so this saves Deezer's chart for every
# genre once a day (while the server runs) and builds the longer views from those saved days: a song
# earns points for each day it was on the chart, more for a higher spot. The history starts empty and
# fills in as days go by.
PERIODS = {"today": 1, "week": 7, "month": 30, "year": 365}
_KEEP_DAYS = 400
_CH_FILE = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data")) / "charts.json"
_ch_lock = threading.Lock()
_ch: dict | None = None
_META = ("id", "source", "title", "artist", "artist_id", "album", "duration", "artwork", "url")


def _ch_load() -> dict:
    global _ch
    if _ch is None:
        try:
            _ch = json.loads(_CH_FILE.read_text(encoding="utf-8"))
        except Exception:
            _ch = {"v": 1, "tracks": {}, "genres": {}}
    return _ch


def _ch_save() -> None:
    try:
        _CH_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _CH_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_ch), encoding="utf-8")
        tmp.replace(_CH_FILE)
    except Exception:
        pass


def _day(ts: float) -> str:
    return datetime.date.fromtimestamp(ts).isoformat()


def snapshot(genre: str, now: float | None = None, items: list[dict] | None = None) -> bool:
    """Save today's chart for a genre (replaces an earlier save from the same day)."""
    items = items if items is not None else chart(genre)
    if not items:
        return False
    now = now or time.time()
    with _ch_lock:
        st = _ch_load()
        snaps = st["genres"].setdefault(genre, [])
        for t in items:
            st["tracks"][t["id"]] = {k: t.get(k) for k in _META}
        entry = [now, [t["id"] for t in items]]
        if snaps and _day(snaps[-1][0]) == _day(now):
            snaps[-1] = entry
        else:
            snaps.append(entry)
        del snaps[:-_KEEP_DAYS]
        _ch_save()
    return True


def maybe_snapshot_all() -> None:
    """Called now and then by the server: saves every genre's chart (and the trending artists) if today's is missing."""
    try:
        trending_artists()
    except Exception:
        pass
    for genre in GENRES:
        with _ch_lock:
            snaps = _ch_load()["genres"].get(genre) or []
            done = bool(snaps) and _day(snaps[-1][0]) == _day(time.time())
        if not done:
            try:
                snapshot(genre)
            except Exception:
                pass
            time.sleep(0.4)
    with _ch_lock:                       # forget songs that no saved day mentions any more
        st = _ch_load()
        used = {i for snaps in st["genres"].values() for _, ids in snaps for i in ids}
        for k in [k for k in st["tracks"] if k not in used]:
            del st["tracks"][k]
        _ch_save()


def period_chart(genre: str, period: str) -> dict:
    window = PERIODS[period]
    live = chart(genre)
    now = time.time()
    if period == "today":
        return {"tracks": live, "days": 1, "window": 1, "first": now}
    live_by_id = {t["id"]: t for t in live}
    cutoff = now - window * 86400
    with _ch_lock:
        snaps = (_ch_load()["genres"].get(genre) or [])
        have_today = bool(snaps) and _day(snaps[-1][0]) == _day(now)
    if not have_today and live:
        snapshot(genre, items=live)       # first look at this genre: start its history right now
    with _ch_lock:
        st = _ch_load()
        all_snaps = st["genres"].get(genre) or []
        snaps = [s for s in all_snaps if s[0] >= cutoff]
        first = all_snaps[0][0] if all_snaps else now
        points: dict[str, int] = {}
        seen: dict[str, int] = {}
        best: dict[str, int] = {}
        for _, ids in snaps:
            for pos, tid in enumerate(ids):
                points[tid] = points.get(tid, 0) + (len(ids) + 1 - (pos + 1))
                seen[tid] = seen.get(tid, 0) + 1
                best[tid] = min(best.get(tid, 10**6), pos + 1)
        ranked = sorted(points, key=lambda i: (-points[i], -seen[i], best[i]))[:100]
        out = []
        for tid in ranked:
            meta = st["tracks"].get(tid)
            if not meta:
                continue
            fresh = live_by_id.get(tid)
            out.append({**meta, "preview": (fresh or {}).get("preview", ""), "days": seen[tid], "best": best[tid]})
    return {"tracks": out, "days": len(snaps), "window": window, "first": first}


def fresh_preview(track_id: str) -> str:
    """Deezer's preview links expire, so older saved songs get a new one when you tap preview."""
    return (_get(f"/track/{int(track_id)}", ttl=600) or {}).get("preview") or ""


# ------------------------------------------------------------------ trending artists in the West
# Deezer's official chart for each country is a playlist. An artist scores points for every song they
# have on those charts (more for a higher spot, and more if they chart in several countries). Each day's
# scores are saved, and "this week" adds up the last 7 saved days.
WEST_CHARTS = {"US": 1313621735, "UK": 1111142221, "CA": 1652248171, "AU": 1313616925, "DE": 1111143121, "FR": 1109890291}
_WEEK = 7 * 86400


def _artist_points() -> tuple[dict, dict]:
    """Points per artist (their best 3 songs per country count) and the countries they chart in."""
    pts: dict[str, int] = {}
    meta: dict[str, dict] = {}
    for country, pid in WEST_CHARTS.items():
        try:
            items = _get(f"/playlist/{pid}/tracks", {"limit": 100}, ttl=10800).get("data") or []
        except Exception:
            continue
        taken: dict[str, int] = {}
        for pos, t in enumerate(items):
            a = t.get("artist") or {}
            if not a.get("id"):
                continue
            aid = str(a["id"])
            if taken.get(aid, 0) >= 3:
                continue
            taken[aid] = taken.get(aid, 0) + 1
            pts[aid] = pts.get(aid, 0) + (len(items) - pos)
            m = meta.setdefault(aid, {"name": a.get("name"), "picture": a.get("picture_medium") or a.get("picture_big") or a.get("picture"), "c": []})
            if country not in m["c"]:
                m["c"].append(country)
    return pts, meta


def trending_artists(limit: int = 15) -> dict:
    now = time.time()
    with _ch_lock:
        art = _ch_load().setdefault("artists", {"meta": {}, "days": []})
        have_today = bool(art["days"]) and _day(art["days"][-1][0]) == _day(now)
    if not have_today:
        pts, meta = _artist_points()
        if pts:
            with _ch_lock:
                art = _ch_load().setdefault("artists", {"meta": {}, "days": []})
                for k, m in meta.items():
                    old = art["meta"].get(k) or {}
                    m["c"] = sorted(set(old.get("c", [])) | set(m.get("c", [])))
                    art["meta"][k] = m
                entry = [now, pts]
                if art["days"] and _day(art["days"][-1][0]) == _day(now):
                    art["days"][-1] = entry
                else:
                    art["days"].append(entry)
                del art["days"][:-_KEEP_DAYS]
                _ch_save()
    with _ch_lock:
        art = _ch_load().get("artists") or {"meta": {}, "days": []}
        days = [d for d in art["days"] if d[0] >= now - _WEEK]
        total: dict[str, int] = {}
        for _, pts in days:
            for aid, v in pts.items():
                total[aid] = total.get(aid, 0) + v
        multi = lambda i: len((art["meta"].get(i) or {}).get("c", [])) >= 2     # charting in several countries beats a purely local hit
        ranked = sorted(total, key=lambda i: (not multi(i), -total[i]))
        out = []
        for aid in ranked:
            m = art["meta"].get(aid)
            if m and m.get("name"):
                out.append({"id": int(aid), "name": m["name"], "picture": m.get("picture"), "score": total[aid]})
            if len(out) >= limit:
                break
    if not out:
        raise RuntimeError("No chart data available")
    return {"artists": out, "days": len(days), "window": 7}
