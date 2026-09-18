#requires -Version 5.1
<#
.SYNOPSIS
  Freeze the three Python workers into self-contained sidecar binaries via PyInstaller.

.DESCRIPTION
  Windows counterpart of scripts/package/build-workers.sh. Produces
  apps/desktop/src-tauri/binaries/vd-<worker>-<target-triple>.exe for each worker.
  Tauri appends the Rust target triple to externalBin base names, so the .exe MUST
  carry the host triple (e.g. x86_64-pc-windows-msvc).
  Discover it with:  rustc -Vv | Select-String '^host:'

  Where the build interpreter comes from — READ THIS BEFORE CHANGING IT
  --------------------------------------------------------------------
  Until 2026-09 both this script and its .sh twin froze each worker from the
  maintainer's DEV venv (workers\<worker>\.venv). That made a release a function
  of one machine's state rather than of files in git: the two release boxes drifted
  independently (macOS was freezing Python 3.13 while Windows froze 3.12), editing
  a worker's requirements.txt had no effect on a build at all, and on macOS the
  ambient Homebrew interpreter stamped `minos 26.0` onto 175+ bundled Mach-O files
  under a declared 13.5 floor — which is how v0.8.1 shipped workers that dyld
  refuses on every Mac below macOS 26.

  So the release build no longer touches the dev venvs. It creates a THROWAWAY venv
  per worker from the standalone CPython the repo already bundles
  (apps\desktop\src-tauri\resources\python\cpython-3.12.13-*, the same interpreter
  the engine packs use at runtime), installs that worker's requirements.txt into it,
  and freezes from there. build-sidecars.ps1 stages uv and that CPython BEFORE
  calling this script for exactly that reason; if either is missing this script
  falls back to the legacy dev-venv behaviour with a loud warning — a fallback that
  must never be what cuts a release.

.PARAMETER Only
  Comma list of targets to build (default: stt,translation,tts,piper).

.PARAMETER TargetTriple
  Override the auto-detected Rust host triple.

.PARAMETER VenvMode
  "build" (default) throwaway venvs from the bundled CPython; "dev" reuses
  workers\<worker>\.venv (the pre-2026-09 behaviour).

.PARAMETER BuildPython
  Explicit interpreter to seed the throwaway venvs with.

.PARAMETER UvBin
  Explicit uv binary.
#>
[CmdletBinding()]
param(
  [string]$Only = "stt,translation,tts,piper",
  [string]$TargetTriple = $env:TARGET_TRIPLE,
  [ValidateSet("build", "dev")]
  [string]$VenvMode = $(if ($env:VENV_MODE) { $env:VENV_MODE } else { "build" }),
  [string]$BuildPython = $env:BUILD_PYTHON,
  [string]$UvBin = $env:UV_BIN
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")
$BinDir    = Join-Path $RepoRoot "apps\desktop\src-tauri\binaries"
$PyiTmp    = Join-Path $BinDir ".pyi"
# One-dir worker trees ship as a Tauri resource folder (externalBin holds single
# files only). The desktop shell launches each worker exe from here.
$ResWorkers = Join-Path $RepoRoot "apps\desktop\src-tauri\resources\workers"
$PyRes      = Join-Path $RepoRoot "apps\desktop\src-tauri\resources\python"
$BuildReqs  = Join-Path $ScriptDir "build-requirements.txt"
# piper's venv additionally pins piper-tts (see that file for why it is not in
# workers\tts-worker\requirements.txt).
$BuildReqsPiper = Join-Path $ScriptDir "build-requirements-piper.txt"
# Throwaway build venvs live under the PyInstaller scratch dir, not in workers\,
# so nothing here can be mistaken for (or silently become) a dev venv.
$BuildVenvRoot = Join-Path $PyiTmp "venvs"

# $ErrorActionPreference = "Stop" does NOT trap a native command's exit code, so
# every external invocation below is followed by this. build-orchestrator.ps1 not
# having it is how a failed postject could ship a bare node.exe.
function Assert-NativeOk([string]$What) {
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)." }
}

function Resolve-Triple {
  if ($TargetTriple) { return $TargetTriple }
  if (Get-Command rustc -ErrorAction SilentlyContinue) {
    $line = (& rustc -Vv | Select-String '^host:').ToString()
    return ($line -replace '^host:\s*', '').Trim()
  }
  throw "rustc not found and TargetTriple not set. Install Rust (rustup) or pass -TargetTriple."
}

$Triple = Resolve-Triple

# --- Locate uv + the bundled standalone CPython that seeds the build venvs -----
function Resolve-Uv {
  if ($UvBin) { return $UvBin }
  $staged = Join-Path $BinDir "vd-uv-$Triple.exe"
  if (Test-Path $staged) { return $staged }
  $onPath = Get-Command uv -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return $null
}

function Resolve-BuildPython {
  if ($BuildPython) { return $BuildPython }
  foreach ($root in (Get-ChildItem -Directory $PyRes -Filter "cpython-*" -ErrorAction SilentlyContinue)) {
    # python-build-standalone puts python.exe at the root on Windows; the POSIX
    # layout (bin\python3.X) is accepted too so a shared checkout behaves.
    foreach ($rel in @("python.exe", "bin\python.exe")) {
      $p = Join-Path $root.FullName $rel
      if (Test-Path $p) { return $p }
    }
  }
  return $null
}

