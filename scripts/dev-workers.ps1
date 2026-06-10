#Requires -Version 5.1
<#
.SYNOPSIS
    Start ONLY the 3 Python FastAPI workers for development on Windows.

.DESCRIPTION
    Launches:
      - STT worker         (faster-whisper)  on port 5101
      - Translation worker (Argos Translate) on port 5102
      - TTS worker         (Piper/fallback)  on port 5103

    Each worker uses its local .venv if present, otherwise falls back to
    PYTHON_PATH / python with a warning. Missing venvs are warnings, not fatal —
    run scripts\setup-local-models.ps1 first (see docs\LOCAL_SETUP.md).

    Ctrl-C stops all workers.

.EXAMPLE
    .\scripts\dev-workers.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
Set-Location $RootDir

$SttWorkerPort         = if ($env:STT_WORKER_PORT)        { $env:STT_WORKER_PORT }        else { '5101' }
$TranslationWorkerPort = if ($env:TRANSLATION_WORKER_PORT){ $env:TRANSLATION_WORKER_PORT }else { '5102' }
$TtsWorkerPort         = if ($env:TTS_WORKER_PORT)        { $env:TTS_WORKER_PORT }        else { '5103' }
$PythonBin             = if ($env:PYTHON_PATH)            { $env:PYTHON_PATH }            else { 'python' }

$LogDir = Join-Path $RootDir '.dev-logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Info { param($m) Write-Host "[workers] $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "[workers] $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "[workers][warn] $m" -ForegroundColor Yellow }

if (-not (Get-Command $PythonBin -ErrorAction SilentlyContinue)) {
    Write-Warn "Python ('$PythonBin') not found on PATH. Workers without a .venv will be skipped."
    Write-Warn "Set PYTHON_PATH or install Python 3.10+. See docs\LOCAL_SETUP.md."
}

$script:Procs = New-Object System.Collections.ArrayList

function Start-Worker {
    param([string]$Name, [string]$Dir, [string]$Port)

    $wdir = Join-Path (Join-Path $RootDir 'workers') $Dir
    if (-not (Test-Path $wdir)) {
        Write-Warn "$Name worker dir missing ($wdir); skipping. See docs\LOCAL_SETUP.md."
        return
    }

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

Start-Worker -Name 'STT'         -Dir 'stt-worker'         -Port $SttWorkerPort
Start-Worker -Name 'Translation' -Dir 'translation-worker' -Port $TranslationWorkerPort
Start-Worker -Name 'TTS'         -Dir 'tts-worker'         -Port $TtsWorkerPort

Write-Host ''
Write-Ok 'Python workers starting:'
Write-Host ('  {0,-22} {1}' -f 'STT worker:',         "http://127.0.0.1:$SttWorkerPort/health")
Write-Host ('  {0,-22} {1}' -f 'Translation worker:', "http://127.0.0.1:$TranslationWorkerPort/health")
Write-Host ('  {0,-22} {1}' -f 'TTS worker:',         "http://127.0.0.1:$TtsWorkerPort/health")
Write-Host ("  Logs: {0}\" -f $LogDir)
Write-Host '  Press Ctrl-C to stop.'
Write-Host ''

if ($script:Procs.Count -eq 0) {
    Write-Warn 'No workers were started.'
    exit 0
}

try {
    while ($true) {
        $running = $script:Procs | Where-Object { -not $_.HasExited }
        if (-not $running) {
            Write-Warn 'All workers have exited.'
            break
        }
        Start-Sleep -Seconds 1
    }
}
finally {
    Write-Host ''
    Write-Info 'Stopping workers...'
    foreach ($p in $script:Procs) {
        if ($p -and -not $p.HasExited) {
            try { taskkill /PID $p.Id /T /F 2>$null | Out-Null }
            catch { try { $p.Kill() } catch { } }
        }
    }
    Write-Ok 'Workers stopped.'
}
