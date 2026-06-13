#requires -Version 5.1
<#
.SYNOPSIS
  Pre-install a standalone CPython into a Tauri RESOURCE dir so the packaged
  app's `uv` never has to download an interpreter at runtime.

.DESCRIPTION
  Windows counterpart of scripts/package/fetch-python.sh.

  The optional Python engine packs (neural TTS, vocal separation, forced
  alignment) are materialized with `uv venv --python 3.12`, which by default
  DOWNLOADS a managed standalone CPython from GitHub on first use. On flaky /
  restricted links that download fails ("error sending request for URL") and
  every engine-pack install dies. Installing the interpreter at BUILD time (on
  CI, where GitHub is reachable) and bundling it lets the runtime point uv at it
  via UV_PYTHON_INSTALL_DIR + UV_PYTHON_DOWNLOADS=never (see sidecar.rs) so pack
  installs need no network for the interpreter itself.

  Native only: uv installs for the runner's own platform, which matches
  TARGET_TRIPLE because the release matrix builds each target natively.

.PARAMETER TargetTriple
  Override the auto-detected Rust host triple (used to locate vd-uv).

.PARAMETER PyVersion
  CPython version to install (default "3.12" — matches uv.ts).
#>
[CmdletBinding()]
param(
  [string]$TargetTriple = $env:TARGET_TRIPLE,
  [string]$PyVersion = $(if ($env:PY_VERSION) { $env:PY_VERSION } else { "3.12" })
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")
$BinDir    = Join-Path $RepoRoot "apps\desktop\src-tauri\binaries"
$Dest      = Join-Path $RepoRoot "apps\desktop\src-tauri\resources\python"

function Resolve-Triple {
  if ($TargetTriple) { return $TargetTriple }
  if (Get-Command rustc -ErrorAction SilentlyContinue) {
    $line = (& rustc -Vv | Select-String '^host:').ToString()
    return ($line -replace '^host:\s*', '').Trim()
  }
  throw "rustc not found and TargetTriple not set."
}
$Triple = Resolve-Triple

# Locate uv: prefer the freshly-staged sidecar, then a uv on PATH.
$Uv = $env:UV_BIN
if (-not $Uv) {
  $staged = Join-Path $BinDir "vd-uv-$Triple.exe"
  if (Test-Path $staged) { $Uv = $staged }
  elseif (Get-Command uv -ErrorAction SilentlyContinue) { $Uv = (Get-Command uv).Source }
}
if (-not $Uv) {
  throw "No uv binary found (looked for $BinDir\vd-uv-$Triple.exe and 'uv' on PATH). Run fetch-uv.ps1 first, or set UV_BIN."
}

Write-Host "==> Pre-installing CPython $PyVersion for the bundled uv"
Write-Host "    uv:     $Uv"
Write-Host "    triple: $Triple"
Write-Host "    dest:   $Dest"

if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$env:UV_PYTHON_INSTALL_DIR = $Dest
& $Uv python install $PyVersion

# Drop any top-level reparse points (uv's convenience alias is a link to the
# versioned dir; it would dangle once bundled). Delete the LINK only, not its
# target. uv still resolves the real versioned dir by scanning.
Get-ChildItem -Force $Dest | Where-Object {
  $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint
} | ForEach-Object {
  if ($_.PSIsContainer) { [System.IO.Directory]::Delete($_.FullName, $false) }
  else { [System.IO.File]::Delete($_.FullName) }
}
# Remove uv's scratch/lock state (not needed in the bundle).
foreach ($cruft in @(".temp", ".lock")) {
  $p = Join-Path $Dest $cruft
  if (Test-Path $p) { Remove-Item -Recurse -Force $p }
}

# Sanity: there must be a real cpython-* runtime left.
$runtime = Get-ChildItem -Directory $Dest -Filter "cpython-*" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $runtime) { throw "No cpython-* runtime present in $Dest after install." }

Write-Host ""
Write-Host "==> Bundled Python staged:"
Get-ChildItem -Directory $Dest -Filter "cpython-*" | ForEach-Object { Write-Host "    $($_.FullName)" }
