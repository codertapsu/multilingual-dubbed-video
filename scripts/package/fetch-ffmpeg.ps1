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
  # SHARED-build trap: only the exe is staged as a Tauri sidecar, so a *shared*
  # distribution (ffmpeg.exe + avcodec-*.dll etc., e.g. gyan.dev
  # ffmpeg-release-full-SHARED) passes the libass check here (its DLLs sit next
  # to the ORIGINAL exe) but breaks inside the installed app, where the DLLs
  # don't exist. Require a static single-file build.
  $ffDlls = Get-ChildItem -Path (Split-Path $LocalFfmpeg -Parent) -Filter 'av*.dll' -ErrorAction SilentlyContinue
  if ($ffDlls) {
    throw ("local ffmpeg at $LocalFfmpeg is a SHARED build (found $($ffDlls[0].Name) beside it) - " +
      "the bundled sidecar ships the exe ALONE, so a shared build breaks at app runtime. " +
      "Use a STATIC single-file build (e.g. BtbN win64-gpl), or unset FFMPEG_PATH/FFPROBE_PATH " +
      "to let this script auto-download one.")
  }
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
#
# Resolve a PERMANENT dated-autobuild asset via the GitHub API instead of any
# "latest" URL. BtbN's rolling `latest`-tagged release DELETES + re-uploads its
# `ffmpeg-master-latest-*` assets on every rebuild (~hourly), so BOTH
# releases/latest/download/ and releases/download/latest/ 404 during that window
# (each broke a Windows release build). The dated `autobuild-YYYY-MM-DD-*`
# releases are immutable once published, so we pick the newest one that has a
# win64-gpl (non-shared) asset and download it by its permanent URL.
if (-not $FfmpegUrl) {
  $headers = @{ 'User-Agent' = 'videodubber-ci'; 'Accept' = 'application/vnd.github+json' }
  if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
  $releases = Invoke-RestMethod -Uri 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=15' -Headers $headers
  foreach ($rel in $releases) {
    if (-not $rel.tag_name.StartsWith('autobuild-')) { continue }  # skip the rolling `latest`
    $asset = $rel.assets | Where-Object { $_.name -match 'win64-gpl\.zip$' -and $_.name -notmatch 'shared' } | Select-Object -First 1
    if ($asset) { $FfmpegUrl = $asset.browser_download_url; break }
  }
  if (-not $FfmpegUrl) { throw 'fetch-ffmpeg: could not resolve a BtbN win64-gpl asset from the GitHub API.' }
}

$Zip = Join-Path $Work "ffmpeg.zip"
Write-Host "==> Downloading $FfmpegUrl"
Invoke-WebRequest -Uri $FfmpegUrl -OutFile $Zip -UseBasicParsing -MaximumRetryCount 3 -RetryIntervalSec 5
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
