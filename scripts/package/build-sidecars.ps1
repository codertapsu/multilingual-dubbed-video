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

# `resources/default-models` is a DECLARED Tauri resource — always exists.
$DmRes = Join-Path $RepoRoot "apps\desktop\src-tauri\resources\default-models"
# Bundling the default models is OPT-IN ($env:BUNDLE_DEFAULT_MODELS = '1'): it
# makes a first en->vi / zh->vi dub work offline but adds ~1 GB to the installer.
# The DEFAULT ships a small installer that downloads them on first run; the
# runtime seed-copy (sidecar.rs) no-ops when none are bundled.
if ($env:BUNDLE_DEFAULT_MODELS -eq '1') {
  Write-Host "`n### Default-pipeline models - BUNDLED (offline out-of-box, +~1 GB) ###"
  try { & (Join-Path $ScriptDir "fetch-default-models.ps1") }
  catch { Write-Warning "default-model staging failed; the installer will need a first-run download. $_" }
} else {
  Write-Host "`n### Default-pipeline models - NOT bundled (small installer; download on first run) ###"
  # Clear any previously-staged models so a small build never carries them.
  foreach ($sub in @('huggingface','argos','piper')) {
    Remove-Item -Recurse -Force (Join-Path $DmRes $sub) -ErrorAction SilentlyContinue
  }
}
New-Item -ItemType Directory -Force -Path $DmRes | Out-Null
if (-not (Get-ChildItem -Path $DmRes -ErrorAction SilentlyContinue)) {
  Set-Content -Path (Join-Path $DmRes "README.txt") -Value "Default-pipeline models are bundled here only when BUNDLE_DEFAULT_MODELS=1 (offline out-of-box dub); otherwise the app downloads them on first run."
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

# --- Release bundle assertion (mirror of build-sidecars.sh) ------------------
# A RELEASE must ship the bundled uv + CPython, and — WHEN opted into bundling the
# default models ($env:BUNDLE_DEFAULT_MODELS = '1') — those too. Fail the build
# rather than silently ship a degraded installer. Set $env:ASSERT_BUNDLE = '0' to
# downgrade to a warning for a deliberately-partial build.
if ($env:ASSERT_BUNDLE -ne '0') {
  $missing = @()
  # Only assert the default models when the build actually bundled them.
  if ($env:BUNDLE_DEFAULT_MODELS -eq '1') {
    if (-not (Get-ChildItem (Join-Path $DmRes 'huggingface\models--*') -ErrorAction SilentlyContinue)) {
      $missing += 'default whisper model'; Write-Host "::error:: missing bundled default whisper model ($DmRes\huggingface\models--*)"
    }
    # Assert EACH bundled pair's Argos leg + Piper voice individually, from the same
    # source of truth the staging used (defaultBundle.ts via the bridge).
    $bTsx = Join-Path $RepoRoot 'node_modules\.bin\tsx.cmd'
    $bBridge = Join-Path $RepoRoot 'packages\node-orchestrator\scripts\print-default-bundle.ts'
    $bplan = $null
    # try/catch so a nonzero bridge exit (a terminating error under pwsh 7.4+
    # $PSNativeCommandUseErrorActionPreference) falls into the aggregation below
    # instead of aborting before the uv/CPython checks + consolidated message.
    if (Test-Path $bTsx) { try { $bplan = & $bTsx $bBridge '--sh' } catch { $bplan = $null } }
    if (-not $bplan) {
      $missing += 'default-bundle plan'; Write-Host '::error:: could not compute the default-bundle plan for the release assertion'
    } else {
      foreach ($line in $bplan) {
        $p = $line -split "`t"
        if ($p[0] -eq 'argos') {
          if (-not (Get-ChildItem (Join-Path $DmRes "argos\translate-$($p[1])_$($p[2])-*") -ErrorAction SilentlyContinue)) {
            $missing += "Argos $($p[1])->$($p[2])"; Write-Host "::error:: missing bundled Argos $($p[1])->$($p[2])"
          }
        } elseif ($p[0] -eq 'piper') {
          if (-not (Test-Path (Join-Path $DmRes "piper\$($p[1]).onnx")))      { $missing += "Piper voice $($p[1])";  Write-Host "::error:: missing bundled Piper voice $($p[1])" }
          if (-not (Test-Path (Join-Path $DmRes "piper\$($p[1]).onnx.json"))) { $missing += "Piper config $($p[1])"; Write-Host "::error:: missing bundled Piper config $($p[1])" }
        }
      }
    }
  }
  if (-not $SkipUv     -and -not (Test-Path (Join-Path $BinDir "vd-uv-$Triple.exe"))) { $missing += 'uv binary';       Write-Host "::error:: missing bundled uv binary" }
  if (-not $SkipPython -and -not (Get-ChildItem (Join-Path $PyRes 'cpython-*') -ErrorAction SilentlyContinue)) { $missing += 'bundled CPython'; Write-Host "::error:: missing bundled CPython" }
  if ($missing.Count -gt 0) {
    Write-Host "::error:: release bundle is MISSING required built-in dependencies (see above)."
    Write-Host "          Re-run with network, or set `$env:ASSERT_BUNDLE = '0' to ship a degraded build on purpose."
    exit 1
  }
  Write-Host "OK bundle assertion passed: default models + uv + CPython are all bundled."
}
