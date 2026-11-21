# Tristakfy

A personal, phone-first music web app for iPhone (works on Android too). Two separate searches, one library:

- **YouTube tab**: songs and videos from YouTube Music, played by your **home server** (PC or Raspberry Pi).
- **SoundCloud tab**: tracks and remixes, played by an **always-on cloud server**.
- **Hybrid**: when the home server is off, YouTube songs automatically play their SoundCloud copy.
- Queue, shuffle, repeat, autoplay, likes, playlists, synced lyrics (LRCLIB), lock-screen controls, offline app shell.

Personal use only. Using YouTube/SoundCloud audio this way is against their terms of service, and app stores won't accept it.

## What was tested (and what wasn't)

| Tested here (demo mode, phone-size browser) | NOT tested yet |
| --- | --- |
| Layout at 375x812, both search tabs, queue, next/prev, shuffle/repeat, likes, playlists, lyrics sync, settings, the YouTube-to-SoundCloud fallback | **Real YouTube Music and SoundCloud calls**: a test of the SoundCloud code was blocked, so `soundcloud.py` and `youtube.py` have only been syntax-checked |
| | **Real iPhone**: lock-screen controls, background playback, Home Screen install |

Expect to fix small things the first time you run it against the real services; those sites change often.

## Try it in 2 minutes (demo, no music services)

```powershell
cd music-app
.\run-home.ps1 -Demo
```

Open http://localhost:8000 . You get fake songs and test tones so you can try every screen.

## Real music on your PC

```powershell
.\run-home.ps1
```

Keep yt-dlp current (YouTube breaks old versions): `.venv\Scripts\python.exe -m pip install -U "yt-dlp[default]"`

## Use it on your iPhone

1. Install **Tailscale** on the PC and the iPhone (free) and sign in to the same account.
2. On the PC, with the server running, in a terminal: `tailscale serve --bg 8000` (gives an `https://<pc-name>.<tailnet>.ts.net` address; HTTPS is needed for the offline shell and avoids mixed-content blocking).
3. On the iPhone, open that address in **Safari** → Share → **Add to Home Screen**.
4. Open the app from the Home Screen. Settings should show both chips "online".

## Hybrid with an always-on SoundCloud server

1. Deploy the `Dockerfile` to any small host (Fly.io, Railway, a $5 VPS, Oracle free tier): it runs SoundCloud only (`ENABLE_YOUTUBE=0`). Set `ACCESS_KEY` to a long random string.
2. In the app: **Settings → SoundCloud server** = the cloud address, **YouTube server** = your home address, **Access key** = the same key on both servers (set `ACCESS_KEY` for the home server too: `.\run-home.ps1 -Key yourkey`), then **Save and check**.
3. Home PC off: the YouTube chip turns red, the YouTube tab shows a notice with a one-tap "Search SoundCloud", and YouTube songs in your library play their SoundCloud match.

A Raspberry Pi or mini PC at home instead of your PC means the YouTube side is always on too.

## Import your Spotify playlists

**Your Library → Import playlist** (or Settings → Import from Spotify). Accepts:

- an **Exportify CSV** (one playlist),
- Spotify's **data download** (`Playlist1.json` with all playlists, or `YourLibrary.json` for Liked Songs),
- or **pasted text**, one song per line (`Artist - Song`).

Each song is matched on YouTube Music (home server) and falls back to SoundCloud. Remixes, live and slowed versions are never used as stand-ins. Songs with no safe match are listed at the end so you can add them by hand. Keep the app open while it runs (the screen is kept awake where iOS allows); matched songs are saved as it goes, so a locked phone doesn't lose them.

## Sync between phone and PC

Likes and playlists are also stored on the home server (`data/library.json`), and every device that points at that server syncs with it: on open, every 2 minutes, and a few seconds after each change. Deleting a playlist or un-liking a song on one device removes it everywhere. Settings → **Sync now** forces it. If the server is off, changes stay on the device and sync later. Back up `data/` along with the project.

## Stats and Discover

