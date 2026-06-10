#Requires -Version 5.1
<#
.SYNOPSIS
    One-time local/offline setup for VideoDubber on Windows.

.DESCRIPTION
    1. Creates a .venv per worker and pip installs its requirements.txt.
    2. Pre-caches a faster-whisper model so the first run is fast/offline.
    3. Installs an Argos Translate language package (e.g. en -> vi).
    4. Downloads a Piper voice (.onnx + .json) and prints PIPER_* env values.

    Network/destructive steps are clearly logged and individually skippable.
    It NEVER fails hard if you're offline — it prints manual instructions instead.

.PARAMETER SkipVenvs
    Don't (re)create venvs or pip install.
.PARAMETER SkipModels
    Don't download/cache any models.
.PARAMETER SkipWhisper
    Skip faster-whisper model pre-cache.
.PARAMETER SkipArgos
    Skip Argos language package install.
.PARAMETER SkipPiper
    Skip Piper voice download.

.EXAMPLE
    .\scripts\setup-local-models.ps1

.EXAMPLE
    .\scripts\setup-local-models.ps1 -SkipPiper

.NOTES
    Tunables via env: PYTHON_PATH, FASTER_WHISPER_MODEL, ARGOS_FROM, ARGOS_TO,
    PIPER_VOICE, MODELS_DIR.
#>
[CmdletBinding()]
param(
    [switch]$SkipVenvs,
    [switch]$SkipModels,
    [switch]$SkipWhisper,
    [switch]$SkipArgos,
    [switch]$SkipPiper
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
Set-Location $RootDir

$PythonBin           = if ($env:PYTHON_PATH)          { $env:PYTHON_PATH }          else { 'python' }
$FasterWhisperModel  = if ($env:FASTER_WHISPER_MODEL) { $env:FASTER_WHISPER_MODEL } else { 'small' }
$ArgosFrom           = if ($env:ARGOS_FROM)           { $env:ARGOS_FROM }           else { 'en' }
$ArgosTo             = if ($env:ARGOS_TO)             { $env:ARGOS_TO }             else { 'vi' }
$PiperVoice          = if ($env:PIPER_VOICE)          { $env:PIPER_VOICE }          else { 'vi_VN-vais1000-medium' }
$ModelsDir           = if ($env:MODELS_DIR)           { $env:MODELS_DIR }           else { Join-Path $env:USERPROFILE 'VideoDubber\models\piper' }

function Write-Info { param($m) Write-Host "[setup] $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "[setup] $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "[setup][warn] $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "[setup][error] $m" -ForegroundColor Red }
function Write-Step { param($m) Write-Host "`n==> $m" -ForegroundColor White -BackgroundColor DarkBlue }

if (-not (Get-Command $PythonBin -ErrorAction SilentlyContinue)) {
    Write-Err "Python ('$PythonBin') not found. Install Python 3.10+ or set PYTHON_PATH."
    Write-Err "See docs\LOCAL_SETUP.md. Aborting — venvs cannot be created without python."
    exit 1
}
Write-Ok ("Using python: {0}" -f (& $PythonBin --version 2>&1))

$Workers = @('stt-worker', 'translation-worker', 'tts-worker')

function Get-WorkerPython {
    param([string]$Dir)
    $venvPy = Join-Path (Join-Path $RootDir "workers\$Dir") '.venv\Scripts\python.exe'
    if (Test-Path $venvPy) { return $venvPy }
    return $PythonBin
}

# ----------------------------------------------------------------------------
# 1. Create venvs and install requirements per worker.
# ----------------------------------------------------------------------------
function New-WorkerVenv {
    param([string]$Dir)
    $wdir = Join-Path $RootDir "workers\$Dir"
    $venv = Join-Path $wdir '.venv'

    if (-not (Test-Path $wdir)) {
        Write-Warn "${Dir}: worker directory missing ($wdir); skipping venv."
        return
    }

    if (Test-Path $venv) {
        Write-Info "${Dir}: .venv already exists — reusing it."
    } else {
        Write-Info "${Dir}: creating .venv (this writes to $venv)"
        & $PythonBin -m venv $venv
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "${Dir}: failed to create venv. Skipping."
            return
        }
    }

    $vpy = Join-Path $venv 'Scripts\python.exe'
    if (-not (Test-Path $vpy)) {
        Write-Warn "${Dir}: venv python not found at $vpy; skipping pip install."
        return
    }

    Write-Info "${Dir}: upgrading pip (network)"
    & $vpy -m pip install --upgrade pip 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warn "${Dir}: pip upgrade failed (offline?). Continuing." }

    $req = Join-Path $wdir 'requirements.txt'
    if (Test-Path $req) {
        Write-Info "${Dir}: pip install -r requirements.txt (network)"
        & $vpy -m pip install -r $req
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "${Dir}: dependencies installed."
        } else {
            Write-Warn "${Dir}: pip install failed (offline / missing build tools?)."
            Write-Warn "${Dir}: install manually later with:"
            Write-Warn "    `"$vpy`" -m pip install -r `"$req`""
        }
    } else {
        Write-Warn "${Dir}: no requirements.txt found at $req; skipping deps."
    }
}

