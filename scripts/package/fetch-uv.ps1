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

# VERIFY. This binary is bundled into the installer, while the RUNTIME twin of
# this very fetch (engines/uvBootstrap.ts) has always checked a pinned sha256 —
# the build-time path being the weaker of the two is backwards. The same hashes
# are mirrored in pinned-downloads.json and enforced here.
$expected = $null
$pinsFile = Join-Path $ScriptDir "pinned-downloads.json"
# $env:UV_URL is a dev knob pointing at an arbitrary archive, so it carries no pin
# and must not be judged against one - otherwise every UV_URL run on Windows dies
# with "uv archive failed its checksum", which reads like a compromised download.
# fetch-uv.sh has always excluded it (`-z "${UV_URL:-}"`); this is the missing twin.
if ((Test-Path $pinsFile) -and (-not $env:UV_URL) -and ($UvVersion -ne 'latest')) {
  $pins = (Get-Content -Raw $pinsFile | ConvertFrom-Json).uv
  # Only trust the hashes when they belong to the version we actually asked for.
  if ($pins.version -eq $UvVersion -and ($pins.PSObject.Properties.Name -contains $Triple)) {
    $expected = $pins.$Triple
  }
}
if ($expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
  if ($actual -ne $expected.ToLowerInvariant()) {
    throw "uv archive failed its checksum.`n       expected $expected`n       actual   $actual`n       Refresh scripts/package/pinned-downloads.json (and UV_ARTIFACTS in packages/node-orchestrator/src/engines/uvBootstrap.ts - they must agree)."
  }
  Write-Host "    sha256 OK (uv $UvVersion $Triple)"
} else {
  Write-Warning "no pinned sha256 for uv $UvVersion on $Triple; staging an UNVERIFIED binary."
}

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