- **Stats** (Home): counts a song once you've listened to 30 seconds of it (or half of a short one). Shows listening time, plays, your most replayed songs, top artists, top genres, the last 7 days and what time of day you listen. They sync between your phone and PC along with likes and playlists (plays are combined; listening time is added up per device).
- **Genres** are looked up on Deezer's public search by your home server (cached per artist in `data/genres.json`; the server needs internet). SoundCloud songs bring their own genre tag.
- **Discover** (4th tab) has three parts:
  - **Find**: your genres, most-saved first (worked out from your liked songs and playlists). Tap a genre for Deezer's current top 100 in it. Tap ▶ to hear a 30-second preview, + to add (the app finds a playable YouTube/SoundCloud copy first).
  - **Recommend**: songs you probably haven't heard, grouped by the genres you play most (built from YouTube Music's radio / SoundCloud's related tracks for your most-played songs). Refresh for a different mix.
  - **Match**: look up an **artist** (top songs, songs they're featured on, artists you might like) or a **song** (similar songs to preview and add).
  - Charts, artists and previews come from Deezer's public API through your home server, so it needs internet.
  - **Today / Week / Month / Year** charts: no free source publishes genre charts by period, so the server saves each genre's chart once a day (in `data/charts.json`, only while it is running) and builds the longer views from those saved days. A song earns points for every day it charted, more for a higher spot. History starts empty: the week view needs ~7 days, the month ~30, the year ~365. The page says how many days it has. Keep the server running (or at least start it daily) to build history.

## Home, similar songs and going back

- **Trending artists** (top of Home, same look as Recently played): the 15 artists doing best on the official Deezer charts of the US, UK, Canada, Australia, Germany and France. An artist scores points for each of their best 3 songs per country (more for a higher spot), and artists charting in more than one country rank ahead of purely local ones. Each day's scores are saved (in `data/charts.json`, while the server runs) and "this week" adds up the last 7 saved days, so the first days are based on fewer days. Tap an artist to open them in Discover -> Match.
- **Find similar...** is in the ... menu of every song (and the full player): it opens Discover -> Match -> Song with that song as the reference.
- **Back**: inside a page (a playlist, a chart, Settings...) swipe right to go back; the page follows your finger. Swiping left there still moves on to the next tab (a left swipe that starts on a song row queues it instead).

## Play video

In the ... menu of a **YouTube** song, **Play video** opens the song's music video over the app, in YouTube's own embedded player (so it needs the internet but not your PC; your music pauses and resumes when you close it). **Which video:** YouTube Music labels every video as an official music video (OMV) or someone's upload (UGC: lyric videos, covers, remixes, fan edits). The server only ever picks an OMV, and only one that has the song's whole title, is by that artist, and is about the right length (music videos run a little long); the lyric and fan uploads are never picked. If there is no official video, or YouTube won't let it play outside its own app, the song's own YouTube video is used. "Open in YouTube" is always available below the player. The server can't pass videos through like it does audio, because YouTube no longer offers one file with picture and sound together.

**Downloads never contain video.** Download requests ask the server for the audio-only form (`?dl=1`); the server only ever picks audio-only formats, refuses a download if the file carries a video track or isn't labelled audio, and the app refuses anything that isn't `audio/*`. Checked on real files: the saved MP4s have a sound track and no video track.

## Seamless transitions (downloaded songs)
Settings -> Playback -> **Seamless transitions** (off by default), with a Blend length of Short 4 s / Medium 8 s / Long 12 s. When the song playing and the next one are both downloaded, the next song starts before this one ends: one fades out while the other fades in (equal-power curves, so the loudness stays even), and the player switches to the new song as the blend starts. Each downloaded song is scanned once (decoded at a low sample rate, loudness every 0.1 s; results kept in localStorage `tristakfy.mix`) to find where its sound starts and stops and whether its ending fades out on its own. The blend then skips leading and trailing silence and spans a fading outro (up to 60% longer than the chosen length), and a quiet intro is brought in faster. Skipping, pausing or seeking during a blend ends it at once. A streamed (not downloaded) song plays the normal way with no blend, as do Repeat one and an active A-B loop.

How: iPhones ignore an `<audio>` element's volume, so fades need Web Audio, and while Web Audio plays, the iPhone lock screen loses its artwork and seek bar. So every song plays on the page's own `<audio>` (normal lock screen), and Web Audio is used only for the seconds around a blend. About 6 s before, the outgoing song also starts on a hidden deck, silent, and is steered into step with the main player by nudging its playback speed (to within a few hundredths of a second). At the blend start it takes over and fades out while the next song rises on a second deck. Then the new song starts again on the main player, muted, is steered into step with the deck, and is unmuted as the deck stops. Web Audio is then paused until the next blend. The fades run on the audio clock, so slow timers on a locked phone don't affect them. Streamed songs never go through Web Audio (a SoundCloud stream from another site would play silent there). If the phone stops Web Audio while a song is on a deck, the app moves that song to the main player at the same spot. Two earlier attempts kept songs on Web Audio the whole time with a silent "anchor" track for the lock screen. The info showed, but the iPhone seek bar never worked.

## Smart mix
The shuffle button (in the player and on a playlist's page) cycles **Off -> Shuffle -> Smart mix** (a small star on the button). Each time a song starts, the remaining song that matches it best is moved to "next". The match is scored on:

- tempo, 35% (BPM within a few percent; half or double time counts);
- musical key, 20% (Camelot wheel: same key, next door, or relative major/minor);
- energy, 15% (loudness plus beat strength);
- genre, 20% (Deezer genre of the artist, as in Discover);
- artist, 10% (a related artist scores best; the same artist twice in a row scores low).

Among picks that score within 0.03 of the best, one is chosen at random, so the order differs each time. Songs you queue by hand still play first, and Smart mix picks what follows them. Turning it off restores the playlist order. While it's on, the player shows the song's tempo and key (e.g. "114 BPM · 9B").

Tempo, key and energy are measured **on the phone, for downloaded songs only**, extending the seamless-transitions scan (`mxMeasure` in `web/app.js`; about a second per song; kept in localStorage `tristakfy.mix`). Songs that aren't downloaded are matched on genre and artist, with the rest counted as average. Related artists come from Deezer through the server (`/api/discover/related`), cached in the library as `arel`.

How the measuring works:
- **Tempo:** how sharply the sound changes over time (spectral flux), then which beat spacing repeats best (autocorrelation).
- **Key:** how much of each of the 12 notes the song uses, with each note credited for its overtones, compared with the Krumhansl major/minor key profiles.

Checked on real songs: tempo was exact for bad guy (135), Levitating (103), Get Lucky (116) and Someone Like You (135); Blinding Lights came out at half speed (85.5 vs 171), which matches anyway. Key was exact for 2 of 5 and one step away on the wheel for the rest.

Shuffle (and Smart mix) now draw from every other song in the list, not only the songs after the one you tapped (that was a bug).

## A-B loop

In the full player, **A-B** (bottom centre) loops a stretch of the song. Tap it where the loop should start (A), tap again where it should end (B): the song jumps back to A and loops. Both ends show on the seek bar, with **- / +** buttons under it to nudge A or B by half a second (the song jumps there so you can hear it), and **x** to clear. A third tap on A-B also clears it. If you seek well past B the loop stays set but stops pulling you back; changing song clears it. It isn't saved.

## Downloads (offline listening)

- **Where:** the download button on any playlist page (and Liked Songs), the press-and-hold menu in Your Library, or **Settings → Downloads & storage**, which shows what is saved, how much space it uses, has **Download all** / **Remove all downloads**, and **Retry failed**. Downloaded songs get a green badge everywhere.
- **How:** a playlist's "download" mark syncs between devices; Liked Songs is per device. On a phone, the app downloads everything marked while it is open (iOS pauses web apps in the background, so keep it open; the screen is kept awake while downloading where iOS allows). Songs come from your home server (`/api/yt/stream/<id>` for YouTube m4a, `/api/sc/file/<id>` for SoundCloud), are checked to be complete (size matches, not too small for the song's length) and only then saved, in IndexedDB, as one record. A failed song is retried later (1, 2, 4... up to 30 minutes apart); if YouTube refuses a song outright, its SoundCloud copy is saved instead. If the phone runs out of room for the app, downloading pauses and says so.
- **Playing:** a downloaded song always plays from the phone (a blob URL), so it starts instantly, seeks and skips without the server, and works offline.
- **Sync and clean-up:** when a playlist is unmarked, deleted or loses songs (on any device), the phone deletes files that nothing marked still needs. If iOS clears the app's storage, the marks survive in the synced library and the songs download again the next time the app is open.
- About 3-5 MB per song. Downloading needs the PC's server; playing downloads doesn't.

## Playlist menu: press and hold

In **Your Library**, press and hold a playlist (right-click on a computer) for three options:

- **Download**: same as the download button on the playlist page (see Downloads below).
- **Rename playlist**.
- **Shuffle playlist**: a checked option that gives a brand new random order every time it is switched on. The shuffled order is temporary (only while the app is open, never saved or synced); unticking it, or restarting the app, brings back the original order. Playing, queueing and removing songs all follow what you see.

## Covers

Every cover goes through your server (`/api/art`): it downloads each one once (retrying if the image host hiccups), shrinks it to the size the screen needs, and keeps it in `data/art` (capped at about 350 MB; the oldest are cleared first). The app only shows a cover once it has fully loaded, shows a coloured placeholder until then (or if it can't load) and retries in the background, so covers can't appear half-drawn or stay blank. Needs `Pillow` (in `requirements.txt`); without it covers are still cached, just not shrunk.

## Song bar

The bar above the tab bar has like, previous, play/pause, next and loop (off, repeat all, repeat one). Swipe it left for the next song and right for the previous one, or drag it down to tuck it away: a small glowing handle stays above the tab bar (tap it or pull it up to bring the bar back). Starting a song also brings it back.

## iPhone limits to know

- **Updates not showing on the phone (fixed 2026-11-21):** the server used to send no caching instructions for the app files, so iPhone Safari could reuse an old `app.js` (and the app's own update step could save that old copy). The server now sends `Cache-Control: no-cache` for the app files (the phone asks each time; a 304 means unchanged) and `web/sw.js` fetches with `cache: 'reload'`/`'no-cache'`. After updating the server code, restart the server once.

- **Opening the app with the PC off:** the app is saved on the phone (service worker in `web/sw.js`). It always tries the server first so updates show up, but gives up after 2.5 seconds and opens the saved copy, so with the PC off and Wi-Fi/Tailscale on it opens in about 3 seconds (instantly in Airplane mode). The saved copy is refreshed in the background whenever the server answers.

- **Song length (double-length bug, fixed 2026-11-21):** YouTube's m4a audio is fragmented, and its header states the full length on top of the pieces that follow. iOS Safari added the two, so songs showed at double length with a silent second half. The server now sets those header length fields to 0 (`server/mp4fix.py`, used by `/api/yt/stream`), which is how SoundCloud's files already look; songs downloaded before the fix are repaired as they play and new downloads are saved already fixed (`mp4FixBlob` in `web/app.js`). If old downloads still look double on the phone, use **Settings -> Downloads & storage -> Redownload all** (deletes every downloaded song and fetches them again). Same byte count, so seeking is unaffected.

- Audio keeps playing with the screen locked, but iOS may stop a web app after a long time in the background.
- Seamless transitions use Web Audio, which iOS may pause with the screen locked. The app then carries on with the plain player (no blend) rather than going silent, but this is untested on an iPhone; turn the setting off if locked-screen playback of downloads misbehaves.
- Likes and playlists live in the phone's browser storage. iOS can clear it, so use **Settings → Back up library** now and then.
- YouTube cloud hosting gets bot-blocked quickly; keep YouTube on a home machine.

## Files

- `server/app.py`: API + serves the web app; `soundcloud.py`, `youtube.py`: the two sources; `mp4fix.py`: fixes the song length iPhones show for YouTube audio
- `web/`: the phone app (`index.html`, `style.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `icons/`)
- `tools/make_icons.py`: regenerates the icons
- `run-home.ps1`, `Dockerfile`, `requirements.txt`

## Motion

The background is four soft colour fields (`#bg` in `web/index.html`) that drift on their own, shift with every tab swipe and scroll (far layers move more, which gives depth), tint themselves to the song that is playing and breathe while music plays. Swiping between tabs makes pages glide, shrink and fade while the tab bar's highlight slides and stretches. Song rows, the player cover and the tab icons have springy drags and pops. The motion engine is the "motion" section at the end of `web/app.js`; all of it is switched off by the phone's **Reduce Motion** setting.

## Name and look

"Tristakfy" and its look are its own: nothing here uses Spotify's name, logo or green. **Settings → Appearance** has 11 colour themes: **Sunset** (default), **Aurora**, **Neon**, **Midnight**, **Ocean**, **Forest**, **Ember**, **Rose**, **Gold**, **Lavender** and **Mono**. **Settings → Style** changes the design: **cover shape** (circles, rounded squares, sharp squares; the full player cover follows), **background** (animated, still, or plain) and **spinning covers** (on or off). Choices are remembered per device and applied before the first paint, so there is no flash. All colours live in theme blocks at the end of `web/style.css` (one block per theme) and the picker list is `THEMES` in `web/app.js`, so adding a theme is one CSS block plus one line. The background glow follows the song that is playing and stops if the phone's Reduce Motion setting is on. To rename the app, change `APP_NAME` (server env) and the title in `index.html` / `manifest.webmanifest`.
