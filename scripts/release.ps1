#requires -Version 7.0
<#
.SYNOPSIS
  The Windows front door to cutting a release — or to checking, in seconds,
  whether you could.

.DESCRIPTION
  Windows twin of scripts/release.sh, and a thin wrapper over
  scripts\package\release-windows.ps1. It reimplements NOTHING about releasing:
  the build, the artifact verification, the draft upload and the latest.json
  merge (including the separate windows-x86_64-msi entry that MSI-installed users
  need) all live in release-windows.ps1 and stay there.

  WHY THIS EXISTS: the machinery has been complete for a long time, but nothing
  pointed at it. docs/RELEASING.md spells the incantation out across several
  sections, and it was re-derived from the doc every time — including the two
  things that must be true before the first line runs (the updater private key,
  and a GitHub token) and which release-windows.ps1 only discovers partway in.
  A Windows release build is long; finding out afterwards that the updater key
  was never copied from the Mac is the expensive way to learn it.

  So this adds exactly two things:
    1. one memorable entry point          pnpm release
    2. a preflight that fails in seconds  pnpm release -Check

  ABOUT SIGNING — READ THIS BEFORE "FIXING" IT. The Windows installer this
  produces is UNSIGNED, and that is a standing decision (2026-09-18,
  docs/RELEASING.md): this project has no Authenticode certificate and is not
  buying one. Every Windows artifact it has ever published is unsigned. First
  launch therefore shows SmartScreen ("More info -> Run anyway"), which README.md
  and docs/USER_GUIDE.md both tell users about, and auto-updates are unaffected
  (the updater verifies the Tauri .sig, not Authenticode). This script states
  that as a FACT, not as a warning, because a warning would send the next
  maintainer looking for a missing step that does not exist.

.PARAMETER Check
  Run the preflight gates and report readiness. Builds NOTHING.

.PARAMETER Sidecars
  Rebuild the bundled sidecars first (orchestrator SEA, frozen Python workers,
  vd-piper, static libass ffmpeg, vd-uv + CPython, engine-src). Forwarded to
  release-windows.ps1 as -Sidecars.

.PARAMETER Upload
  Upload the installers + sigs to the vX.Y.Z draft and merge latest.json.
  Forwarded to release-windows.ps1 as -Upload.

.PARAMETER Tag
  Release tag. Defaults to $env:RELEASE_TAG, else v<version from tauri.conf.json>.

.EXAMPLE
  pnpm release -Check
  Preflight only: version consistency, the Python suites (strictly), a clean
  tree, the updater key, a GitHub token. Nothing is built.

.EXAMPLE
  pnpm release -Sidecars -Upload
  The full local Windows release: sidecars, Tauri build, upload to the draft,
  merge both windows-x86_64 and windows-x86_64-msi into latest.json.
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Sidecars,
  [switch]$Upload,
  [string]$Tag,

  # run.mjs forwards argv verbatim to `pwsh -File`, and package.json defines
  # `release:check` as `node scripts/run.mjs release --check`. PowerShell's -File
  # mode does not recognise a GNU long flag as a parameter NAME, so `--check`
  # would bind POSITIONALLY — to $Tag, the only positional parameter here —
  # leaving $Check false. `pnpm release:check` would then not preflight at all:
  # it would attempt a FULL RELEASE tagged "--check". Swallow the remaining
  # arguments and translate them, exactly as scripts/bootstrap.ps1 does.
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest = @()
)

