#requires -Version 5.1
<#
.SYNOPSIS
  Freeze the Node orchestrator into a single self-contained sidecar executable
  via Node SEA (Single Executable Application).

.DESCRIPTION
  Windows counterpart of scripts/package/build-orchestrator.sh. Produces
  apps/desktop/src-tauri/binaries/videodubber-orchestrator-<target-triple>.exe.

  Steps: pnpm build -> esbuild bundle to one CJS file -> node --experimental-sea-config
  -> copy node.exe -> postject the SEA blob in. Requires Node >=20.11.

  Why every native call below is followed by an exit-code check
  ------------------------------------------------------------
  $ErrorActionPreference = "Stop" does NOT trap a native command's exit code.
  This script used to run esbuild and postject via `npx --yes` with no check, and
  step 4 copies node.exe to the output path BEFORE postject runs — so a failed
  postject (network, version skew, AV file lock) left
  videodubber-orchestrator-x86_64-pc-windows-msvc.exe as an unmodified copy of
  node.exe. Every downstream gate passed on the path existing, and the installer
  shipped an "orchestrator" that starts a Node REPL instead of binding :5100.
  `npx --yes` also fetched esbuild/postject from the registry at build time,
  ignoring the versions package.json pins and the macOS build uses, and made the
  Windows build impossible offline.

.PARAMETER TargetTriple
  Override the auto-detected Rust host triple.

.PARAMETER NodeBin
  Path to the node binary to base the SEA on (default: node on PATH).
#>
[CmdletBinding()]
param(
  [string]$TargetTriple = $env:TARGET_TRIPLE,
  [string]$NodeBin = $env:NODE_BIN
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")
$BinDir    = Join-Path $RepoRoot "apps\desktop\src-tauri\binaries"
$SeaDir    = Join-Path $BinDir ".sea"
$OrchDir   = Join-Path $RepoRoot "packages\node-orchestrator"

function Assert-NativeOk([string]$What) {
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)." }
}

function Resolve-Triple {
  if ($TargetTriple) { return $TargetTriple }
  if (Get-Command rustc -ErrorAction SilentlyContinue) {
    $line = (& rustc -Vv | Select-String '^host:').ToString()
    return ($line -replace '^host:\s*', '').Trim()
  }
  throw "rustc not found and TargetTriple not set."
}

$Triple = Resolve-Triple
if (-not $NodeBin) { $NodeBin = (Get-Command node).Source }

Write-Host "==> Building orchestrator sidecar (Node SEA)"
Write-Host "    node:   $NodeBin ($(& $NodeBin --version))"
Write-Host "    triple: $Triple"

# Start from an EMPTY scratch dir. Without this, a failed esbuild leaves the
# PREVIOUS build's orchestrator.cjs in place and step 3 happily turns that stale
# bundle into a blob -- shipping last week's orchestrator with no sign anything
# went wrong. ("a build succeeding != your change shipped".)
if (Test-Path $SeaDir) { Remove-Item -Recurse -Force $SeaDir }
New-Item -ItemType Directory -Force -Path $SeaDir | Out-Null

Write-Host "==> [1/4] pnpm build (orchestrator + deps)"
Push-Location $RepoRoot
try {
  & pnpm --filter '@videodubber/node-orchestrator...' build
  Assert-NativeOk "pnpm build"
} finally { Pop-Location }

Write-Host "==> [2/4] esbuild bundle -> orchestrator.cjs"
# Bundle orchestrator-entry.mjs (NOT dist/server.js): server.js only auto-starts
# behind an isMain() guard (`fileURLToPath(import.meta.url) === process.argv[1]`)
# that never fires inside a Node SEA binary, so bundling it directly yields an exe
# that exits without ever binding :5100. The entry shim calls startServer()
# unconditionally — must stay in lockstep with build-orchestrator.sh.
#
# Use the LOCKFILE-PINNED binaries from node_modules, never `npx --yes`. On
# Windows the .bin\*.cmd shims are the right entry point (unlike POSIX, where
# esbuild's postinstall swaps bin/esbuild for a native binary and pnpm's wrapper
# still node-launches it — see the comment in build-orchestrator.sh).
$Bundle     = Join-Path $SeaDir "orchestrator.cjs"
$EsbuildBin = Join-Path $RepoRoot "node_modules\.bin\esbuild.cmd"
$PostjectBin = Join-Path $RepoRoot "node_modules\.bin\postject.cmd"
foreach ($t in @(@{p=$EsbuildBin; n="esbuild"}, @{p=$PostjectBin; n="postject"})) {
  if (-not (Test-Path $t.p)) {
    throw ("{0} not found at {1}. Run 'pnpm install' at the repo root — this build deliberately does NOT fetch it from the registry." -f $t.n, $t.p)
  }
}
Push-Location $RepoRoot
try {
  & $EsbuildBin (Join-Path $ScriptDir "orchestrator-entry.mjs") `
    --bundle --platform=node --format=cjs --target=node20 `
    --outfile=$Bundle `
    --banner:js="// VideoDubber orchestrator - bundled for Node SEA. Do not edit."
  Assert-NativeOk "esbuild"
} finally { Pop-Location }
if (-not (Test-Path $Bundle)) { throw "esbuild reported success but $Bundle is missing." }

Write-Host "==> [3/4] node --experimental-sea-config -> orchestrator.blob"
Push-Location $RepoRoot
try {
  & $NodeBin --experimental-sea-config (Join-Path $ScriptDir "sea-config.json")
  Assert-NativeOk "node --experimental-sea-config"
} finally { Pop-Location }
$Blob = Join-Path $SeaDir "orchestrator.blob"
if (-not (Test-Path $Blob)) { throw "SEA config reported success but $Blob is missing." }

Write-Host "==> [4/4] inject blob into node.exe copy (postject)"
$Out = Join-Path $BinDir "videodubber-orchestrator-$Triple.exe"
Copy-Item -Force $NodeBin $Out
& $PostjectBin $Out NODE_SEA_BLOB $Blob `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
Assert-NativeOk "postject"

# Prove the injection actually happened. The output path exists either way (it is
# a copy of node.exe made one line above), so "the file is there" proves nothing —
# the blob makes it strictly larger than the interpreter it was copied from.
$outSize  = (Get-Item $Out).Length
$nodeSize = (Get-Item $NodeBin).Length
if ($outSize -le $nodeSize) {
  throw "postject left $Out the same size as node.exe ($outSize <= $nodeSize) — the SEA blob was not injected. This would ship a bare node.exe as the orchestrator."
}

Write-Host ""
Write-Host "==> Orchestrator sidecar built:"
Write-Host "    -> $Out ($([math]::Round($outSize / 1MB, 1)) MB, node.exe + $([math]::Round(($outSize - $nodeSize) / 1MB, 1)) MB SEA blob)"
