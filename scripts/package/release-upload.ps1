#requires -Version 5.1
<#
.SYNOPSIS
  Local-first release helper (Windows): ensure the DRAFT GitHub release exists
  and upload locally-built installers to it, WITHOUT running CI.

.DESCRIPTION
  Windows counterpart of scripts/package/release-upload.sh. Pairs with a local
  build so cutting a release doesn't burn (10x-billed) macOS Actions minutes:
    pnpm install --frozen-lockfile
    pwsh scripts/package/build-sidecars.ps1
    pnpm app:build
    pwsh scripts/package/release-upload.ps1 -Upload `
      apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe `
      apps/desktop/src-tauri/target/release/bundle/msi/*_en-US.msi

  Auth: the GitHub OAuth token from `git credential` (no `gh` CLI), or $env:GH_TOKEN.
  Repo/tag default to this project; override with $env:GH_REPO / $env:RELEASE_TAG.

.PARAMETER Ensure
  Only ensure the draft exists and print its id (no upload).

.PARAMETER Upload
  One or more files (globs allowed) to upload, replacing same-named assets.
#>
[CmdletBinding()]
param(
  [switch]$Ensure,
  [Parameter(ValueFromRemainingArguments = $true)] [string[]]$Upload
)
$ErrorActionPreference = 'Stop'

$Tag  = if ($env:RELEASE_TAG) { $env:RELEASE_TAG } else { 'v0.1.0' }
$Repo = if ($env:GH_REPO)     { $env:GH_REPO }     else { 'codertapsu/multilingual-dubbed-video' }

function Get-GhToken {
  if ($env:GH_TOKEN) { return $env:GH_TOKEN }
  $out = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
  $line = ($out | Select-String '^password=' | Select-Object -First 1)
  if ($line) { return ($line.Line -replace '^password=', '') }
  return $null
}

$Token = Get-GhToken
if (-not $Token) { throw "No GitHub token (set `$env:GH_TOKEN or log in so 'git credential' has one)." }
$Headers = @{ Authorization = "Bearer $Token"; Accept = 'application/vnd.github+json' }

function Ensure-Release {
  $rels = Invoke-RestMethod -Headers $Headers "https://api.github.com/repos/$Repo/releases?per_page=100"
  $r = $rels | Where-Object { $_.tag_name -eq $Tag } | Select-Object -First 1
  if ($r) { return $r.id }
  $body = @{ tag_name = $Tag; name = "VideoDubber $Tag"; draft = $true; prerelease = $false } | ConvertTo-Json
  $created = Invoke-RestMethod -Method Post -Headers $Headers -ContentType 'application/json' -Body $body `
    "https://api.github.com/repos/$Repo/releases"
  Write-Host "created draft release $Tag (id $($created.id))"
  return $created.id
}

function Upload-Asset($rid, $file) {
  $name = Split-Path $file -Leaf
  $assets = Invoke-RestMethod -Headers $Headers "https://api.github.com/repos/$Repo/releases/$rid/assets?per_page=100"
  $existing = $assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
  if ($existing) {
    Invoke-RestMethod -Method Delete -Headers $Headers "https://api.github.com/repos/$Repo/releases/assets/$($existing.id)" | Out-Null
  }
  $url = "https://uploads.github.com/repos/$Repo/releases/$rid/assets?name=$name"
  Invoke-RestMethod -Method Post -Headers $Headers -ContentType 'application/octet-stream' -InFile $file $url | Out-Null
  $mb = [math]::Round((Get-Item $file).Length / 1MB, 1)
  Write-Host "  uploaded $name (${mb} MB)"
}

$rid = Ensure-Release
Write-Host "release $Tag -> id $rid"
if ($Ensure -and (-not $Upload)) { Write-Output $rid; return }

$files = @()
foreach ($p in $Upload) { $files += @(Get-ChildItem -Path $p -File -ErrorAction SilentlyContinue) }
if (-not $files) { Write-Warning 'No files matched to upload.'; return }
foreach ($f in $files) { Upload-Asset $rid $f.FullName }
Write-Host "done. Review/publish the draft: https://github.com/$Repo/releases"
