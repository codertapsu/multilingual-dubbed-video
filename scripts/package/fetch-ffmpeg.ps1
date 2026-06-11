#requires -Version 5.1
<#
.SYNOPSIS
  Fetch a static, libass-enabled ffmpeg + ffprobe and stage them as Tauri
  externalBin sidecars on Windows.

.DESCRIPTION
  Windows counterpart of scripts/package/fetch-ffmpeg.sh. Downloads the gyan.dev
  "release-full" build (which includes libass, hence the `subtitles` filter for
  burned-in subtitles), extracts ffmpeg.exe/ffprobe.exe, verifies the subtitles
  filter, and stages them as:
      apps/desktop/src-tauri/binaries/ffmpeg-<triple>.exe
      apps/desktop/src-tauri/binaries/ffprobe-<triple>.exe

.PARAMETER TargetTriple
  Override the auto-detected Rust host triple.

.PARAMETER FfmpegUrl
  Direct URL to a zip containing bin\ffmpeg.exe and bin\ffprobe.exe.
#>
[CmdletBinding()]
param(
  [string]$TargetTriple = $env:TARGET_TRIPLE,
  [string]$FfmpegUrl = $env:FFMPEG_URL
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")
$BinDir    = Join-Path $RepoRoot "apps\desktop\src-tauri\binaries"
$Work      = Join-Path $BinDir ".ffmpeg"

# Load .env (when run standalone) so the local-copy mode below can find a
# libass-enabled ffmpeg via FFMPEG_PATH/FFPROBE_PATH instead of downloading.
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
Write-Host "==> Fetching libass-enabled ffmpeg/ffprobe"
Write-Host "    triple: $Triple"
New-Item -ItemType Directory -Force -Path $BinDir, $Work | Out-Null
Get-ChildItem $Work -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force

# Local-copy mode: stage an existing libass-enabled ffmpeg/ffprobe instead of
# downloading (handy for local builds). Set FFMPEG_BIN+FFPROBE_BIN, or
# FFMPEG_PATH+FFPROBE_PATH (e.g. in .env). Verified for the subtitles filter below.
$LocalFfmpeg  = if ($env:FFMPEG_BIN)  { $env:FFMPEG_BIN }  else { $env:FFMPEG_PATH }
$LocalFfprobe = if ($env:FFPROBE_BIN) { $env:FFPROBE_BIN } else { $env:FFPROBE_PATH }
if ($LocalFfmpeg -and $LocalFfprobe -and (Test-Path $LocalFfmpeg) -and (Test-Path $LocalFfprobe)) {
  Write-Host "==> Staging ffmpeg/ffprobe from local paths (not portable - local build only)."
  $filters = & $LocalFfmpeg -hide_banner -filters 2>$null
  if (-not ($filters -match '\bsubtitles\b')) {
    throw "local ffmpeg is missing the 'subtitles' filter (no libass). Use a full/gpl build."
  }
  Write-Host "    libass OK."
  Copy-Item -Force $LocalFfmpeg  (Join-Path $BinDir "ffmpeg-$Triple.exe")
  Copy-Item -Force $LocalFfprobe (Join-Path $BinDir "ffprobe-$Triple.exe")
  Write-Host ""
  Write-Host "==> ffmpeg sidecars staged:"
  Get-ChildItem $BinDir -Filter "ff*-$Triple.exe" | ForEach-Object { Write-Host "    $($_.Name)" }
  exit 0
}

# BtbN GitHub builds: GitHub-hosted (reliable from CI), a .zip Expand-Archive can
# open with no extra tool, and a -gpl build that includes libass (subtitles) plus
# libx264/x265. NOTE: gyan.dev ships the *full* build only as .7z — its *.zip is
# 'essentials', so the previously-used ffmpeg-release-full.zip URL is a 404.
if (-not $FfmpegUrl) {
  $FfmpegUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip"
}

$Zip = Join-Path $Work "ffmpeg.zip"
Write-Host "==> Downloading $FfmpegUrl"
Invoke-WebRequest -Uri $FfmpegUrl -OutFile $Zip -UseBasicParsing
Write-Host "==> Extracting..."
Expand-Archive -Path $Zip -DestinationPath (Join-Path $Work "ff") -Force

$dir = Get-ChildItem (Join-Path $Work "ff") -Directory | Where-Object { $_.Name -like "ffmpeg-*" } | Select-Object -First 1
$ffmpegSrc  = Join-Path $dir.FullName "bin\ffmpeg.exe"
$ffprobeSrc = Join-Path $dir.FullName "bin\ffprobe.exe"

if (-not (Test-Path $ffmpegSrc) -or -not (Test-Path $ffprobeSrc)) {
  throw "ffmpeg.exe/ffprobe.exe not found under $($dir.FullName)\bin"
}

Write-Host "==> Verifying libass (subtitles filter)..."
$filters = & $ffmpegSrc -hide_banner -filters 2>$null
if (-not ($filters -match '\bsubtitles\b')) {
  throw "this ffmpeg build is missing the 'subtitles' filter (no libass). Use a full/gpl build."
}
Write-Host "    libass OK."

Copy-Item -Force $ffmpegSrc  (Join-Path $BinDir "ffmpeg-$Triple.exe")
Copy-Item -Force $ffprobeSrc (Join-Path $BinDir "ffprobe-$Triple.exe")

Write-Host ""
Write-Host "==> ffmpeg sidecars staged:"
Get-ChildItem $BinDir -Filter "ff*-$Triple.exe" | ForEach-Object { Write-Host "    $($_.Name)" }
