#requires -Version 7.0
<#
.SYNOPSIS
  One-command LOCAL Windows release: build sidecars + installers, then upload
  them and merge the updater manifest onto the GitHub draft — no CI.

.DESCRIPTION
  Windows counterpart of scripts/package/release-macos.sh, for building releases
  on the Windows desktop instead of GitHub Actions (repo var RELEASE_CI_WINDOWS
  stays "false"). Run from a pwsh 7 prompt in the repo root
  (e.g. D:\development\projects\multilingual-dubbed-video):

    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content ~\.tauri\videodubber.key -Raw
    pwsh scripts/package/release-windows.ps1 -Sidecars -Upload

  What it does:
    1. (-Sidecars) pwsh scripts/package/build-sidecars.ps1 — orchestrator SEA,
       PyInstaller workers, vd-piper, static libass ffmpeg (auto-downloads the
       BtbN win64-gpl build; do NOT point FFMPEG_PATH at a *shared* ffmpeg),
       vd-uv + bundled CPython, engine-src.
    2. pnpm app:build — Tauri build. TAURI_SIGNING_PRIVATE_KEY must be set so the
       NSIS -setup.exe gets an updater signature (.sig). The key password is
       empty -> TAURI_SIGNING_PRIVATE_KEY_PASSWORD defaults to ''. bundle.targets
       is ["app","dmg","nsis"], so Windows produces the NSIS -setup.exe (no MSI;
       the .exe is a complete installer and is what auto-update uses).
    3. Verifies the required artifacts: -setup.exe + its .sig. (An MSI is uploaded
       too if you re-enable the msi target and it builds; otherwise skipped.)
    4. (-Upload) uploads them to the vX.Y.Z DRAFT (release-upload.ps1) and merges
       the windows-x86_64 entry into latest.json (merge-latest-json.mjs,
       preserving the mac entry if the Mac already merged its side).

  Prereqs (one-time, see docs/RELEASING.md "Windows — on your Windows desktop"):
  pwsh 7, Node 24 + corepack/pnpm, Rust stable (MSVC), Python 3.12 with the
  three worker venvs (scripts/setup-local-models.ps1), the updater private key,
  and a GitHub token (git credential or $env:GH_TOKEN).

.PARAMETER Sidecars
  (Re)build the bundled sidecars first (build-sidecars.ps1).

.PARAMETER Upload
  Upload installers + sigs to the draft release and merge latest.json.

.PARAMETER Tag
  Release tag. Defaults to $env:RELEASE_TAG, else v<version from tauri.conf.json>.
#>
[CmdletBinding()]
param(
  [switch]$Sidecars,
  [switch]$Upload,
  [string]$Tag
)
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir '..\..')
Set-Location $RepoRoot

# --- updater signing key (required: without it there are NO .sig files and the
# --- auto-updater can never install this build) --------------------------------
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
  $keyPath = Join-Path $HOME '.tauri\videodubber.key'
  if (Test-Path $keyPath) {
    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
    Write-Host "==> TAURI_SIGNING_PRIVATE_KEY loaded from $keyPath"
  } else {
    throw ("TAURI_SIGNING_PRIVATE_KEY is not set and $keyPath does not exist. " +
      "Copy the updater private key from the Mac (~/.tauri/videodubber.key) to this machine " +
      "(securely - it is a SECRET), or set the env var to the key's contents. See docs/RELEASING.md.")
  }
}
if ($null -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''   # the videodubber.key password is empty
}

# --- resolve tag/version -------------------------------------------------------
$conf = Get-Content 'apps/desktop/src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json
$Version = $conf.version
if (-not $Tag) { $Tag = if ($env:RELEASE_TAG) { $env:RELEASE_TAG } else { "v$Version" } }
Write-Host "==> Windows local release: version $Version, tag $Tag"

if ($Sidecars) {
  Write-Host "==> build sidecars (orchestrator + workers + piper + static ffmpeg + uv + python)"
  pwsh (Join-Path $ScriptDir 'build-sidecars.ps1')
  if ($LASTEXITCODE -ne 0) { throw "build-sidecars.ps1 failed ($LASTEXITCODE)" }
}

Write-Host '==> build the app (tauri build; emits the NSIS -setup.exe + its updater .sig)'
pnpm app:build
if ($LASTEXITCODE -ne 0) { throw "pnpm app:build failed ($LASTEXITCODE)" }

# --- locate + verify the artifacts ----------------------------------------------
# The NSIS -setup.exe is REQUIRED (it's what the auto-updater installs). The MSI is
# OPTIONAL: it only builds when the WiX toolset is available and succeeds on the
# large bundle, so a missing MSI is a warning, not a failure.
$bundle = 'apps/desktop/src-tauri/target/release/bundle'
$setup = Get-ChildItem "$bundle/nsis" -Filter "VideoDubber_${Version}_x64-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$msi   = Get-ChildItem "$bundle/msi"  -Filter "VideoDubber_${Version}_x64_en-US.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $setup) { throw "NSIS installer not found under $bundle/nsis (did `tauri build` finish?)." }
if (-not (Test-Path "$($setup.FullName).sig")) {
  throw ("missing updater signature $($setup.Name).sig - tauri build ran without a usable " +
    'TAURI_SIGNING_PRIVATE_KEY. Fix the key and rebuild.')
}

# Files to upload: always the NSIS pair; add the MSI pair only if it built (+ signed).
$uploads = @($setup.FullName, "$($setup.FullName).sig")
Write-Host "==> artifacts:"
Write-Host "    $($setup.Name) (+ .sig)"
if ($msi -and (Test-Path "$($msi.FullName).sig")) {
  $uploads += @($msi.FullName, "$($msi.FullName).sig")
  Write-Host "    $($msi.Name) (+ .sig)"
} elseif ($msi) {
  Write-Warning "MSI built but its .sig is missing - skipping the MSI upload."
} else {
  Write-Host "    (no .msi - not built; ships the NSIS -setup.exe only, which is what auto-update uses)"
}

if ($Upload) {
  Write-Host "==> upload installers + sigs to the $Tag draft"
  $env:RELEASE_TAG = $Tag
  pwsh (Join-Path $ScriptDir 'release-upload.ps1') -Upload $uploads
  if ($LASTEXITCODE -ne 0) { throw "release-upload.ps1 failed ($LASTEXITCODE)" }

  Write-Host '==> merge the windows-x86_64 entry into latest.json (preserves the mac entry)'
  node (Join-Path $ScriptDir 'merge-latest-json.mjs') --tag $Tag --platform windows-x86_64 --artifact $setup.FullName --fix-tag
  if ($LASTEXITCODE -ne 0) { throw "merge-latest-json.mjs failed ($LASTEXITCODE)" }
}

Write-Host ''
Write-Host 'Windows release build complete.'
if (-not $Upload) {
  Write-Host "  next: re-run with -Upload, or upload manually via release-upload.ps1 + merge-latest-json.mjs"
}
Write-Host "  publish checklist: mac assets uploaded too -> latest.json has BOTH platforms -> draft tag is $Tag -> publish on GitHub."
