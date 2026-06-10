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

# gyan.dev publishes a .zip (essentials/full) and a .7z (full). The .zip needs no
# extra tool on Windows (Expand-Archive). The "release-full" zip includes libass.
if (-not $FfmpegUrl) {
  $FfmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.zip"
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
