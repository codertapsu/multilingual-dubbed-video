#requires -Version 5.1
<#
.SYNOPSIS
  Fetch the `uv` binary (Astral) and stage it as the Tauri externalBin sidecar
  vd-uv-<target-triple>.exe.

.DESCRIPTION
  Windows counterpart of scripts/package/fetch-uv.sh. uv manages the
  self-contained Python environments for the optional engine packs (neural TTS,
  vocal separation, forced alignment) and can download its own CPython, so
  bundling it means the user needs nothing preinstalled to add an engine.

.PARAMETER TargetTriple
  Override the auto-detected Rust host triple.

.PARAMETER UvVersion
  Pin a uv release (e.g. "0.9.2"); defaults to the version pinned in
  packages/node-orchestrator/src/engines/uvBootstrap.ts.
#>
[CmdletBinding()]
param(
  [string]$TargetTriple = $env:TARGET_TRIPLE,
  # PINNED (not "latest"): the orchestrator can self-install this same uv release
  # when no sidecar is bundled, verifying a per-platform sha256 pinned in
  # packages/node-orchestrator/src/engines/uvBootstrap.ts. Keep the two in
  # lockstep — a unit test fails the build if they drift.
  [string]$UvVersion = $(if ($env:UV_VERSION) { $env:UV_VERSION } else { "0.12.1" })
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")
$BinDir    = Join-Path $RepoRoot "apps\desktop\src-tauri\binaries"
$Work      = Join-Path $BinDir ".uv"

function Resolve-Triple {
  if ($TargetTriple) { return $TargetTriple }
  if (Get-Command rustc -ErrorAction SilentlyContinue) {
    $line = (& rustc -Vv | Select-String '^host:').ToString()
    return ($line -replace '^host:\s*', '').Trim()
  }
  throw "rustc not found and TargetTriple not set."
}

$Triple = Resolve-Triple
Write-Host "==> Fetching uv (self-contained Python env manager for engine packs)"
Write-Host "    triple: $Triple"
New-Item -ItemType Directory -Force -Path $BinDir, $Work | Out-Null
Get-ChildItem $Work -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force

# uv ships .zip for windows targets.
if ($env:UV_URL) {
  $url = $env:UV_URL
} elseif ($UvVersion -eq "latest") {
  $url = "https://github.com/astral-sh/uv/releases/latest/download/uv-$Triple.zip"
} else {
  $url = "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-$Triple.zip"
}

Write-Host "==> Downloading $url"
$zip = Join-Path $Work "uv.zip"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
Write-Host "==> Extracting..."
Expand-Archive -Path $zip -DestinationPath (Join-Path $Work "x") -Force

$uvSrc = Get-ChildItem (Join-Path $Work "x") -Recurse -Filter "uv.exe" | Select-Object -First 1
if (-not $uvSrc) { throw "uv.exe not found in the downloaded archive." }

& $uvSrc.FullName --version | Out-Null
$target = Join-Path $BinDir "vd-uv-$Triple.exe"
Copy-Item -Force $uvSrc.FullName $target

Write-Host ""
Write-Host "==> uv sidecar staged:"
Write-Host "    $target"
& $target --version | ForEach-Object { Write-Host "    $_" }
