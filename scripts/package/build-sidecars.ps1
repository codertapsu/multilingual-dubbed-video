#requires -Version 5.1
<#
.SYNOPSIS
  Build ALL Tauri externalBin sidecars for a fully self-contained Windows installer.

.DESCRIPTION
  Windows counterpart of scripts/package/build-sidecars.sh. Orchestrates:
    videodubber-orchestrator  (Node SEA)        <- build-orchestrator.ps1
    vd-stt-worker             (PyInstaller)     <- build-workers.ps1
    vd-translation-worker     (PyInstaller)     <- build-workers.ps1
    vd-tts-worker             (PyInstaller)     <- build-workers.ps1
    vd-piper                  (PyInstaller)     <- build-workers.ps1 (piper CLI)
    ffmpeg / ffprobe          (static, libass)  <- fetch-ffmpeg.ps1
  All land in apps\desktop\src-tauri\binaries\ with the -<target-triple>.exe suffix.

.PARAMETER TargetTriple
  Override the auto-detected Rust host triple.
#>
[CmdletBinding()]
param(
  [string]$TargetTriple = $env:TARGET_TRIPLE,
  [switch]$SkipWorkers,
  [switch]$SkipOrchestrator,
  [switch]$SkipFfmpeg,
  [switch]$SkipUv,
  [switch]$SkipPython,
  [switch]$SkipEngineSrc
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")
$BinDir    = Join-Path $RepoRoot "apps\desktop\src-tauri\binaries"

# Load .env so machine-specific paths (FFMPEG_PATH/FFPROBE_PATH for the local
# ffmpeg-copy mode, PYTHON_PATH, etc.) are available to this script and every
# sub-script it spawns.
function Import-DotEnv($path) {
  if (-not (Test-Path $path)) { return }
  Get-Content $path | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
      $k, $v = $line.Split('=', 2)
      $v = $v.Trim().Trim('"').Trim("'")
      [Environment]::SetEnvironmentVariable($k.Trim(), $v, 'Process')
    }
  }
}
Import-DotEnv (Join-Path $RepoRoot ".env")

function Resolve-Triple {
  if ($TargetTriple) { return $TargetTriple }
  if (Get-Command rustc -ErrorAction SilentlyContinue) {
    $line = (& rustc -Vv | Select-String '^host:').ToString()
    return ($line -replace '^host:\s*', '').Trim()
  }
  throw "rustc not found and TargetTriple not set."
}
$Triple = Resolve-Triple
$env:TARGET_TRIPLE = $Triple

Write-Host "############################################################"
Write-Host "# VideoDubber - building self-contained sidecars"
Write-Host "#   triple: $Triple"
Write-Host "#   out:    $BinDir"
Write-Host "############################################################"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

if (-not $SkipOrchestrator) {
  Write-Host "`n### Orchestrator ###########################################"
  & (Join-Path $ScriptDir "build-orchestrator.ps1") -TargetTriple $Triple
}
if (-not $SkipWorkers) {
  Write-Host "`n### Python workers #########################################"
  & (Join-Path $ScriptDir "build-workers.ps1") -TargetTriple $Triple
}

# `resources/workers` is a DECLARED Tauri resource (one-dir stt/translation/tts
# trees). It MUST exist at `tauri build` time even if SkipWorkers was set, or the
# bundle step aborts on the missing declared resource. Guarantee it.
$WorkersRes = Join-Path $RepoRoot "apps\desktop\src-tauri\resources\workers"
New-Item -ItemType Directory -Force -Path $WorkersRes | Out-Null
if (-not (Get-ChildItem -Path $WorkersRes -ErrorAction SilentlyContinue)) {
  Set-Content -Path (Join-Path $WorkersRes "README.txt") -Value "One-dir Python worker trees (vd-stt/translation/tts-worker) are staged here at build time."
}
if (-not $SkipFfmpeg) {
  Write-Host "`n### FFmpeg / ffprobe #######################################"
  & (Join-Path $ScriptDir "fetch-ffmpeg.ps1") -TargetTriple $Triple
}

