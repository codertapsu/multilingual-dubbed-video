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
New-Item -ItemType Directory -Force -Path $SeaDir | Out-Null

Write-Host "==> [1/4] pnpm build (orchestrator + deps)"
Push-Location $RepoRoot
try { & pnpm --filter '@videodubber/node-orchestrator...' build } finally { Pop-Location }

Write-Host "==> [2/4] esbuild bundle -> orchestrator.cjs"
$Bundle = Join-Path $SeaDir "orchestrator.cjs"
Push-Location $RepoRoot
try {
  & npx --yes esbuild (Join-Path $OrchDir "dist\server.js") `
    --bundle --platform=node --format=cjs --target=node20 `
    --outfile=$Bundle `
    --banner:js="// VideoDubber orchestrator - bundled for Node SEA. Do not edit."
} finally { Pop-Location }

Write-Host "==> [3/4] node --experimental-sea-config -> orchestrator.blob"
Push-Location $RepoRoot
try { & $NodeBin --experimental-sea-config (Join-Path $ScriptDir "sea-config.json") } finally { Pop-Location }

Write-Host "==> [4/4] inject blob into node.exe copy (postject)"
$Out = Join-Path $BinDir "videodubber-orchestrator-$Triple.exe"
Copy-Item -Force $NodeBin $Out
& npx --yes postject $Out NODE_SEA_BLOB (Join-Path $SeaDir "orchestrator.blob") `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

Write-Host ""
Write-Host "==> Orchestrator sidecar built:"
Write-Host "    -> $Out"
