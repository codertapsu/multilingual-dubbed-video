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
  [switch]$SkipFfmpeg
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")
$BinDir    = Join-Path $RepoRoot "apps\desktop\src-tauri\binaries"

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
if (-not $SkipFfmpeg) {
  Write-Host "`n### FFmpeg / ffprobe #######################################"
  & (Join-Path $ScriptDir "fetch-ffmpeg.ps1") -TargetTriple $Triple
}

Write-Host "`n############################################################"
Write-Host "# Done. Sidecars in $BinDir :"
Write-Host "############################################################"
$bases = @("videodubber-orchestrator","vd-stt-worker","vd-translation-worker","vd-tts-worker","vd-piper","ffmpeg","ffprobe")
foreach ($b in $bases) {
  $f = Join-Path $BinDir "$b-$Triple.exe"
  if (Test-Path $f) { Write-Host "    $b-$Triple.exe" }
  else { Write-Host "NOTE: missing $f (skipped or failed?)." }
}
