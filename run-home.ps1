# Starts the HOME server (YouTube + SoundCloud) on this Windows PC.
# Usage:  .\run-home.ps1            (real music)
#         .\run-home.ps1 -Demo      (fake songs + test tones, no music services)
param([switch]$Demo, [int]$Port = 8000, [string]$Key = "")

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $here ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "Creating the Python environment (first run only)..."
    python -m venv (Join-Path $here ".venv")
    & $py -m pip install -q -r (Join-Path $here "requirements.txt")
}
$env:ENABLE_YOUTUBE = "1"; $env:ENABLE_SOUNDCLOUD = "1"
$env:PORT = "$Port"; $env:ACCESS_KEY = $Key
$env:DEMO = if ($Demo) { "1" } else { "0" }
$env:OPEN_BROWSER = "1"   # the server opens the app in your browser once it is ready
& $py (Join-Path $here "server\app.py")