# --- Translate the GNU long flags ----------------------------------------------
# Normalise the leading dashes before matching: ValueFromRemainingArguments can
# hand a parameter-shaped token back as `--check`, `-check`, or with the dashes
# already eaten, depending on host and version. Matching on the bare word means
# every spelling works and none is silently ignored.
$unknownArgs = @()
foreach ($arg in $Rest) {
  $flag = $arg.ToLowerInvariant().TrimStart('-')
  if     ($flag -eq 'check')    { $Check    = $true }
  elseif ($flag -eq 'sidecars') { $Sidecars = $true }
  elseif ($flag -eq 'upload')   { $Upload   = $true }
  elseif ($flag -eq 'help' -or $flag -eq 'h') {
    Get-Help $PSCommandPath -Detailed
    exit 0
  }
  else { $unknownArgs += $arg }
}
if ($unknownArgs.Count -gt 0) {
  Write-Host "[release][error] unrecognised argument(s): $($unknownArgs -join ' ')" -ForegroundColor Red
  Write-Host "[release][error] usage: pnpm release [--check] [--sidecars] [--upload]" -ForegroundColor Red
  Write-Host "[release][error]        pwsh scripts\release.ps1 [-Check] [-Sidecars] [-Upload] [-Tag v1.2.3]" -ForegroundColor Red
  exit 2
}
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir '..')
Set-Location $RepoRoot

function Write-Info { param($m) Write-Host "[release] $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "[release] $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "[release][warn] $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "[release][error] $m" -ForegroundColor Red }

# --- Refuse to run on the wrong OS --------------------------------------------
# There is no cross-compilation here: the NSIS/WiX installers are produced by the
# Windows toolchain on the Windows desktop, and the macOS bundle must be signed
# by a Developer ID keychain identity and notarized by Apple from a Mac. Saying
# which script to run where is cheaper than letting a missing toolchain explain it.
if (-not $IsWindows) {
  $here = if ($IsMacOS) { 'macOS' } elseif ($IsLinux) { 'Linux' } else { 'this platform' }
  Write-Err "This is the Windows release script; you are on $here."
  if ($IsMacOS) {
    Write-Err "On macOS run:   pnpm release --check      (or: bash scripts/release.sh)"
  } else {
    Write-Err "Releases are cut on two machines only:"
    Write-Err "  macOS   -> bash scripts/release.sh   (on the Mac)"
    Write-Err "  Windows -> pwsh scripts\release.ps1  (this script, on the Windows desktop)"
    Write-Err "There is no Linux release target - see docs/RELEASING.md."
  }
  exit 1
}

# --- Version / tag -------------------------------------------------------------
$Conf = Join-Path $RepoRoot 'apps\desktop\src-tauri\tauri.conf.json'
$Version = (Get-Content $Conf -Raw | ConvertFrom-Json).version
if (-not $Version) { throw "Could not read the version from $Conf." }
if (-not $Tag) { $Tag = if ($env:RELEASE_TAG) { $env:RELEASE_TAG } else { "v$Version" } }

# --- Check accounting ----------------------------------------------------------
$script:ChecksFailed = 0
$script:ChecksWarned = 0

# Status is OK / WARN / MISSING, matching scripts/verify-environment.ts so the two
# readouts look like one tool rather than two.
function Write-Check {
  param([string]$Status, [string]$Name, [string]$Detail, [string]$Hint)
  $color = switch ($Status) {
    'OK'      { 'Green' }
    'WARN'    { $script:ChecksWarned++; 'Yellow' }
    'MISSING' { $script:ChecksFailed++; 'Red' }
    default   { 'Gray' }
  }
  Write-Host ('  ' + $Status.PadRight(7)) -ForegroundColor $color -NoNewline
  Write-Host ('  ' + $Name.PadRight(26) + ' ' + $Detail)
  if ($Hint) { Write-Host ((' ' * 11) + ''.PadRight(26) + ' -> ' + $Hint) -ForegroundColor DarkGray }
}

function Write-Detail { param([string]$Text)
  foreach ($line in ($Text -split "`r?`n")) { if ($line) { Write-Host ('            ' + $line) -ForegroundColor DarkGray } }
}

# --- Individual gates ----------------------------------------------------------

# 1. The four manifests + Cargo.lock must agree. A half-done bump is invisible
#    once the artifacts exist, and the updater compares against tauri.conf.json
#    alone - so the repo lies about itself and the next version bug is
#    mis-diagnosed. check-versions.mjs is the existing checker; don't re-derive it.
function Test-VersionConsistency {
  $out = & node (Join-Path $RepoRoot 'scripts\check-versions.mjs') 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) {
    Write-Check 'OK' 'version consistency' "all manifests at $Version"
  } else {
    Write-Check 'MISSING' 'version consistency' 'manifests disagree' "node scripts\check-versions.mjs --set $Version"
    Write-Detail $out
  }
}

