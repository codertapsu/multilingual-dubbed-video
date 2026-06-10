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
    WARNINGS, not fatal — see docs\LOCAL_SETUP.md and run
    scripts\setup-local-models.ps1 first.

    This script does NOT install anything.

.PARAMETER SkipWorkers
    Do not start the 3 Python workers.

.PARAMETER SkipUi
    Do not start the Angular dev server.

.EXAMPLE
    .\scripts\dev.ps1

.EXAMPLE
    .\scripts\dev.ps1 -SkipWorkers
#>
[CmdletBinding()]
param(
    [switch]$SkipWorkers,
    [switch]$SkipUi
)

$ErrorActionPreference = 'Stop'

# --- Resolve repo root (this script lives in <root>\scripts) -----------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
Set-Location $RootDir

# --- Defaults (override via env) ---------------------------------------------
$OrchestratorPort      = if ($env:ORCHESTRATOR_PORT)      { $env:ORCHESTRATOR_PORT }      else { '5100' }
$SttWorkerPort         = if ($env:STT_WORKER_PORT)        { $env:STT_WORKER_PORT }        else { '5101' }
$TranslationWorkerPort = if ($env:TRANSLATION_WORKER_PORT){ $env:TRANSLATION_WORKER_PORT }else { '5102' }
$TtsWorkerPort         = if ($env:TTS_WORKER_PORT)        { $env:TTS_WORKER_PORT }        else { '5103' }
$AngularPort           = if ($env:ANGULAR_PORT)           { $env:ANGULAR_PORT }           else { '4200' }
$PythonBin             = if ($env:PYTHON_PATH)            { $env:PYTHON_PATH }            else { 'python' }

$LogDir = Join-Path $RootDir '.dev-logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Info { param($m) Write-Host "[dev] $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "[dev] $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "[dev][warn] $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "[dev][error] $m" -ForegroundColor Red }

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
        Write-Warn "$Name: no .venv in $wdir; using '$PythonBin'. Run scripts\setup-local-models.ps1."
    }

    if (($py -eq $PythonBin) -and -not (Get-Command $py -ErrorAction SilentlyContinue)) {
        Write-Warn "$Name: no usable python interpreter; skipping."
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

# --- Start workers -----------------------------------------------------------
if (-not $SkipWorkers) {
    Start-Worker -Name 'STT'         -Dir 'stt-worker'         -Port $SttWorkerPort
    Start-Worker -Name 'Translation' -Dir 'translation-worker' -Port $TranslationWorkerPort
    Start-Worker -Name 'TTS'         -Dir 'tts-worker'         -Port $TtsWorkerPort
} else {
    Write-Warn "-SkipWorkers — not starting Python workers."
}

# --- Start orchestrator ------------------------------------------------------
if (-not $env:ORCHESTRATOR_URL) {
    $env:ORCHESTRATOR_URL = "http://127.0.0.1:$OrchestratorPort"
}
Write-Info "Starting Node orchestrator on port $OrchestratorPort (logs: $LogDir\orchestrator.log)"
$orchOut = Join-Path $LogDir 'orchestrator.log'
$orchErr = Join-Path $LogDir 'orchestrator.err.log'
$orch = Start-Process -FilePath 'pnpm' `
    -ArgumentList @('--filter', '@videodubber/node-orchestrator', 'dev') `
    -WorkingDirectory $RootDir -RedirectStandardOutput $orchOut -RedirectStandardError $orchErr `
    -NoNewWindow -PassThru
[void]$script:Procs.Add($orch)

# --- Start Angular dev server ------------------------------------------------
if (-not $SkipUi) {
    Write-Info "Starting Angular dev server (videodubber-desktop) on port $AngularPort"
    $uiOut = Join-Path $LogDir 'desktop.log'
    $uiErr = Join-Path $LogDir 'desktop.err.log'
    $ui = Start-Process -FilePath 'pnpm' `
        -ArgumentList @('--filter', 'videodubber-desktop', 'dev') `
        -WorkingDirectory $RootDir -RedirectStandardOutput $uiOut -RedirectStandardError $uiErr `
        -NoNewWindow -PassThru
    [void]$script:Procs.Add($ui)
} else {
    Write-Warn "-SkipUi — not starting Angular dev server."
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
