#Requires -Version 5.1
<#
.SYNOPSIS
  Stage the DEFAULT-pipeline models INTO the app bundle so a first dub for a
  bundled language pair works fully OFFLINE on Windows, out of the box.

.DESCRIPTION
  Windows port of scripts/package/fetch-default-models.sh. Stages, into
  apps\desktop\src-tauri\resources\default-models:
    - faster-whisper 'small'  (STT, multilingual) -> huggingface\
    - the Argos pivot legs      (translation)       -> argos\
    - the recommended Piper voice(s) (TTS)          -> piper\

  WHAT gets staged is NOT hardcoded — it is derived from the single source of
  truth (packages\node-orchestrator\src\setup\defaultBundle.ts -> DEFAULT_PAIRS)
  via the print-default-bundle.ts bridge, exactly like the POSIX script. To
  add/change a bundled pair, edit that TS file and rebuild.

  At runtime the desktop shell (sidecar.rs) seed-copies these into the writable
  model dirs on first launch. Idempotent: skips a model already staged. Skip
  entirely with $env:SKIP_DEFAULT_MODELS = '1'.

  Prereqs: the STT + translation worker venvs must exist
  (scripts\setup-local-models.ps1), and the workspace must be built so the bridge
  can import @videodubber/shared (build-sidecars.ps1 builds the orchestrator
  first, which covers this).
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

if ($env:SKIP_DEFAULT_MODELS -eq '1') {
  Write-Host "SKIP_DEFAULT_MODELS=1 - skipping default-model staging."
  exit 0
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path
Set-Location $RepoRoot
$Dest = Join-Path $RepoRoot 'apps\desktop\src-tauri\resources\default-models'

$SttPy = Join-Path $RepoRoot 'workers\stt-worker\.venv\Scripts\python.exe'
$TrPy  = Join-Path $RepoRoot 'workers\translation-worker\.venv\Scripts\python.exe'

# --- Derive the staging plan from the single source of truth ------------------
# The bridge prints tab-separated records: `whisper <m>` / `argos <from> <to>` /
# `piper <id> <onnxUrl> <onnxJsonUrl>`.
$Tsx    = Join-Path $RepoRoot 'node_modules\.bin\tsx.cmd'
$Bridge = Join-Path $RepoRoot 'packages\node-orchestrator\scripts\print-default-bundle.ts'
if (-not (Test-Path $Tsx)) { throw "tsx not found at $Tsx - run 'pnpm install' first." }
$plan = & $Tsx $Bridge '--sh'
if ($LASTEXITCODE -ne 0 -or -not $plan) {
  throw ("failed to compute the default-bundle plan via $Bridge. Build the workspace " +
    "first (pnpm -r build, or at least 'pnpm --filter @videodubber/shared build').")
}

# Single-line, QUOTE-FREE Python (args arrive as sys.argv[1..]). No newlines and
# no string literals -> nothing for PowerShell's native-command quoting to mangle
# when passed via `& python -c <code> <args>`. The PS Write-Host lines log progress
# instead; a failure surfaces as a non-zero exit that the caller turns into a throw.
$whisperCode = 'import sys; from faster_whisper import download_model; download_model(sys.argv[1], cache_dir=sys.argv[2])'
$argosCode   = 'import sys, argostranslate.package as pkg; pkg.update_package_index(); a=pkg.get_available_packages(); p=next((x for x in a if x.from_code==sys.argv[1] and x.to_code==sys.argv[2]), None); assert p is not None; pkg.install_from_path(p.download())'

function Save-Whisper {
  param([string]$size)
  if (Get-ChildItem (Join-Path $Dest 'huggingface') -Filter "models--*faster-whisper-$size" -Directory -ErrorAction SilentlyContinue) {
    Write-Host "==> whisper '$size' already staged - skip"; return
  }
  if (-not (Test-Path $SttPy)) { throw "STT venv not found at $SttPy (run scripts\setup-local-models.ps1 first)." }
  Write-Host "==> downloading faster-whisper '$size' into the hub cache"
  & $SttPy '-c' $whisperCode $size (Join-Path $Dest 'huggingface')
  if ($LASTEXITCODE -ne 0) { throw "whisper staging failed (exit $LASTEXITCODE)." }
}

function Save-Argos {
  param([string]$from, [string]$to)
  # Per-pair skip guard, `-` anchored so `en_vi-` can't match a longer `en_vie-`.
  if (Get-ChildItem (Join-Path $Dest 'argos') -Filter "translate-${from}_${to}-*" -Directory -ErrorAction SilentlyContinue) {
    Write-Host "==> Argos $from->$to already staged - skip"; return
  }
  if (-not (Test-Path $TrPy)) { throw "translation venv not found at $TrPy." }
  Write-Host "==> downloading + installing Argos $from->$to into ARGOS_PACKAGES_DIR"
  $env:ARGOS_PACKAGES_DIR = (Join-Path $Dest 'argos')
  & $TrPy '-c' $argosCode $from $to
  if ($LASTEXITCODE -ne 0) { throw "Argos staging failed for $from->$to (exit $LASTEXITCODE)." }
}

function Save-Piper {
  param([string]$id, [string]$url, [string]$configUrl)
  $onnx = Join-Path $Dest "piper\$id.onnx"
  $cfg  = Join-Path $Dest "piper\$id.onnx.json"
  # Require BOTH files: a voice without its .onnx.json can't load, so a half-staged
  # voice must re-download, not skip.
  if ((Test-Path $onnx) -and (Test-Path $cfg)) {
    Write-Host "==> Piper '$id' already staged - skip"; return
  }
  Write-Host "==> downloading Piper voice $id"
  # Download to temp paths, move into place only once BOTH succeed, so a mid-download
  # failure never leaves a stray .onnx that masks the missing JSON.
  $ProgressPreference = 'SilentlyContinue'
  try {
    Invoke-WebRequest -Uri $url       -OutFile "$onnx.part" -UseBasicParsing
    Invoke-WebRequest -Uri $configUrl -OutFile "$cfg.part"  -UseBasicParsing
    Move-Item -Force "$onnx.part" $onnx
    Move-Item -Force "$cfg.part"  $cfg
    Write-Host "   staged Piper $id"
  } catch {
    Remove-Item -Force -ErrorAction SilentlyContinue "$onnx.part", "$cfg.part"
    throw "failed to download Piper voice ${id}: $($_.Exception.Message)"
  }
}

Write-Host "############################################################"
Write-Host "# Staging default-pipeline models -> $Dest"
$plan | ForEach-Object { Write-Host "#   $_" }
Write-Host "############################################################"
New-Item -ItemType Directory -Force -Path `
  (Join-Path $Dest 'huggingface'), (Join-Path $Dest 'argos'), (Join-Path $Dest 'piper') | Out-Null

foreach ($line in $plan) {
  if (-not $line) { continue }
  $p = $line -split "`t"
  switch ($p[0]) {
    'whisper' { Save-Whisper $p[1] }
    'argos'   { Save-Argos $p[1] $p[2] }
    'piper'   { Save-Piper $p[1] $p[2] $p[3] }
    default   { Write-Warning "unknown default-bundle record: $($p[0])" }
  }
}

Write-Host "==> default-model staging complete."
Write-Host "DEFAULT_MODELS_STAGED_OK"