# 2. The Python suites. -RequireAll IS THE POINT: without it test-workers.ps1
#    reports "skipped" and exits 0 on a machine with no worker venvs - i.e. the
#    release gate passes having run nothing at all, which is strictly worse than
#    no gate because it reads green. A release box must be able to run them.
function Test-WorkerSuites {
  $tw = Join-Path $RepoRoot 'scripts\test-workers.ps1'
  # Spawned, not in-process: test-workers.ps1 deliberately relaxes
  # $ErrorActionPreference around its native calls and calls `exit` on failure;
  # keeping it in its own process keeps both out of this script's state.
  $out = & pwsh -NoProfile -File $tw -RequireAll 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) {
    $last = ($out -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 1)
    Write-Check 'OK' 'python worker suites' $last
  } else {
    Write-Check 'MISSING' 'python worker suites' 'suite failed or could not run' 'pwsh scripts\setup-local-models.ps1   # creates the per-worker venvs'
    Write-Detail $out
  }
}

# 3. A dirty tree means the artifacts you are about to ship do not correspond to
#    any commit, so "which build is this?" has no answer afterwards - and the
#    version bump in step 1 of the runbook is exactly the change people forget to
#    commit before building. $env:ALLOW_DIRTY=1 is the escape hatch for a
#    deliberate local-only experiment; it is a warning then, not a pass.
function Test-GitClean {
  # Probe with Get-Command first: $ErrorActionPreference='Stop' turns a missing
  # native command into a terminating CommandNotFoundException, so the tidy
  # "could not run git status" branch below would never be reached - the whole
  # preflight would die instead, on the one check that is meant to be advisory.
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Check 'WARN' 'git tree' 'git is not on PATH' 'winget install --id Git.Git -e'
    return
  }
  $dirty = (& git -C $RepoRoot status --porcelain 2>$null) | Where-Object { $_ }
  if ($LASTEXITCODE -ne 0) {
    Write-Check 'WARN' 'git tree' 'could not run git status' 'is this a git checkout?'
    return
  }
  if (-not $dirty) {
    $sha = (& git -C $RepoRoot rev-parse --short HEAD 2>$null)
    Write-Check 'OK' 'git tree' "clean at $sha"
  } elseif ($env:ALLOW_DIRTY -eq '1') {
    Write-Check 'WARN' 'git tree' "$($dirty.Count) uncommitted change(s), ALLOW_DIRTY=1" 'the build will not correspond to any commit'
  } else {
    Write-Check 'MISSING' 'git tree' "$($dirty.Count) uncommitted change(s)" 'commit or stash them, or set $env:ALLOW_DIRTY=1'
    Write-Detail (($dirty | Select-Object -First 10) -join "`n")
  }
}

