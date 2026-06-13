#requires -Version 5.1
<#
.SYNOPSIS
  Freeze the three Python workers into self-contained sidecar binaries via PyInstaller.

.DESCRIPTION
  Windows counterpart of scripts/package/build-workers.sh. Produces
  apps/desktop/src-tauri/binaries/vd-<worker>-<target-triple>.exe for each worker,
  using each worker's .venv. Tauri appends the Rust target triple to externalBin
  base names, so the .exe MUST carry the host triple (e.g. x86_64-pc-windows-msvc).
  Discover it with:  rustc -Vv | Select-String '^host:'

.PARAMETER Only
  Comma list of targets to build (default: stt,translation,tts,piper).

.PARAMETER TargetTriple
  Override the auto-detected Rust host triple.
#>
[CmdletBinding()]
param(
  [string]$Only = "stt,translation,tts,piper",
  [string]$TargetTriple = $env:TARGET_TRIPLE
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")
$BinDir    = Join-Path $RepoRoot "apps\desktop\src-tauri\binaries"
$PyiTmp    = Join-Path $BinDir ".pyi"
# One-dir worker trees ship as a Tauri resource folder (externalBin holds single
# files only). The desktop shell launches each worker exe from here.
$ResWorkers = Join-Path $RepoRoot "apps\desktop\src-tauri\resources\workers"

function Resolve-Triple {
  if ($TargetTriple) { return $TargetTriple }
  if (Get-Command rustc -ErrorAction SilentlyContinue) {
    $line = (& rustc -Vv | Select-String '^host:').ToString()
    return ($line -replace '^host:\s*', '').Trim()
  }
  throw "rustc not found and TargetTriple not set. Install Rust (rustup) or pass -TargetTriple."
}

$Triple = Resolve-Triple
Write-Host "==> Building Python worker sidecars"
Write-Host "    repo:   $RepoRoot"
Write-Host "    triple: $Triple"
Write-Host "    out:    $BinDir"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# key | venv subdir | output base name
# NOTE: "piper" is not a worker service — it's the frozen piper-tts CLI the TTS
# worker spawns per segment. It builds from the TTS worker's venv.
$Workers = @(
  @{ key="stt";         subdir="stt-worker";         base="vd-stt-worker";         mode="onedir" },
  @{ key="translation"; subdir="translation-worker"; base="vd-translation-worker"; mode="onedir" },
  @{ key="tts";         subdir="tts-worker";         base="vd-tts-worker";         mode="onedir" },
  @{ key="piper";       subdir="tts-worker";         base="vd-piper";              mode="onefile" }
)

$Wanted = $Only.Split(",") | ForEach-Object { $_.Trim() }

function Build-One($w) {
  $workerDir = Join-Path $RepoRoot ("workers\" + $w.subdir)
  $venv = Join-Path $workerDir ".venv"
  $spec = Join-Path $ScriptDir ($w.base + ".spec")
  if (-not (Test-Path $venv)) {
    throw "venv missing for $($w.key) worker at $venv. Run scripts/setup-local-models.ps1 first, or create it in CI."
  }
  $py = Join-Path $venv "Scripts\python.exe"
  if (-not (Test-Path $py)) { $py = Join-Path $venv "bin\python.exe" }

  Write-Host ""
  Write-Host "==> [$($w.key)] PyInstaller -> $($w.base).exe"
  & $py -m pip install --quiet --upgrade pyinstaller | Out-Null

  # piper-tts is deliberately NOT in the TTS worker's requirements.txt (the
  # worker calls the binary, not the package) — install it for the CLI freeze.
  if ($w.key -eq "piper") {
    & $py -m pip install --quiet "piper-tts>=1.4" | Out-Null
  }

  $dist = Join-Path $PyiTmp $w.key
  $work = Join-Path $PyiTmp ("build-" + $w.key)
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $dist, $work

  # Run from REPO_ROOT so the .spec's os.getcwd() resolves the repo root.
  Push-Location $RepoRoot
  try {
    & $py -m PyInstaller --noconfirm --clean --distpath $dist --workpath $work $spec
  } finally {
    Pop-Location
  }

  if ($w.mode -eq "onedir") {
    # COLLECT output: $dist\$base\ (exe + _internal\). Ship the whole tree as a
    # resource folder; the desktop shell launches the exe from there.
    $producedDir = Join-Path $dist $w.base
    $producedExe = Join-Path $producedDir ($w.base + ".exe")
    if (-not (Test-Path $producedExe)) { throw "expected $producedExe but it was not produced." }
    $targetDir = Join-Path $ResWorkers $w.base
    New-Item -ItemType Directory -Force -Path $ResWorkers | Out-Null
    if (Test-Path $targetDir) { Remove-Item -Recurse -Force $targetDir }
    Copy-Item -Recurse -Force $producedDir $targetDir
    Write-Host "    -> $targetDir\ (one-dir)"
  } else {
    $produced = Join-Path $dist ($w.base + ".exe")
    if (-not (Test-Path $produced)) { throw "expected $produced but it was not produced." }
    $target = Join-Path $BinDir ("$($w.base)-$Triple.exe")
    Copy-Item -Force $produced $target
    Write-Host "    -> $target"
  }
}

foreach ($w in $Workers) {
  if ($Wanted -contains $w.key) { Build-One $w }
  else { Write-Host "==> [$($w.key)] skipped (Only=$Only)" }
}

Write-Host ""
Write-Host "==> Worker sidecars built:"
Get-ChildItem $BinDir -Filter "vd-*-$Triple.exe" | ForEach-Object { Write-Host "    $($_.Name)" }