$Uv = $null
$BuildPy = $null
if ($VenvMode -eq "build") {
  $Uv = Resolve-Uv
  $BuildPy = Resolve-BuildPython
  if ((-not $Uv) -or (-not $BuildPy)) {
    Write-Warning "############################################################"
    Write-Warning "Falling back to the DEV venvs (workers\*\.venv)."
    if (-not $Uv)      { Write-Warning "  - no uv found (looked for $BinDir\vd-uv-$Triple.exe and 'uv' on PATH; run fetch-uv.ps1)" }
    if (-not $BuildPy) { Write-Warning "  - no bundled CPython found under $PyRes\cpython-* (run fetch-python.ps1)" }
    Write-Warning "  The frozen workers will inherit whatever interpreter created those"
    Write-Warning "  venvs, and requirements.txt will not be applied at all."
    Write-Warning "  DO NOT cut a release from this path."
    Write-Warning "############################################################"
    $VenvMode = "dev"
  }
}

Write-Host "==> Building Python worker sidecars"
Write-Host "    repo:   $RepoRoot"
Write-Host "    triple: $Triple"
Write-Host "    out:    $BinDir"
Write-Host "    venvs:  $VenvMode"
if ($VenvMode -eq "build") {
  Write-Host "    python: $BuildPy"
  Write-Host "    uv:     $Uv"
}
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# key | requirements subdir | output base name | bundle mode
# NOTE: "piper" is not a worker service — it's the frozen piper-tts CLI the TTS
# worker spawns per segment. It gets its OWN build venv holding nothing but
# piper-tts, so the TTS worker tree stops carrying piper's onnxruntime/sympy.
$Workers = @(
  @{ key="stt";         subdir="stt-worker";         base="vd-stt-worker";         mode="onedir" },
  @{ key="translation"; subdir="translation-worker"; base="vd-translation-worker"; mode="onedir" },
  @{ key="tts";         subdir="tts-worker";         base="vd-tts-worker";         mode="onedir" },
  @{ key="piper";       subdir="tts-worker";         base="vd-piper";              mode="onefile" }
)

$Wanted = $Only.Split(",") | ForEach-Object { $_.Trim() }

# Create the throwaway build venv for one worker and install its declared deps.
# Recreated from scratch on every run on purpose: the whole point is that the
# artifact depends on requirements.txt + build-requirements.txt and nothing else.
# Sets $script:BuildVenv rather than returning it: a PowerShell function returns
# EVERYTHING that lands on the pipeline, and the native `uv` calls below write to
# stdout — so `$venv = New-BuildVenv $w` would hand back uv's output with the path
# buried in it.
function New-BuildVenv($w) {
  $venv = Join-Path $BuildVenvRoot $w.key
  $reqs = Join-Path $RepoRoot ("workers\" + $w.subdir + "\requirements.txt")

  Write-Host "    - creating throwaway build venv: $venv"
  if (Test-Path $venv) { Remove-Item -Recurse -Force $venv }
  New-Item -ItemType Directory -Force -Path $BuildVenvRoot | Out-Null
  & $Uv venv --quiet --python $BuildPy $venv
  Assert-NativeOk "uv venv ($($w.key))"

  # The piper CLI freezes ONLY piper-tts (see entry_piper.py) — it must not drag
  # the TTS worker's FastAPI stack into a one-file binary.
  $buildReqs = $BuildReqs
  if ($w.key -eq "piper") {
    $buildReqs = $BuildReqsPiper
  } else {
    Write-Host "    - uv pip install -r workers\$($w.subdir)\requirements.txt"
    $env:VIRTUAL_ENV = $venv
    & $Uv pip install --quiet -r $reqs
    Assert-NativeOk "uv pip install -r requirements.txt ($($w.key))"
  }
  Write-Host ("    - uv pip install -r " + (Split-Path -Leaf $buildReqs))
  $env:VIRTUAL_ENV = $venv
  & $Uv pip install --quiet -r $buildReqs
  Assert-NativeOk "uv pip install -r $(Split-Path -Leaf $buildReqs) ($($w.key))"
  Remove-Item Env:\VIRTUAL_ENV -ErrorAction SilentlyContinue

  $script:BuildVenv = $venv
}

function Build-One($w) {
  $workerDir = Join-Path $RepoRoot ("workers\" + $w.subdir)
  $spec = Join-Path $ScriptDir ($w.base + ".spec")

  Write-Host ""
  Write-Host "==> [$($w.key)] PyInstaller -> $($w.base).exe"

  if ($VenvMode -eq "build") {
    New-BuildVenv $w
    $venv = $script:BuildVenv
  } else {
    $venv = Join-Path $workerDir ".venv"
    if (-not (Test-Path $venv)) {
      throw "venv missing for $($w.key) worker at $venv. Run scripts/setup-local-models.ps1 first, or use -VenvMode build to build from the bundled CPython."
    }
  }

  $py = Join-Path $venv "Scripts\python.exe"
  if (-not (Test-Path $py)) { $py = Join-Path $venv "bin\python.exe" }

  if ($VenvMode -eq "dev") {
    # Legacy path: the dev venv predates build-requirements.txt, so install the
    # pinned freezer into it. Never --upgrade — that is what made every build
    # silently adopt whatever PyInstaller PyPI served that morning.
    $devReqs = if ($w.key -eq "piper") { $BuildReqsPiper } else { $BuildReqs }
    & $py -m pip install --quiet -r $devReqs | Out-Null
    Assert-NativeOk "pip install -r $(Split-Path -Leaf $devReqs) ($($w.key))"
  }

  $dist = Join-Path $PyiTmp $w.key
  $work = Join-Path $PyiTmp ("build-" + $w.key)
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $dist, $work

  # Run from REPO_ROOT so the .spec's os.getcwd() resolves the repo root.
  Push-Location $RepoRoot
  try {
    & $py -m PyInstaller --noconfirm --clean --distpath $dist --workpath $work $spec
    Assert-NativeOk "PyInstaller ($($w.key))"
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
if ($VenvMode -eq "dev") {
  Write-Warning "Built from the DEV venvs — not reproducible, and requirements.txt was not applied. See this script's .DESCRIPTION."
}