# 4. The updater private key. Without it `tauri build` produces no .sig, which
#    means the auto-updater can never install this build and every existing user
#    is stranded on the version they have. On Windows the key is COPIED from the
#    Mac - it is not generated here - so its absence is the single most likely
#    thing to be missing on a fresh Windows release box.
function Test-UpdaterKey {
  if ($env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-Check 'OK' 'updater signing key' 'TAURI_SIGNING_PRIVATE_KEY is set'
    return
  }
  $keyPath = Join-Path $HOME '.tauri\videodubber.key'
  if (Test-Path $keyPath) {
    Write-Check 'OK' 'updater signing key' $keyPath
  } else {
    Write-Check 'MISSING' 'updater signing key' "no key in env or $keyPath" `
      'copy ~/.tauri/videodubber.key from the Mac (SECURELY - it is a SECRET)'
  }
}

# 5. A GitHub token, found the same way release-upload.ps1 finds one: $env:GH_TOKEN,
#    else the OAuth token `git credential` already holds (no `gh` CLI here). Only
#    -Upload needs it, so it is a warning otherwise - but still worth reporting,
#    because discovering it at upload time is discovering it after a long build.
function Test-GitHubToken {
  if ($env:GH_TOKEN) { Write-Check 'OK' 'github token' 'GH_TOKEN is set'; return }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Check 'WARN' 'github token' 'cannot check - git is not on PATH' 'set $env:GH_TOKEN, or install git'
    return
  }
  # GIT_TERMINAL_PROMPT=0 so a machine with no credential helper fails fast
  # instead of blocking a "preflight" on a username prompt.
  $prev = $env:GIT_TERMINAL_PROMPT
  $env:GIT_TERMINAL_PROMPT = '0'
  try {
    $out = "protocol=https`nhost=github.com`n`n" | & git credential fill 2>$null
  } catch {
    $out = $null
  } finally {
    $env:GIT_TERMINAL_PROMPT = $prev
  }
  $line = $out | Select-String '^password=' | Select-Object -First 1
  if ($line) {
    Write-Check 'OK' 'github token' 'from git credential (github.com)'
  } elseif ($Upload) {
    Write-Check 'MISSING' 'github token' 'none available, and -Upload was requested' `
      '$env:GH_TOKEN = "…", or log in so git credential has one'
  } else {
    Write-Check 'WARN' 'github token' 'none available (only needed for -Upload)' `
      '$env:GH_TOKEN = "…", or log in so git credential has one'
  }
}

# 6. The toolchain the build actually shells out to. Cheap to look for, and each
#    one's absence surfaces deep inside a build log as something else's error.
#    WiX is deliberately NOT fatal: the .msi is optional (a missing one is a
#    warning in release-windows.ps1 too), but v0.1.0+v0.2.0 alone have 26 MSI
#    downloads, so shipping without it strands a real population on an elevated
#    msiexec uninstall mid-update.
function Test-Tool {
  param([string]$Name, [string]$Bin, [string]$Hint, [switch]$Optional)
  $cmd = Get-Command $Bin -ErrorAction SilentlyContinue
  if ($cmd) {
    Write-Check 'OK' $Name $cmd.Source
  } elseif ($Optional) {
    Write-Check 'WARN' $Name 'not on PATH' $Hint
  } else {
    Write-Check 'MISSING' $Name 'not on PATH' $Hint
  }
}

function Invoke-Preflight {
  param([switch]$EnvironmentOnly)
  Write-Host ''
  Write-Host "  VideoDubber - release preflight  (Windows, $Version -> $Tag)" -ForegroundColor Cyan
  Write-Host ('  ' + ('-' * 70)) -ForegroundColor DarkGray
  if (-not $EnvironmentOnly) {
    Test-Tool 'node'  'node'  'winget install --id OpenJS.NodeJS.LTS -e'
    Test-Tool 'pnpm'  'pnpm'  'corepack enable; corepack prepare pnpm@latest --activate'
    Test-Tool 'cargo' 'cargo' 'install Rust (MSVC toolchain): https://rustup.rs'
    Test-Tool 'WiX (candle.exe, for the .msi)' 'candle' 'see docs/WINDOWS.md - the .msi is optional but 26 users have one' -Optional
    Test-VersionConsistency
    Test-WorkerSuites
  }
  Test-GitClean
  Test-UpdaterKey
  Test-GitHubToken
  Write-Host ('  ' + ('-' * 70)) -ForegroundColor DarkGray
  Write-Host "  Summary: $script:ChecksWarned warning(s), $script:ChecksFailed blocking"
  Write-Host ''
  # Not a check: a statement of fact, so nobody goes looking for the missing step.
  Write-Host '  Code signing: the Windows installer is UNSIGNED by standing decision' -ForegroundColor Gray
  Write-Host '  (2026-09-18, docs/RELEASING.md). There is no Authenticode certificate and' -ForegroundColor Gray
  Write-Host '  none is being bought. First launch shows SmartScreen ("More info -> Run' -ForegroundColor Gray
  Write-Host '  anyway"), which README.md and docs/USER_GUIDE.md already document, and' -ForegroundColor Gray
  Write-Host '  auto-update is unaffected (it verifies the Tauri .sig, not Authenticode).' -ForegroundColor Gray
  Write-Host ''
}

