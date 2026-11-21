# Set up your own Tristakfy (PC + iPhone)

Tristakfy is a music app for your iPhone. Your own computer at home is the **server**: it finds and plays the songs (YouTube Music and SoundCloud). Your iPhone opens the app from the Home Screen like a normal app, at home or away, through **Tailscale** (a free, private connection between your own devices).

Your copy is completely yours. It starts empty, keeps your playlists, likes and stats on your computer, and never connects to anyone else's copy.

You need:
- A computer that stays on while you listen: **Windows 10/11** (easiest), or a Mac/Linux machine.
- An **iPhone** (Android works too).
- About 20 minutes.

> **Using Claude (or another AI assistant) to help?** Paste it this repository's link and say: *"Help me set this up on my PC and iPhone, following SETUP.md."* The section **For the AI assistant** at the bottom tells it what to do.

---

## Part 1: The computer

### 1. Install Python 3.12
- Download it from **https://www.python.org/downloads/** (any 3.12.x or newer 3.x).
- In the installer, **tick "Add python.exe to PATH"** at the bottom of the first screen, then click **Install Now**.
- Check it worked: open **PowerShell** (Start menu → type "PowerShell") and run `python --version`. It should print `Python 3.12...`. If the Microsoft Store opens instead, Python isn't installed yet (or "Add to PATH" was missed): run the installer again and choose **Modify** → tick **Add Python to environment variables**.

### 2. Get the app
- Easiest: on this repository's GitHub page, click the green **Code** button → **Download ZIP**, then unzip it somewhere permanent, e.g. `Documents\Tristakfy`.
- Or, with git installed: `git clone <this repository's link>`.

You should now have a folder with `run-home.ps1`, `README.md`, `server`, `web` and so on inside.

### 3. Start the server
1. Open that folder in File Explorer, click the address bar, type `powershell` and press Enter. A PowerShell window opens in the right folder.
2. Run:
   ```powershell
   .\run-home.ps1
   ```
   If it says *"running scripts is disabled on this system"*, use this instead:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\run-home.ps1
   ```
3. The **first start takes a few minutes**: it sets up Python's add-ons by itself. Then the window shows something like:
   ```
   Tristakfy is running at http://localhost:8000
   Who can open it: only this PC (and your phone through Tailscale)
   ```
   and the app opens in your browser. **Note the port number** (usually `8000`; if something else on your PC uses 8000 it picks 8001, 8002, ...).
4. Leave this window open: closing it stops the server.

Try it: search for a song in the browser and play it.

**Next time:** just run `.\run-home.ps1` again (it starts in seconds). Tip: right-click `run-home.ps1` → **Create shortcut**, move the shortcut to your Desktop, then right-click it → **Properties** → set **Target** to
`powershell.exe -ExecutionPolicy Bypass -File "C:\full\path\to\run-home.ps1"`, so a double-click starts it.

**Mac / Linux:** in a terminal, in the app folder:
```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
ENABLE_YOUTUBE=1 ENABLE_SOUNDCLOUD=1 .venv/bin/python server/app.py
```

---

## Part 2: Tailscale (connects your iPhone to your computer)

### 4. Install Tailscale on the computer
1. Go to **https://tailscale.com/download** and install it for your computer.
2. Open Tailscale and **sign in** (a Google, Microsoft, Apple or GitHub account is fine). This creates your free private network, called a *tailnet*.

### 5. Install Tailscale on the iPhone
1. In the **App Store**, install **Tailscale**.
2. Open it and **sign in with the same account** as on the computer.
3. When iOS asks to **add a VPN configuration**, tap **Allow** (and enter your passcode).
4. Make sure the switch at the top shows **Connected**. Your computer should appear in the list.

### 6. Give the app a secure address
On the computer, open a **new** PowerShell (or terminal) window, the server keeps running in the other one, and run, with **your port** from step 3:
```powershell
tailscale serve --bg 8000
```
- The first time, it may say HTTPS / Serve isn't enabled on your tailnet and show a link. Open the link, click **Enable**, then run the command again.
- It prints an address like **`https://your-pc.tail1234.ts.net`**. That's your app's address. Write it down.
- You only do this once: it keeps working after restarts. (If your server ever starts on a different port, run it again with the new port.)