if (-not $SkipVenvs) {
    Write-Step 'Step 1/4: Python virtual environments + dependencies'
    foreach ($w in $Workers) { New-WorkerVenv -Dir $w }
} else {
    Write-Warn '-SkipVenvs — skipping venv creation and pip installs.'
}

# ----------------------------------------------------------------------------
# 2. Pre-cache a faster-whisper model.
# ----------------------------------------------------------------------------
if (-not $SkipModels -and -not $SkipWhisper) {
    Write-Step "Step 2/4: Pre-cache faster-whisper model '$FasterWhisperModel' (network)"
    $sttPy = Get-WorkerPython -Dir 'stt-worker'
    $py = @"
import sys
model = "$FasterWhisperModel"
try:
    from faster_whisper import WhisperModel
    WhisperModel(model, device="cpu", compute_type="int8")
    print(f"[setup] faster-whisper model '{model}' cached successfully.")
except ModuleNotFoundError:
    print("[setup][warn] faster-whisper not installed in this venv.")
    print("[setup][warn] Install deps first (re-run without -SkipVenvs), then retry.")
    sys.exit(0)
except Exception as exc:
    print(f"[setup][warn] Could not pre-cache model (offline?): {exc}")
    print("[setup][warn] It will be downloaded on first transcription instead.")
    sys.exit(0)
"@
    & $sttPy -c $py
    Write-Ok 'faster-whisper step done. (Set FASTER_WHISPER_MODEL to change: tiny|base|small|medium|large-v3)'
} else {
    Write-Warn 'Skipping faster-whisper model pre-cache.'
}

# ----------------------------------------------------------------------------
# 3. Install an Argos Translate language package (e.g. en -> vi).
# ----------------------------------------------------------------------------
if (-not $SkipModels -and -not $SkipArgos) {
    Write-Step "Step 3/4: Install Argos Translate package $ArgosFrom -> $ArgosTo (network)"
    $trPy = Get-WorkerPython -Dir 'translation-worker'
    $py = @"
import sys
from_code, to_code = "$ArgosFrom", "$ArgosTo"
try:
    import argostranslate.package as pkg
    import argostranslate.translate as translate
except ModuleNotFoundError:
    print("[setup][warn] argostranslate not installed in this venv.")
    print("[setup][warn] Install deps first (re-run without -SkipVenvs), then retry.")
    print(f"[setup][warn] Manual alternative (CLI): argospm install translate-{from_code}_{to_code}")
    sys.exit(0)

installed = translate.get_installed_languages()
have = any(
    l.code == from_code and any(t.to_lang.code == to_code for t in l.translations_from)
    for l in installed
)
if have:
    print(f"[setup] Argos package {from_code} -> {to_code} already installed.")
    sys.exit(0)

try:
    print("[setup] Updating Argos package index...")
    pkg.update_package_index()
    available = pkg.get_available_packages()
    match = next((p for p in available if p.from_code == from_code and p.to_code == to_code), None)
    if match is None:
        print(f"[setup][warn] No Argos package published for {from_code} -> {to_code}.")
        print("[setup][warn] Browse pairs at https://www.argosopentech.com/argospm/index/")
        sys.exit(0)
    print(f"[setup] Downloading and installing {from_code} -> {to_code}...")
    path = match.download()
    pkg.install_from_path(path)
    print(f"[setup] Installed Argos package {from_code} -> {to_code}.")
except Exception as exc:
    print(f"[setup][warn] Could not install Argos package (offline?): {exc}")
    print(f"[setup][warn] Manual: argospm install translate-{from_code}_{to_code}")
    sys.exit(0)
"@
    & $trPy -c $py
    Write-Ok 'Argos step done. (Set ARGOS_FROM / ARGOS_TO to install other pairs.)'
} else {
    Write-Warn 'Skipping Argos language package install.'
}