if (-not $SkipUv) {
  Write-Host "`n### uv (engine-pack Python env manager) ####################"
  # Non-fatal: a missing uv only disables the optional Python engine packs.
  try { & (Join-Path $ScriptDir "fetch-uv.ps1") -TargetTriple $Triple }
  catch { Write-Warning "uv fetch failed; Python engine packs will be unavailable until uv is bundled or installed. $_" }
}

if (-not $SkipPython) {
  Write-Host "`n### Bundled CPython for uv (offline engine-pack installs) ###"
  # Non-fatal: if this fails, uv falls back to downloading CPython on first pack
  # install (needs network). Bundling it lets pack installs work on flaky links.
  try { & (Join-Path $ScriptDir "fetch-python.ps1") -TargetTriple $Triple }
  catch { Write-Warning "python pre-install failed; engine packs will have uv download CPython on first install (needs a reliable connection to GitHub). $_" }
}

# `resources/python` is a DECLARED Tauri resource (tauri.conf.json), so it MUST
# exist at `tauri build` time even if the optional pre-install above was skipped
# or failed -- otherwise the bundle step aborts. Guarantee it (a placeholder keeps
# it non-empty; the runtime treats "no cpython-* inside" as "not bundled").
$PyRes = Join-Path $RepoRoot "apps\desktop\src-tauri\resources\python"
New-Item -ItemType Directory -Force -Path $PyRes | Out-Null
if (-not (Get-ChildItem -Path $PyRes -Filter "cpython-*" -ErrorAction SilentlyContinue)) {
  Set-Content -Path (Join-Path $PyRes "README.txt") -Value "Bundled CPython for uv is staged here by fetch-python at build time. If absent, the app downloads CPython on first engine-pack install."
}

if (-not $SkipEngineSrc) {
  Write-Host "`n### Engine-pack worker source (vd_tts_engine) ##############"
  # Bundled as an app resource so the packaged app can run the VieNeu neural-TTS
  # pack with nothing for the user to install. Same Node script as the POSIX path,
  # so the `resources/engine-src` Tauri resource exists on Windows too (without it
  # `tauri build` fails on the missing declared resource).
  & node (Join-Path $ScriptDir "stage-engine-src.mjs")
  if ($LASTEXITCODE -ne 0) { throw "stage-engine-src.mjs failed ($LASTEXITCODE)" }
}

# `resources/default-models` is a DECLARED Tauri resource (tauri.conf.json), so it
# MUST exist at `tauri build` time or the bundle step aborts on the missing
# declared resource (the same failure mode a past release hit for engine-src).
# Windows does NOT yet stage the default-pipeline models (no PowerShell port of
# fetch-default-models.sh), so a Windows install relies on the first-run download
# for its first dub — unlike macOS, which ships them for an offline out-of-box dub.
# Guarantee the dir exists with a placeholder so the bundle succeeds; the runtime
# seed-copy (sidecar.rs) is a clean no-op when no models are present.
$DmRes = Join-Path $RepoRoot "apps\desktop\src-tauri\resources\default-models"
New-Item -ItemType Directory -Force -Path $DmRes | Out-Null
if (-not (Get-ChildItem -Path $DmRes -ErrorAction SilentlyContinue)) {
  Set-Content -Path (Join-Path $DmRes "README.txt") -Value "Default-pipeline models for the bundled language pairs are staged here on macOS for an offline out-of-box dub. On Windows they are not bundled yet; the app downloads them on first run."
}

Write-Host "`n############################################################"
Write-Host "# Done. Sidecars in $BinDir :"
Write-Host "############################################################"
# Single-file externalBin sidecars (the 3 server workers are one-dir, below).
$bases = @("videodubber-orchestrator","vd-piper","vd-uv","ffmpeg","ffprobe")
foreach ($b in $bases) {
  $f = Join-Path $BinDir "$b-$Triple.exe"
  if (Test-Path $f) { Write-Host "    $b-$Triple.exe" }
  else { Write-Host "NOTE: missing $f (skipped or failed?)." }
}
foreach ($b in @("vd-stt-worker","vd-translation-worker","vd-tts-worker")) {
  $exe = Join-Path (Join-Path $WorkersRes $b) "$b.exe"
  if (Test-Path $exe) { Write-Host "    resources\workers\$b\ (one-dir)" }
  else { Write-Host "NOTE: missing one-dir worker $exe (skipped or failed?)." }
}
