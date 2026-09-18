#Requires -Version 5.1
<#
.SYNOPSIS
    Start the full VideoDubber stack for local development on Windows.

.DESCRIPTION
    Launches, in separate windows/processes:
      1. The 3 Python FastAPI workers (stt:5101, translation:5102, tts:5103),
         each using its local .venv if present.
      2. The Node orchestrator (port 5100).
      3. The Angular dev server (videodubber-desktop).

    pnpm is REQUIRED (errors out if missing). Missing venvs / ffmpeg are
    WARNINGS, not fatal - see docs\LOCAL_SETUP.md and run
    scripts\setup-local-models.ps1 first.

    This script does NOT install anything.

.PARAMETER SkipWorkers
    Do not start the 3 Python workers.

.PARAMETER SkipUi
    Do not start the Angular dev server.

.PARAMETER SkipLibWatch
    Do not run the per-library `tsc --watch` processes (the one-off build still
    runs; edits under packages/shared/src will not be picked up until you rebuild).

.EXAMPLE
    .\scripts\dev.ps1

.EXAMPLE
    .\scripts\dev.ps1 -SkipWorkers
#>
[CmdletBinding()]
param(
    [switch]$SkipWorkers,
    [switch]$SkipUi,
    [switch]$SkipLibWatch = ($env:SKIP_LIB_WATCH -eq '1')
)

$ErrorActionPreference = 'Stop'

# --- Resolve repo root (this script lives in <root>\scripts) -----------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
Set-Location $RootDir

# --- Load .env if present (machine-specific paths/ports). Existing env wins. --
$EnvFile = Join-Path $RootDir '.env'
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $k, $v = $line.Split('=', 2)
            $k = $k.Trim(); $v = $v.Trim().Trim('"')
            if (-not [Environment]::GetEnvironmentVariable($k)) {
                [Environment]::SetEnvironmentVariable($k, $v)
            }
        }
    }
}

# --- Defaults (override via env or .env) -------------------------------------
$OrchestratorPort      = if ($env:ORCHESTRATOR_PORT)      { $env:ORCHESTRATOR_PORT }      else { '5100' }
$SttWorkerPort         = if ($env:STT_WORKER_PORT)        { $env:STT_WORKER_PORT }        else { '5101' }
$TranslationWorkerPort = if ($env:TRANSLATION_WORKER_PORT){ $env:TRANSLATION_WORKER_PORT }else { '5102' }
$TtsWorkerPort         = if ($env:TTS_WORKER_PORT)        { $env:TTS_WORKER_PORT }        else { '5103' }
$AngularPort           = if ($env:ANGULAR_PORT)           { $env:ANGULAR_PORT }           else { '1420' }
$PythonBin             = if ($env:PYTHON_PATH)            { $env:PYTHON_PATH }            else { 'python' }

$LogDir = Join-Path $RootDir '.dev-logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Info { param($m) Write-Host "[dev] $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "[dev] $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "[dev][warn] $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "[dev][error] $m" -ForegroundColor Red }

# --- Dev data isolation (port of scripts/dev.sh) ------------------------------
# Keep DEV state OUT of the installed app's production folder. The packaged app
# (apps\desktop\src-tauri\src\sidecar.rs) roots everything at %USERPROFILE%\VideoDubber;
# here we root the dev stack at a SEPARATE home so `dev.ps1` / `tauri dev` and the
# installed VideoDubber don't share config, projects, engine packs, or the
# Whisper/Piper/Argos model caches.
#
# This block was missing on Windows until 2026-09, so a Windows dev run wrote
# straight into the installed app's tree: a dev orchestrator with a different
# config schema, or an engine pack installed against a repo-local vd_tts_engine,
# silently corrupted the installed app's state - and the maintainer's Windows
# testing was never testing a clean first run. Windows is also the box that cuts
# Windows releases, so this is the worst place for that overlap.
#
# Already-set values always win, so `.env` or your shell can point dev back at
# %USERPROFILE%\VideoDubber if you ever want the old shared behaviour.
function Set-DefaultEnv { param([string]$Name, [string]$Value)
    if (-not [Environment]::GetEnvironmentVariable($Name)) {
        [Environment]::SetEnvironmentVariable($Name, $Value)
    }
    return [Environment]::GetEnvironmentVariable($Name)
}
$DevHome = if ($env:VIDEODUBBER_DEV_HOME) { $env:VIDEODUBBER_DEV_HOME }
           else { Join-Path $env:USERPROFILE 'VideoDubber-dev' }