# --- Main ----------------------------------------------------------------------
if ($Check) {
  Invoke-Preflight
  if ($script:ChecksFailed -gt 0) {
    Write-Err "NOT ready to release: $script:ChecksFailed blocking item(s) above."
    Write-Err 'Nothing was built. Fix those, then re-run: pnpm release -Check'
    exit 1
  }
  Write-Ok "Ready to release $Tag."
  Write-Host ''
  Write-Info 'Next:  pwsh scripts\release.ps1 -Sidecars -Upload'
  Write-Info '       (or: pnpm release -Sidecars -Upload)'
  Write-Info 'Then finish the runbook in docs/RELEASING.md - the draft still needs the'
  Write-Info 'macOS half uploaded and the release published by hand.'
  exit 0
}

# Real build. Run only the gates release-windows.ps1 does NOT already run - it
# owns the version check and the worker suites itself, and running pytest twice
# for the same release buys nothing. $env:REQUIRE_ALL is set instead, so its own
# test-workers.ps1 call inherits the strict behaviour (the switch defaults to
# `$env:REQUIRE_ALL -eq '1'`): the skip-and-pass hole is closed without this
# wrapper duplicating the gate.
$env:REQUIRE_ALL = '1'

Invoke-Preflight -EnvironmentOnly
if ($script:ChecksFailed -gt 0) {
  Write-Err "$script:ChecksFailed blocking item(s) above - stopping BEFORE the build."
  Write-Err 'Full preflight (adds the version + pytest gates): pnpm release -Check'
  exit 1
}

Write-Info "Windows release $Version -> tag $Tag"
if ($Sidecars) { Write-Info '  sidecars: WILL be rebuilt (-Sidecars)' }
else           { Write-Info '  sidecars: reusing whatever is already staged (pass -Sidecars to rebuild)' }
if ($Upload)   { Write-Info "  upload:   WILL upload to the $Tag draft and merge latest.json (-Upload)" }
else           { Write-Info '  upload:   no (pass -Upload to publish to the draft)' }
Write-Host ''

# Hand off. Everything below this line is release-windows.ps1's job; this script
# deliberately knows nothing about artifact paths, the NSIS/MSI split or latest.json.
$inner = @{}
if ($Sidecars) { $inner['Sidecars'] = $true }
if ($Upload)   { $inner['Upload']   = $true }
$inner['Tag'] = $Tag
Write-Info '==> scripts\package\release-windows.ps1'
# Reset first: $LASTEXITCODE is sticky, so without this the check below could
# fail a perfectly good release on the exit code of some earlier native call.
$global:LASTEXITCODE = 0
# In-process with `&` so the [switch]/[string] parameters bind as parameters
# rather than being flattened into a child pwsh's command line and re-parsed -
# the same trap release-windows.ps1 documents around its own release-upload.ps1
# call. release-windows.ps1 sets $ErrorActionPreference='Stop' and throws on a
# bad $LASTEXITCODE, so a failure propagates out of here.
& (Join-Path $ScriptDir 'package\release-windows.ps1') @inner
if ($LASTEXITCODE -ne 0) { throw "release-windows.ps1 failed ($LASTEXITCODE)" }

Write-Host ''
if ($Upload) { Write-Ok "Windows release $Tag built and uploaded to the draft." }
else         { Write-Ok "Windows release $Tag built (not uploaded)." }
Write-Info 'Remaining runbook steps (docs/RELEASING.md): build + upload the macOS half'
Write-Info 'on the Mac, confirm latest.json carries BOTH platforms, then publish the'
Write-Info "$Tag draft on GitHub."