# ----------------------------------------------------------------------------
# 4. Download a Piper voice (.onnx + .json).
# ----------------------------------------------------------------------------
if (-not $SkipModels -and -not $SkipPiper) {
    Write-Step "Step 4/4: Download Piper voice '$PiperVoice' (network)"
    New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null

    # Parse "vi_VN-vais1000-medium" -> lang=vi locale=vi_VN dataset=vais1000 quality=medium
    $locale  = $PiperVoice.Split('-')[0]            # vi_VN
    $rest    = $PiperVoice.Substring($locale.Length + 1)  # vais1000-medium
    $dataset = $rest.Split('-')[0]                  # vais1000
    $quality = $rest.Substring($dataset.Length + 1) # medium
    $lang    = $locale.Split('_')[0]                # vi

    $baseUrl = "https://huggingface.co/rhasspy/piper-voices/resolve/main/$lang/$locale/$dataset/$quality"
    $onnxUrl = "$baseUrl/$PiperVoice.onnx"
    $jsonUrl = "$baseUrl/$PiperVoice.onnx.json"
    $onnxOut = Join-Path $ModelsDir "$PiperVoice.onnx"
    $jsonOut = Join-Path $ModelsDir "$PiperVoice.onnx.json"

    function Get-File {
        param([string]$Url, [string]$Out)
        if ((Test-Path $Out) -and ((Get-Item $Out).Length -gt 0)) {
            Write-Info "Already present: $Out"
            return $true
        }
        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing
            return $true
        } catch {
            Write-Warn "Failed to download $Url : $($_.Exception.Message)"
            return $false
        }
    }

    $piperOk = $true
    if (-not (Get-File -Url $onnxUrl -Out $onnxOut)) { $piperOk = $false }
    if (-not (Get-File -Url $jsonUrl -Out $jsonOut)) { $piperOk = $false }

    if ($piperOk -and (Test-Path $onnxOut) -and (Test-Path $jsonOut)) {
        Write-Ok "Piper voice downloaded to $ModelsDir"
        Write-Host ''
        Write-Info 'To use this voice, set these env vars (System / user environment or .env):'
        Write-Host ("  `$env:PIPER_VOICE_MODEL_PATH = '{0}'" -f $onnxOut) -ForegroundColor White
        Write-Info 'And point PIPER_BINARY_PATH at your piper.exe, e.g.:'
        Write-Host "  `$env:PIPER_BINARY_PATH = 'C:\path\to\piper.exe'" -ForegroundColor White
        Write-Info 'Download the Piper binary from: https://github.com/rhasspy/piper/releases'
        Write-Info '(If PIPER_BINARY_PATH is unset, the TTS worker falls back to system TTS or a silent/sine dev WAV.)'
    } else {
        Write-Warn 'Could not download the Piper voice (offline / wrong voice id?).'
        Write-Warn 'Manual steps:'
        Write-Warn '  1. Browse voices:    https://huggingface.co/rhasspy/piper-voices'
        Write-Warn "  2. Download '$PiperVoice.onnx' and '$PiperVoice.onnx.json' into: $ModelsDir"
        Write-Warn "  3. `$env:PIPER_VOICE_MODEL_PATH = '$onnxOut'"
        Write-Warn '  4. Download the piper binary: https://github.com/rhasspy/piper/releases'
        Write-Warn '  5. `$env:PIPER_BINARY_PATH = ''C:\path\to\piper.exe'''
    }
} else {
    Write-Warn 'Skipping Piper voice download.'
}

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
Write-Step 'Setup complete'
Write-Ok 'Next steps:'
Write-Host '  - Verify your environment:   pnpm verify   (or: tsx scripts\verify-environment.ts)'
Write-Host '  - Start the dev stack:       .\scripts\dev.ps1'
Write-Host '  - Troubleshooting / details: docs\LOCAL_SETUP.md and docs\MODEL_SETUP.md'
