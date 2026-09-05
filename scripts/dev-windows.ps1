# FlowMap one-shot dev boot for Windows (PowerShell 5.1 compatible).
#
# Starts:
#   1. the FlowMap server on 127.0.0.1:8720 (FLOWMAP_PORT, recording disabled)
#   2. the vite dev server in client/ on :5173 (proxies /api and /ws to :8720)
#
# Ctrl-C tears both down (process trees, not just the top PID).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-windows.ps1
#   ... -Port 8800              # different server port (vite proxy still targets 8720!
#                               # see note below)
#   ... -EnableRecording        # opt INTO recording writes (default: off, like e2e)
#
# Port note: client/vite.config.ts hardcodes the proxy target http://127.0.0.1:8720.
# Use -Port only if you also adjust the vite proxy, or pass -Port 8720 (default).
#
# Requires: Node/npm. The server prefers uv (repo standard); without it, any
# Python 3.13 with the server dependencies installed is used via PYTHONPATH.
param(
    [int]$Port = 8720,
    [switch]$EnableRecording
)

$ErrorActionPreference = "Stop"

# UTF-8 console output (vite + Python logs can carry non-ASCII venue/symbol names).
chcp 65001 | Out-Null

# Resolve the repo's REAL path: vite's dev server can fail when the working
# directory contains non-ASCII characters, so we canonicalize and cd first.
$scriptsDir = (Get-Item -LiteralPath $PSScriptRoot).FullName
$root = (Get-Item -LiteralPath (Split-Path -Parent $scriptsDir)).FullName
Set-Location -LiteralPath $root

# --- environment shared by both children -----------------------------------
$env:FLOWMAP_PORT = "$Port"
$env:FLOWMAP_RECORDING_ENABLED = if ($EnableRecording) { "1" } else { "0" }
$env:FLOWMAP_LOG_LEVEL = "info"
$hadPythonPath = Test-Path Env:\PYTHONPATH
$oldPythonPath = if ($hadPythonPath) { $env:PYTHONPATH } else { $null }

$serverProc = $null
$clientProc = $null

function Stop-Tree([System.Diagnostics.Process]$proc) {
    if ($proc -and -not $proc.HasExited) {
        # /T kills the whole tree (uv -> python, npm -> node -> esbuild).
        taskkill /PID $proc.Id /T /F | Out-Null
    }
}

try {
    # --- server -------------------------------------------------------------
    $serverDir = Join-Path $root "server"
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if ($uv) {
        # uv manages its own venv; FLOWMAP_* above are inherited.
        $serverProc = Start-Process -FilePath $uv.Source `
            -ArgumentList @("run", "python", "-m", "flowmap_server") `
            -WorkingDirectory $serverDir -NoNewWindow -PassThru
    } else {
        # Plain-Python path: server package lives in server/src.
        $env:PYTHONPATH = "$(Join-Path $root 'server\src')"
        $python = (Get-Command python -ErrorAction SilentlyContinue).Source
        if (-not $python) { throw "Neither uv nor python was found on PATH." }
        Write-Host "uv not found - using $python with PYTHONPATH=$env:PYTHONPATH"
        Write-Host "(install server deps first: see server/pyproject.toml)"
        $serverProc = Start-Process -FilePath $python `
            -ArgumentList @("-m", "flowmap_server") `
            -WorkingDirectory $root -NoNewWindow -PassThru
    }

    # --- wait for /api/health (up to ~30 s) ---------------------------------
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        if ($serverProc.HasExited) { break }
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" `
                -UseBasicParsing -TimeoutSec 2
            if ($resp.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) {
        throw "server did not become healthy on http://127.0.0.1:$Port/api/health (see output above)"
    }
    Write-Host "server up on :$Port"

    # --- client (vite; proxies /api + /ws to the server) --------------------
    $clientDir = Join-Path $root "client"
    if (-not (Test-Path (Join-Path $clientDir "node_modules"))) {
        Write-Host "installing client dependencies (first run)..."
        $npmInstall = Start-Process -FilePath "cmd.exe" `
            -ArgumentList @("/c", "npm install") `
            -WorkingDirectory $clientDir -NoNewWindow -PassThru -Wait
        if ($npmInstall.ExitCode -ne 0) { throw "npm install failed ($($npmInstall.ExitCode))" }
    }
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm) { $npm = "npm.cmd" }
    $clientProc = Start-Process -FilePath $npm `
        -ArgumentList @("run", "dev") `
        -WorkingDirectory $clientDir -NoNewWindow -PassThru

    Write-Host ""
    Write-Host "FlowMap dev: open http://localhost:5173  (Ctrl-C stops both)"
    Write-Host ""

    # Park in the foreground until a child exits or the user hits Ctrl-C.
    while (-not $clientProc.HasExited -and -not $serverProc.HasExited) {
        Start-Sleep -Seconds 1
    }
}
finally {
    Stop-Tree $clientProc
    Stop-Tree $serverProc
    if (-not $hadPythonPath) { Remove-Item Env:\PYTHONPATH -ErrorAction SilentlyContinue }
    elseif ($oldPythonPath -ne $null) { $env:PYTHONPATH = $oldPythonPath }
    Write-Host "flowmap dev stopped."
}
