# Tristakfy: where things stand

Saved 2026-11-19, updated 2026-11-21. Everything is in this folder; nothing depends on a Claude session. **README.md** explains every feature in detail; this page is the short "pick it up again" version.

## Start it
Sharing: this folder is a git repo. Data (`data/` or `DATA_DIR`) and `.env` are git-ignored, and the server only answers this PC plus Tailscale (`HOST`, see README "Your data stays yours").

Double-click the **Tristakfy** shortcut on the Desktop (runs `run-home.ps1`: starts the server, opens the app). If Python won't start, turn Avast off (it crashed this PC twice). If the shortcut ever breaks, run `.\run-home.ps1` from this folder in PowerShell. Port 8000 is taken by another program, so it uses 8001 (it picks the next free port itself).

First time on a new PC: `python -m venv .venv`, then `.venv\Scripts\python.exe -m pip install -r requirements.txt` (the shortcut does this by itself when `.venv` is missing; if a run is interrupted and leaves a half-built `.venv`, delete that folder and start again).

## On your iPhone
Needs Tailscale on the PC and phone, then `tailscale serve --bg 8001` once (use whatever port the server window prints), then open the `https://...ts.net` address in Safari -> Share -> Add to Home Screen. After updates: fully close and reopen the Home Screen app (once or twice) so it picks up the new version.

## What exists
Home (Trending artists, Recently played, Stats), Search (YouTube and SoundCloud separately), Your Library (playlists, Spotify import, press-and-hold menu: Download / Rename / Shuffle), Discover (Find by genre with Today/Week/Month/Year charts, Recommend, Match by artist or song). Player with queue, lyrics, A-B loop, seamless transitions between downloaded songs, Smart mix (shuffle's third state: next song by tempo, key, energy, genre, related artist), swipe to skip, Play video (YouTube's player), offline downloads (audio only), 11 themes + Style options (Settings), likes/playlists/stats synced between phone and PC through the home server, parallax background and swipe effects.

## Never tried on a real iPhone (check these first if something is off)
- Downloaded real YouTube audio (fragmented m4a) playing from the phone's storage, including with the screen locked.
- The double-length fix (2026-11-21): YouTube songs should now show their real length on the iPhone and end on time, streamed or downloaded. Checked on the PC only; if songs still show double, the cause is something else (see README "iPhone limits").
- iOS storage limits/eviction for downloads, Wake Lock while downloading, SoundCloud downloads that arrive as many pieces.
- Lock-screen skip buttons while playing downloaded songs.
- Seamless transitions (2026-11-21): blends confirmed working on the iPhone. Songs play on Web Audio only for the seconds around a blend (v43), so the lock screen (artwork, seek bar) should be the normal one the rest of the time. Not yet confirmed on the iPhone. Also listen for a tiny hiccup just before or just after a blend, where the song moves onto Web Audio and back.
- Smart mix (2026-11-21): measuring a big playlist on the phone (about 1 s per downloaded song, in the background), and whether the picks feel right. Needs the server restarted once for related artists.
- How smooth the animated background and swipes feel (Settings -> Style -> Background: Still or Plain if it's heavy).
- Play video inside the Home Screen app (inline play), and the "official video can't be embedded" fallback.
- A-B loop turn-around precision (checked every 50 ms; iOS may slow timers in the background).
- Opening the app with the PC off while Wi-Fi is on (should take about 3 s; fix is in `web/sw.js`).

## Known limits
- SoundCloud's chart endpoint isn't available, so genre charts come from Deezer only.
- Week/Month/Year charts and "trending this week" build up from daily snapshots (`data/charts.json`, only saved on days the server runs).
- Genre/artist/chart data comes from Deezer's public API (needs internet on the PC). Using YouTube/SoundCloud audio this way is against their terms: personal use only.
- No light theme (every theme is dark).

## Ideas not built
Edge-swipe back is built; not built: a light theme, sharing playlists, per-device settings sync, background-download resume after iOS pauses the app, blends for streamed songs, beat-matched blends.

## Files
`server/` (FastAPI: app.py, youtube.py, soundcloud.py, discover.py, genres.py, artproxy.py, mp4fix.py) · `web/` (the phone app: index.html, app.js, style.css, sw.js) · your data folder (library.json = synced playlists/likes/stats, charts.json, genres.json, art/ cover cache; **back up library.json** or use Settings -> Back up library): `data/` by default, or `DATA_DIR` in the private `.env` file. On the original PC that's `Documents\Tristakfy\my-data`, next to the app folder · `tools/make_icons.py` · `run-home.ps1` · `Dockerfile` (SoundCloud-only cloud server).