If Windows says `tailscale` isn't recognised, close and reopen PowerShell, or use the full path: `"C:\Program Files\Tailscale\tailscale.exe" serve --bg 8000`.

---

## Part 3: The app on your iPhone

### 7. Add it to your Home Screen
1. On the iPhone, check Tailscale is **Connected**.
2. Open **Safari** (it has to be Safari) and go to your address from step 6, e.g. `https://your-pc.tail1234.ts.net`.
3. The app loads. Tap the **Share** button (the square with an arrow, at the bottom), scroll down, tap **Add to Home Screen**, then **Add**.
4. Open **Tristakfy** from your Home Screen. From now on, always open it from there: it runs full-screen, keeps playing with the screen locked, and has lock-screen controls.
5. At the top of **Home**, the **YouTube (home)** and **SoundCloud** chips should say **online**.

Done! It works anywhere (home Wi-Fi or mobile data) as long as your computer is on, the server window is running, and Tailscale is connected on the iPhone.

---

## Everyday use and fixes

- **Start listening:** computer on → server running (`run-home.ps1`) → open the app on the iPhone.
- **Offline:** open a playlist → tap the download button. Downloaded songs play without the computer (keep the app open while it downloads).
- **After the app is updated** (new files in the folder): restart the server, then on the iPhone swipe the app away and open it again, once or twice.
- **YouTube songs stop playing:** YouTube changes often; update the downloader, then restart the server:
  `.venv\Scripts\python.exe -m pip install -U "yt-dlp[default]"`
- **"Can't reach server" on the iPhone:** check the computer is on and awake, the server window is open, and Tailscale is **Connected** on both. On a laptop, set it not to sleep while plugged in.
- **Spotify playlists:** Settings (the gear on Home) → **Import from Spotify** (it explains how to export them).
- **Back up your library now and then:** Settings → **Back up library**.

Everything else (all features, settings, what's stored where) is in **README.md**.

Personal use only: playing YouTube / SoundCloud audio this way is against their terms, so keep your copy to yourself.

---

## For the AI assistant

You're helping someone set up their own copy of this app. Please:

1. **Get the code** into a permanent folder (clone this repository, or have them download the ZIP). Don't change the app's code unless something actually fails.
2. **Check Python 3.10+** (3.12 recommended): `python --version`. On Windows, if `python` opens the Microsoft Store, Python isn't installed or isn't on PATH; walk them through the installer with "Add python.exe to PATH".
3. **Start the server** from the app folder: on Windows `.\run-home.ps1`, or `powershell -ExecutionPolicy Bypass -File .\run-home.ps1` if scripts are blocked. It creates `.venv` and installs `requirements.txt` on first run. On macOS/Linux, use the commands in step 3 above. Confirm it prints "running at http://localhost:PORT", and use that PORT in later steps. If a previous first run was interrupted and left a broken `.venv`, delete the `.venv` folder and run it again.
4. **Tailscale:** the person installs it and signs in on the computer and the iPhone themselves (same account; never handle their password). Then run `tailscale serve --bg PORT` on the computer. If Serve/HTTPS isn't enabled on the tailnet, the command prints a link for the person to open and enable. It prints the `https://<machine>.<tailnet>.ts.net` address.
5. **iPhone:** Safari → that address → Share → Add to Home Screen → open it from the Home Screen → the chips at the top of Home should show both sources online.
6. **Privacy defaults, keep them:** the server listens on 127.0.0.1 only (`HOST`, see `.env.example`); `tailscale serve` reaches it as localhost, so nothing needs opening on the firewall or router. Don't set `HOST=0.0.0.0` unless they ask, and then only with an `ACCESS_KEY`. Their data lives in `data/` (or `DATA_DIR` from a private `.env`), which git ignores. Never commit it.
7. **Quick check without music services:** `.\run-home.ps1 -Demo` serves fake songs and test tones.
8. **Common problems:** YouTube playback errors → update `yt-dlp` (command above) and restart. Port already in use → the server picks the next free port by itself; use the port it prints for `tailscale serve`. The iPhone shows an old version after an update → fully close and reopen the Home Screen app.