$env:VIDEODUBBER_DEV_HOME = $DevHome
[void](Set-DefaultEnv 'VIDEODUBBER_CONFIG_DIR' $DevHome)
$ProjectsDir = Set-DefaultEnv 'VIDEODUBBER_PROJECTS_DIR' (Join-Path $DevHome 'projects')
$ModelsDir   = Set-DefaultEnv 'VIDEODUBBER_MODELS_DIR'   (Join-Path $DevHome 'models')
$CacheDir    = Set-DefaultEnv 'VIDEODUBBER_CACHE_DIR'    (Join-Path $DevHome 'cache')
# Worker caches (mirror sidecar.rs): the whisper HF cache, Piper voices and Argos
# packages live under the dev models dir. Engine packs install under
# <config>\engines automatically.
[void](Set-DefaultEnv 'STT_MODEL_CACHE_DIR' (Join-Path $ModelsDir 'huggingface'))
[void](Set-DefaultEnv 'HF_HOME'             (Join-Path $ModelsDir 'huggingface'))
[void](Set-DefaultEnv 'PIPER_VOICES_DIR'    (Join-Path $ModelsDir 'piper'))
[void](Set-DefaultEnv 'ARGOS_PACKAGES_DIR'  (Join-Path $ModelsDir 'argos'))
foreach ($d in @($ProjectsDir, $ModelsDir, $CacheDir)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}
Write-Info "Dev data home: $DevHome (isolated from the installed app's %USERPROFILE%\VideoDubber)"

# --- Preconditions -----------------------------------------------------------
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Err "pnpm is not installed. Install it with: npm i -g pnpm  (see docs\LOCAL_SETUP.md)"
    exit 1
}
Write-Ok ("pnpm {0} found." -f (pnpm --version))

if (-not (Get-Command $PythonBin -ErrorAction SilentlyContinue)) {
    Write-Warn "Python ('$PythonBin') not found on PATH. Workers without a .venv will not start."
    Write-Warn "Set PYTHON_PATH or install Python 3.10+. See docs\LOCAL_SETUP.md."
}

function Test-BinWarn {
    param([string]$Bin, [string]$EnvVar)
    $path = [Environment]::GetEnvironmentVariable($EnvVar)
    if ($path) {
        if (Test-Path $path) { Write-Ok "$Bin found at `$$EnvVar=$path"; return }
        Write-Warn "`$$EnvVar=$path does not exist; falling back to PATH lookup."
    }
    if (Get-Command $Bin -ErrorAction SilentlyContinue) {
        Write-Ok "$Bin found on PATH."
    } else {
        Write-Warn "$Bin not found (set $EnvVar or install ffmpeg). Rendering/probing will fail. See docs\LOCAL_SETUP.md."
    }
}
Test-BinWarn -Bin 'ffmpeg'  -EnvVar 'FFMPEG_PATH'
Test-BinWarn -Bin 'ffprobe' -EnvVar 'FFPROBE_PATH'

# uv for the Python engine packs (neural TTS / separation / alignment). The
# packaged app gets this from the Tauri sidecar; in dev, reuse a sidecar already
# staged by `pnpm package:sidecars` (or scripts\package\fetch-uv.ps1) so the
# orchestrator doesn't download its own copy. Without one it falls back to PATH,
# then self-installs a pinned uv into <config>\tools\uv - so this is an
# optimization, never a requirement.
if (-not $env:VIDEODUBBER_UV_PATH) {
    $stagedUv = Get-ChildItem (Join-Path $RootDir 'apps\desktop\src-tauri\binaries') -Filter 'vd-uv-*' -File -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($stagedUv) {
        $env:VIDEODUBBER_UV_PATH = $stagedUv.FullName
        Write-Ok ("Using the staged uv sidecar: {0}" -f $stagedUv.Name)
    }
}

# Track spawned processes so we can clean them up on Ctrl-C / exit.
$script:Procs = New-Object System.Collections.ArrayList

function Start-Worker {
    param([string]$Name, [string]$Dir, [string]$Port)

    $wdir = Join-Path (Join-Path $RootDir 'workers') $Dir
    if (-not (Test-Path $wdir)) {
        Write-Warn "$Name worker dir missing ($wdir); skipping. See docs\LOCAL_SETUP.md."
        return
    }

    # Prefer the worker's own venv interpreter.
    $venvPy = Join-Path $wdir '.venv\Scripts\python.exe'
    $py = $PythonBin
    if (Test-Path $venvPy) {
        $py = $venvPy
    } else {
        Write-Warn "${Name}:no .venv in $wdir; using '$PythonBin'. Run scripts\setup-local-models.ps1."
    }

    if (($py -eq $PythonBin) -and -not (Get-Command $py -ErrorAction SilentlyContinue)) {
        Write-Warn "${Name}:no usable python interpreter; skipping."
        return
    }

    Write-Info "Starting $Name worker on port $Port (logs: $LogDir\$Dir.log)"
    $outLog = Join-Path $LogDir "$Dir.log"
    $errLog = Join-Path $LogDir "$Dir.err.log"
    $uvicornArgs = @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', $Port, '--reload')
    $p = Start-Process -FilePath $py -ArgumentList $uvicornArgs -WorkingDirectory $wdir `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
        -NoNewWindow -PassThru
    [void]$script:Procs.Add($p)
}

# --- Build the workspace libraries (port of scripts/dev.sh) -------------------
# The Angular app and the orchestrator both consume @videodubber/shared (and
# @videodubber/media-worker) through their package "exports", which point at
# dist\ - NOT at src\. So dev needs these built exactly as production does.
#
# Without this step the failure modes are nasty and look nothing like the cause:
#   - No dist at all (fresh clone): "Could not resolve @videodubber/shared".
#   - Stale dist (someone edited packages\shared\src): the import resolves, but
#     anything added since the last build is missing - e.g. "updateNoticeFor is
#     not exported" - which reads like a bug in the app, not a stale artifact.
#
# This is a hard precondition, not a warning: nothing downstream can start
# without it. docs/LOCAL_SETUP.md told Windows contributors it was "handled for
# you" for months while this block only existed in the .sh.
$LibsBuildLog = Join-Path $LogDir 'libs-build.log'
Write-Info 'Building workspace libraries (shared, media-worker)...'
# $ErrorActionPreference is 'Stop' for this whole script, and in Windows
# PowerShell 5.1 (which the #Requires above still allows, and which is what you
# get from a plain `powershell.exe .\scripts\dev.ps1` - start.ps1 launches pwsh 7,
# but a contributor running this by hand does not) a native command whose stderr
# is REDIRECTED turns that stderr into a terminating NativeCommandError. pnpm
# writes progress to stderr on a perfectly successful build, so leaving it at
# 'Stop' across this `*>` redirect aborts dev.ps1 on a build that worked, with an
# error naming pnpm rather than anything real. $LASTEXITCODE below is the actual
# error handling - EAP was never what caught this failure.
$PrevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& pnpm --filter '@videodubber/shared' --filter '@videodubber/media-worker' build *> $LibsBuildLog
$ErrorActionPreference = $PrevEap
if ($LASTEXITCODE -ne 0) {
    Write-Err "Failed to build the workspace libraries. See $LibsBuildLog"
    Get-Content $LibsBuildLog -Tail 20 | ForEach-Object { Write-Host $_ }
    exit 1
}
Write-Ok 'Workspace libraries built.'

# --- Keep the libraries rebuilt while you work --------------------------------
# A one-off build fixes startup but not the edit loop: without a watcher, every
# change under packages\shared\src is invisible until the stack is restarted and
# the app silently keeps running the previous build.
if (-not $SkipLibWatch) {
    foreach ($lib in @('packages\shared', 'workers\media-worker')) {
        $libName = Split-Path -Leaf $lib
        $watchLog = Join-Path $LogDir "watch-$libName.log"
        Write-Info "Watching $lib for changes (logs: $watchLog)"
        # --preserveWatchOutput keeps the log readable instead of having tsc
        # clear the screen on every rebuild. npx is a .cmd shim, so go via cmd.exe
        # for the same reason the orchestrator does below.
        $w = Start-Process -FilePath $env:ComSpec `
            -ArgumentList @('/c', 'npx', 'tsc', '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput') `
            -WorkingDirectory (Join-Path $RootDir $lib) `
            -RedirectStandardOutput $watchLog -RedirectStandardError "$watchLog.err" `
            -NoNewWindow -PassThru
        [void]$script:Procs.Add($w)
    }
} else {
    Write-Warn '-SkipLibWatch - library changes will NOT be picked up until you rebuild.'
}

# --- Start workers -----------------------------------------------------------
if (-not $SkipWorkers) {
    Start-Worker -Name 'STT'         -Dir 'stt-worker'         -Port $SttWorkerPort
    Start-Worker -Name 'Translation' -Dir 'translation-worker' -Port $TranslationWorkerPort
    Start-Worker -Name 'TTS'         -Dir 'tts-worker'         -Port $TtsWorkerPort
} else {
    Write-Warn "-SkipWorkers - not starting Python workers."
}

# --- Start orchestrator ------------------------------------------------------
if (-not $env:ORCHESTRATOR_URL) {
    $env:ORCHESTRATOR_URL = "http://127.0.0.1:$OrchestratorPort"
}
Write-Info "Starting Node orchestrator on port $OrchestratorPort (logs: $LogDir\orchestrator.log)"
$orchOut = Join-Path $LogDir 'orchestrator.log'
$orchErr = Join-Path $LogDir 'orchestrator.err.log'
# pnpm is a .cmd shim on Windows; Start-Process can't launch it by bare name
# ("%1 is not a valid Win32 application"), so run it through cmd.exe, which
# resolves pnpm.cmd via PATH. Redirection captures pnpm's output as normal.
$orch = Start-Process -FilePath $env:ComSpec `
    -ArgumentList @('/c', 'pnpm', '--filter', '@videodubber/node-orchestrator', 'dev') `
    -WorkingDirectory $RootDir -RedirectStandardOutput $orchOut -RedirectStandardError $orchErr `
    -NoNewWindow -PassThru
[void]$script:Procs.Add($orch)

# --- Start Angular dev server ------------------------------------------------
if (-not $SkipUi) {
    Write-Info "Starting Angular dev server (videodubber-desktop) on port $AngularPort"
    $uiOut = Join-Path $LogDir 'desktop.log'
    $uiErr = Join-Path $LogDir 'desktop.err.log'
    $ui = Start-Process -FilePath $env:ComSpec `
        -ArgumentList @('/c', 'pnpm', '--filter', 'videodubber-desktop', 'dev') `
        -WorkingDirectory $RootDir -RedirectStandardOutput $uiOut -RedirectStandardError $uiErr `
        -NoNewWindow -PassThru
    [void]$script:Procs.Add($ui)
} else {
    Write-Warn "-SkipUi - not starting Angular dev server."
}

# --- Print URLs --------------------------------------------------------------
Write-Host ''
Write-Ok 'VideoDubber dev stack is starting up.'
Write-Host '  ----------------------------------------------------------------'
Write-Host ('  {0,-22} {1}' -f 'Angular UI:',         "http://127.0.0.1:$AngularPort")
Write-Host ('  {0,-22} {1}' -f 'Orchestrator:',       "http://127.0.0.1:$OrchestratorPort")
Write-Host ('  {0,-22} {1}' -f 'STT worker:',         "http://127.0.0.1:$SttWorkerPort")
Write-Host ('  {0,-22} {1}' -f 'Translation worker:', "http://127.0.0.1:$TranslationWorkerPort")
Write-Host ('  {0,-22} {1}' -f 'TTS worker:',         "http://127.0.0.1:$TtsWorkerPort")
Write-Host '  ----------------------------------------------------------------'
Write-Host ("  Logs: {0}\" -f $LogDir)
Write-Host '  Press Ctrl-C to stop everything.'
Write-Host ''

# --- Wait & clean up on exit -------------------------------------------------
try {
    # Block until any process exits or the user hits Ctrl-C.
    while ($true) {
        $running = $script:Procs | Where-Object { -not $_.HasExited }
        if (-not $running) {
            Write-Warn 'All child processes have exited.'
            break
        }
        Start-Sleep -Seconds 1
    }
}
finally {
    Write-Host ''
    Write-Info 'Shutting down dev stack...'
    foreach ($p in $script:Procs) {
        if ($p -and -not $p.HasExited) {
            try {
                # Kill the process tree so uvicorn --reload / ng workers also die.
                taskkill /PID $p.Id /T /F 2>$null | Out-Null
            } catch {
                try { $p.Kill() } catch { }
            }
        }
    }
    Write-Ok 'Stopped.'
}
