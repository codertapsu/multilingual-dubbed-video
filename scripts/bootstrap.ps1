#requires -Version 7.0
<#
.SYNOPSIS
    One-command onboarding for VideoDubber on Windows: check prerequisites,
    install workspace dependencies, build the libraries, set up the Python
    workers and models, then verify the result.

.DESCRIPTION
    Windows twin of scripts\bootstrap.sh. Both halves are written from one shared
    spec and MUST agree on phase order, phase names, flag names, env-var names,
    exit codes and the shape of the final summary - a reviewer diffs the two for
    drift, so prefer "boring and identical" over "clever and local".

    Invoked as:   pnpm bootstrap   ->   node scripts\run.mjs bootstrap   ->   this

    WHY THIS EXISTS: until 2026-09 nothing in this repo checked or guided
    prerequisites at all - a repo-wide grep for brew/winget/apt/rustup in
    scripts\ returned nothing - and six pnpm tasks were bash-only, so a Windows
    contributor could not run the documented commands at all (scripts\run.mjs
    fixed the routing; this fixes the "what do I need first" half). The recurring
    first-hour failures were: the wrong Python (a 3.13 venv is what shipped macOS
    workers that only ran on macOS 26), Node too old for the Angular 22 toolchain,
    and `pnpm dev` failing to resolve @videodubber/shared because `pnpm build`
    had never run and that package is consumed from dist\.

    WHAT IT DELIBERATELY WILL NOT DO: install anything, elevate, or edit your
    PATH. Every miss is reported with the exact winget/corepack command to run,
    and then the script stops. Installing Visual Studio Build Tools or rewriting
    someone's PATH behind their back is not acceptable in an onboarding script.

    Phases, each with a numbered banner:
      1. PREREQUISITES                 check only, never install
      2. WORKSPACE DEPENDENCIES        corepack enable + pnpm install
      3. BUILD THE WORKSPACE LIBRARIES pnpm build
      4. PYTHON WORKERS + MODELS       delegates to scripts\setup-local-models.ps1
      5. VERIFY                        pnpm verify (scripts\verify-environment.ts)

    Idempotent: every phase is safe to re-run, and re-running after fixing one
    prerequisite is the intended workflow.

.PARAMETER SkipDeps
    Skip phase 2 (corepack enable + pnpm install). Env var: SKIP_DEPS=1.

.PARAMETER SkipBuild
    Skip phase 3 (pnpm build). Env var: SKIP_BUILD=1.

.PARAMETER SkipPython
    Skip phase 4 entirely (no venvs, no models). Env var: SKIP_PYTHON=1.

.PARAMETER SkipModels
    Run phase 4 but create only the venvs - no model downloads. Forwarded to
    setup-local-models.ps1, which already understands it. Env var: SKIP_MODELS=1.

.PARAMETER Strict
    Treat OPTIONAL prerequisite misses (Rust, ffmpeg) as failures too.
    Env var: STRICT=1.

.PARAMETER Help
    Print usage and exit 0. The GNU spellings --help and -h also work.

.EXAMPLE
    pnpm bootstrap

.EXAMPLE
    pnpm bootstrap --skip-python

.EXAMPLE
    pwsh scripts\bootstrap.ps1 -SkipModels -Strict

.NOTES
    Exit codes:
      0  success (warnings allowed)
      1  a REQUIRED prerequisite is missing
      2  a phase command failed (or the arguments were unusable)

    The GNU-style long flags (--skip-deps, --skip-build, --skip-python,
    --skip-models, --strict) are accepted as well as the PowerShell switches, so
    that one documented command line works on both operating systems.
#>
[CmdletBinding()]
param(
    # Accept BOTH the switch and the env-var form, exactly as
    # setup-local-models.ps1 does: the docs and CI both use the env vars, and a
    # switch-only script silently ignores them.
    [switch]$SkipDeps   = ($env:SKIP_DEPS   -eq '1'),
    [switch]$SkipBuild  = ($env:SKIP_BUILD  -eq '1'),
    [switch]$SkipPython = ($env:SKIP_PYTHON -eq '1'),
    [switch]$SkipModels = ($env:SKIP_MODELS -eq '1'),
    [switch]$Strict     = ($env:STRICT      -eq '1'),
    [switch]$Help,

    # run.mjs forwards `pnpm bootstrap --skip-python` verbatim, and PowerShell
    # parameter binding would reject `--skip-python` outright. Swallow the
    # remaining arguments and translate the long flags ourselves.
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest = @()
)

$ErrorActionPreference = 'Stop'

# PowerShell 7.4 flipped $PSNativeCommandUseErrorActionPreference to $true by
# default, which turns a non-zero exit from ANY native command into a
# terminating error when $ErrorActionPreference is 'Stop'. That would jump past
# every explicit $LASTEXITCODE check below and report a phase failure as a raw
# PowerShell exception. Pin it off so 7.0 through 7.5 behave identically and the
# explicit checks stay the single source of truth about native failures.
$PSNativeCommandUseErrorActionPreference = $false

# --- Resolve repo root (this script lives in <root>\scripts) -----------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
# -LiteralPath, not positional: Set-Location's -Path is wildcard-interpreting,
# so a checkout under a directory with a [ or ] in its name fails to resolve.
Set-Location -LiteralPath $RootDir

function Write-Info  { param($m) Write-Host "[bootstrap] $m" -ForegroundColor Cyan }
function Write-Ok    { param($m) Write-Host "[bootstrap] $m" -ForegroundColor Green }
function Write-Warn  { param($m) Write-Host "[bootstrap][warn] $m" -ForegroundColor Yellow }
function Write-Err   { param($m) Write-Host "[bootstrap][error] $m" -ForegroundColor Red }
function Write-Plain { param($m) Write-Host $m }

function Write-Phase {
    param([int]$Number, [string]$Title)
    Write-Host ''
    Write-Host ("=== Phase {0}/5: {1} ===" -f $Number, $Title) -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host ''
}

# ---------------------------------------------------------------------------
# Arguments: translate the GNU long flags, then handle --help.
# ---------------------------------------------------------------------------
$unknownArgs = @()
foreach ($arg in $Rest) {
    # Strip the leading dashes before matching. ValueFromRemainingArguments is
    # the one part of parameter binding whose treatment of a token that LOOKS
    # like a parameter name is not worth betting on: depending on the host and
    # the version, `--skip-python` can arrive as `--skip-python`, as
    # `-skip-python`, or with the dashes eaten entirely. Normalising means every
    # spelling works and none of them is mistakenly rejected with exit 2 - which
    # would break `pnpm bootstrap --skip-python`, the documented command line.
    $flag = $arg.ToLowerInvariant().TrimStart('-')
    if     ($flag -eq 'skip-deps')   { $SkipDeps   = $true }
    elseif ($flag -eq 'skip-build')  { $SkipBuild  = $true }
    elseif ($flag -eq 'skip-python') { $SkipPython = $true }
    elseif ($flag -eq 'skip-models') { $SkipModels = $true }
    elseif ($flag -eq 'strict')      { $Strict     = $true }
    elseif ($flag -eq 'help')        { $Help       = $true }
    elseif ($flag -eq 'h')           { $Help       = $true }
    else   { $unknownArgs += $arg }
}

if ($Help) {
    Write-Plain 'Usage: pnpm bootstrap [--skip-deps] [--skip-build] [--skip-python] [--skip-models] [--strict]'
    Write-Plain '       pwsh scripts\bootstrap.ps1 [-SkipDeps] [-SkipBuild] [-SkipPython] [-SkipModels] [-Strict]'
    Write-Plain ''
    Write-Plain 'Set up a freshly cloned VideoDubber checkout so that `pnpm dev` works.'
    Write-Plain ''
    Write-Plain 'Phases:'
    Write-Plain '  1. PREREQUISITES            check Node / pnpm / Python 3.12 (+ optional Rust, ffmpeg)'
    Write-Plain '  2. WORKSPACE DEPENDENCIES   corepack enable + pnpm install       (--skip-deps)'
    Write-Plain '  3. BUILD THE WORKSPACE LIBRARIES  pnpm build                     (--skip-build)'
    Write-Plain '  4. PYTHON WORKERS + MODELS  scripts\setup-local-models.ps1       (--skip-python)'
    Write-Plain '  5. VERIFY                   pnpm verify'
    Write-Plain ''
    Write-Plain 'Every flag is also an environment variable: SKIP_DEPS, SKIP_BUILD, SKIP_PYTHON,'
    Write-Plain 'SKIP_MODELS, STRICT (set to 1). Pass-through tunables for phase 4: PYTHON_PATH,'
    Write-Plain 'FASTER_WHISPER_MODEL, ARGOS_FROM, ARGOS_TO, PIPER_VOICE, VIDEODUBBER_DEV_HOME.'
    Write-Plain ''
    Write-Plain 'Exit codes: 0 ok | 1 a required prerequisite is missing | 2 a phase command failed.'
    Write-Plain 'Details: docs\LOCAL_SETUP.md, docs\WINDOWS.md, CONTRIBUTING.md'
    exit 0
}

if ($unknownArgs.Count -gt 0) {
    Write-Err ("unrecognised argument(s): {0}" -f ($unknownArgs -join ' '))
    Write-Err 'Run `pnpm bootstrap --help` for the accepted flags.'
    exit 2
}

# ---------------------------------------------------------------------------
# Summary bookkeeping. Collected as we go and printed once at the end, because
# on a slow first run the interesting lines have long scrolled away by then.
# ---------------------------------------------------------------------------
$script:Ran      = [System.Collections.Generic.List[string]]::new()
$script:Skipped  = [System.Collections.Generic.List[string]]::new()
$script:Problems = [System.Collections.Generic.List[string]]::new()

# ---------------------------------------------------------------------------
# Native-command helpers.
#
# Every one of these checks $LASTEXITCODE explicitly. That is not belt-and-braces:
# $ErrorActionPreference = 'Stop' does NOT trap a native command's exit code, and
# that exact gap once shipped a bare node.exe as the "orchestrator" because a
# failed build step was treated as success.
# ---------------------------------------------------------------------------

<#
.SYNOPSIS
    Run a native command purely to read its version banner.
.DESCRIPTION
    Returns a PSCustomObject { Ok; Output; ExitCode; Path }. Never throws: a
    missing binary, a non-zero exit and output on stderr are all normal answers
    when probing. $ErrorActionPreference is relaxed for the duration so that
    stderr chatter (rustc and ffmpeg both banner onto stderr) is captured rather
    than raised.
#>
function Invoke-Probe {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Arguments = @()
    )

    $result = [pscustomobject]@{ Ok = $false; Output = ''; ExitCode = $null; Path = $null }

    $cmd = Get-Command -Name $Exe -ErrorAction SilentlyContinue
    if (-not $cmd) { return $result }
    $resolvedPath = if ($cmd.Source) { $cmd.Source } else { $cmd.Name }
    $result.Path = $resolvedPath

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $global:LASTEXITCODE = 0
        $raw = & $Exe @Arguments 2>&1
        $result.ExitCode = $LASTEXITCODE
        $result.Output = (($raw | ForEach-Object { "$_" }) -join "`n").Trim()
        $result.Ok = ($result.ExitCode -eq 0 -and $result.Output -ne '')
    } catch {
        $result.Output = $_.Exception.Message
        $result.Ok = $false
    } finally {
        $ErrorActionPreference = $previous
    }

    return $result
}

# ---------------------------------------------------------------------------
# The final summary.
#
# Defined HERE, not next to its one obvious call site at the bottom, because
# PowerShell resolves a function name against what has already been *executed*.
# Every failure path below (Invoke-Phase, phase 4) prints this summary before
# exiting, and a definition at the end of the file is not yet in scope then -
# the failure path would have died with "Write-Summary is not recognized",
# turning an honest "pnpm build failed" into a confusing PowerShell error.
# ---------------------------------------------------------------------------
function Write-Summary {
    param([string]$Title = 'Bootstrap complete')

    Write-Host ''
    Write-Host ("=== {0} ===" -f $Title) -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host ''

    if ($script:Ran.Count -gt 0) {
        Write-Host 'Ran:' -ForegroundColor Green
        foreach ($item in $script:Ran) { Write-Host "  $item" -ForegroundColor Green }
    }
    if ($script:Skipped.Count -gt 0) {
        Write-Host 'Skipped:' -ForegroundColor DarkGray
        foreach ($item in $script:Skipped) { Write-Host "  $item" -ForegroundColor DarkGray }
    }
    if ($script:Problems.Count -gt 0) {
        Write-Host 'Still missing / needs attention:' -ForegroundColor Yellow
        foreach ($item in $script:Problems) { Write-Host "  $item" -ForegroundColor Yellow }
    } else {
        Write-Host 'Nothing outstanding.' -ForegroundColor Green
    }

    Write-Plain ''
    Write-Plain 'Next steps:'
    Write-Plain '  pnpm dev     -> browser dev mode at http://localhost:1420 (no Rust needed)'
    Write-Plain '  pnpm app     -> native desktop window (needs Rust)'
    Write-Plain '  pnpm doctor  -> re-check the environment'
    Write-Plain ''
    Write-Plain '  docs\LOCAL_SETUP.md and CONTRIBUTING.md for detail; docs\WINDOWS.md for the'
    Write-Plain '  Windows-specific notes above.'
}

<#
.SYNOPSIS
    Run a phase command, failing the whole bootstrap (exit 2) if it does.
#>
function Invoke-Phase {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory)][string]$What
    )

    Write-Info ("run: {0} {1}" -f $Exe, ($Arguments -join ' '))
    $global:LASTEXITCODE = 0
    # Deliberately NOT captured and NOT piped anywhere. `pnpm install` and
    # `pnpm build` are the two steps a contributor most needs to watch, and a
    # `| Out-Null` on the caller's side would silently eat every line of them.
    & $Exe @Arguments
    $code = $LASTEXITCODE

    if ($code -ne 0) {
        Write-Err ("{0} failed (exit {1}): {2} {3}" -f $What, $code, $Exe, ($Arguments -join ' '))
        Write-Err 'Fix the error above and re-run `pnpm bootstrap` - it is safe to re-run.'
        $script:Problems.Add("$What failed (exit $code)")
        Write-Summary -Title 'Bootstrap incomplete'
        exit 2
    }
}

<#
.SYNOPSIS
    Parse the first x.y[.z] out of a version banner. Returns $null if there is none.
#>
function ConvertTo-VersionOrNull {
    param([string]$Text)
    if (-not $Text) { return $null }
    if ($Text -match '(\d+)\.(\d+)\.(\d+)') {
        return [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3])
    }
    if ($Text -match '(\d+)\.(\d+)') {
        return [version]("{0}.{1}.0" -f $Matches[1], $Matches[2])
    }
    return $null
}

# ---------------------------------------------------------------------------
# Phase 1 - PREREQUISITES (check only, never install)
# ---------------------------------------------------------------------------
Write-Phase 1 'PREREQUISITES'
Write-Info 'Checking only - this script never installs anything or touches your PATH.'
Write-Host ''

# Read the REAL floors instead of keeping a second copy here. package.json is the
# one place that states them, and a hardcoded duplicate in an onboarding script
# is a duplicate that goes stale without anyone noticing.
$PkgJsonPath = Join-Path $RootDir 'package.json'
if (-not (Test-Path -LiteralPath $PkgJsonPath)) {
    Write-Err "package.json not found at $PkgJsonPath - is this a VideoDubber checkout?"
    exit 2
}
try {
    $Pkg = Get-Content -LiteralPath $PkgJsonPath -Raw | ConvertFrom-Json
} catch {
    Write-Err "could not parse package.json: $($_.Exception.Message)"
    exit 2
}

$NodeFloorText = [string]$Pkg.engines.node                       # ">=22.12.0"
$NodeFloor     = ConvertTo-VersionOrNull $NodeFloorText
if (-not $NodeFloor) { $NodeFloor = [version]'22.12.0' }

# packageManager is "pnpm@11.9.0" and may carry a "+sha512...." integrity suffix.
$PnpmPinned = 'unknown'
if ($Pkg.packageManager -match '^pnpm@([^+]+)') { $PnpmPinned = $Matches[1] }

$rows = [System.Collections.Generic.List[object]]::new()
$missingRequired = [System.Collections.Generic.List[string]]::new()
$missingOptional = [System.Collections.Generic.List[string]]::new()
# TWO fix lists, not one. A first-time contributor reading one undifferentiated
# wall of "how to fix" cannot tell which command unblocks them and which is a
# nice-to-have, so "install Rust" ends up looking as urgent as "install Node".
# The bash twin splits them under MUST FIX / Optional headers; match it.
$fixesRequired   = [System.Collections.Generic.List[string]]::new()
$fixesOptional   = [System.Collections.Generic.List[string]]::new()

function Add-Row {
    param([string]$Tool, [string]$Status, [string]$Detail)
    $rows.Add([pscustomobject]@{ Tool = $Tool; Status = $Status; Detail = $Detail })
}

<#
.SYNOPSIS
    Record a prerequisite miss plus the exact command that fixes it.
.DESCRIPTION
    -Required misses fail phase 1 with exit 1. Optional misses are warnings
    unless -Strict was passed, in which case they are promoted to required -
    that promotion is what STRICT means on both halves of this pair.
#>
function Add-Miss {
    param(
        [Parameter(Mandatory)][string]$Tool,
        [Parameter(Mandatory)][string]$Reason,
        [string[]]$Fix = @(),
        [switch]$Required
    )
    $entry = "$Tool - $Reason"
    $isRequired = ($Required -or $Strict)
    if ($isRequired) { $missingRequired.Add($entry) } else { $missingOptional.Add($entry) }
    if ($Fix.Count -gt 0) {
        # -Strict promotes an optional miss to required, so its remediation has
        # to move with it or the MUST FIX block would not say how to fix it.
        #
        # Written out twice rather than picking a list into a variable first:
        # `$t = if (...) { $list }` sends the list to the output stream, which
        # ENUMERATES it - an empty List comes back as $null and `.Add()` then
        # throws. Duplication is cheaper than that trap.
        if ($isRequired) {
            $fixesRequired.Add("${Tool}:")
            foreach ($line in $Fix) { $fixesRequired.Add("    $line") }
        } else {
            $fixesOptional.Add("${Tool}:")
            foreach ($line in $Fix) { $fixesOptional.Add("    $line") }
        }
    }
}

# --- PowerShell itself -------------------------------------------------------
# On Windows pwsh 7 is REQUIRED, not optional. It is also self-evidently present:
# this file is `#requires -Version 7.0`, so if you are reading this output at all
# the check has passed. Say so anyway - contributors land in Windows PowerShell
# 5.1 by default (it is what "PowerShell" in the Start menu means), and the 5.1
# failure mode is a parse error that looks like a broken repo rather than a
# missing tool.
Add-Row 'PowerShell' 'OK' ("{0} ({1}) - required on Windows" -f $PSVersionTable.PSVersion, $PSVersionTable.PSEdition)

# --- Node --------------------------------------------------------------------
$nodeProbe = Invoke-Probe -Exe 'node' -Arguments @('--version')
$nodeVer   = ConvertTo-VersionOrNull $nodeProbe.Output
if (-not $nodeProbe.Ok -or -not $nodeVer) {
    Add-Row 'Node.js' 'MISSING' "not found on PATH (need $NodeFloorText)"
    Add-Miss -Tool 'Node' -Required -Reason "not installed (need $NodeFloorText, Node 24 LTS recommended)" -Fix @(
        'winget install --id OpenJS.NodeJS.LTS -e',
        'then open a NEW terminal so PATH picks it up'
    )
} elseif ($nodeVer -lt $NodeFloor) {
    Add-Row 'Node.js' 'MISSING' ("v{0} is older than the required {1}" -f $nodeVer, $NodeFloorText)
    Add-Miss -Tool 'Node' -Required -Reason ("v$nodeVer is below the $NodeFloorText floor in package.json engines.node") -Fix @(
        'winget install --id OpenJS.NodeJS.LTS -e',
        'then open a NEW terminal so PATH picks it up'
    )
} else {
    # Releases are built with Node 24; say so rather than making 24 a hard floor.
    $note = if ($nodeVer.Major -lt 24) { ' (Node 24 LTS is what releases are built with)' } else { '' }
    Add-Row 'Node.js' 'OK' ("v{0}{1}" -f $nodeVer, $note)
}

# --- pnpm --------------------------------------------------------------------
# The repo pins packageManager, so corepack is the supported route. A pnpm that
# is merely the WRONG version is a warning: corepack will usually correct it on
# the next invocation, and failing onboarding over a patch digit helps nobody.
$pnpmProbe = Invoke-Probe -Exe 'pnpm' -Arguments @('--version')
$pnpmVer   = ConvertTo-VersionOrNull $pnpmProbe.Output
if (-not $pnpmProbe.Ok -or -not $pnpmVer) {
    Add-Row 'pnpm' 'MISSING' "not found on PATH (need $PnpmPinned)"
    Add-Miss -Tool 'pnpm' -Required -Reason "not installed (the repo pins pnpm@$PnpmPinned via packageManager)" -Fix @(
        'corepack enable',
        "corepack prepare pnpm@$PnpmPinned --activate",
        '(corepack ships with Node; if `corepack` is missing, reinstall Node first)'
    )
} elseif ("$pnpmVer" -ne $PnpmPinned -and $pnpmProbe.Output.Trim() -ne $PnpmPinned) {
    Add-Row 'pnpm' 'WARN' ("{0} found, repo pins {1}" -f $pnpmProbe.Output.Trim(), $PnpmPinned)
    Add-Miss -Tool 'pnpm' -Reason "version $($pnpmProbe.Output.Trim()) does not match the pinned $PnpmPinned" -Fix @(
        'corepack enable',
        "corepack prepare pnpm@$PnpmPinned --activate"
    )
} else {
    Add-Row 'pnpm' 'OK' ("{0} (pinned by packageManager)" -f $pnpmProbe.Output.Trim())
}

# --- Python 3.12 -------------------------------------------------------------
# 3.12 SPECIFICALLY. It is the interpreter this repo bundles
# (apps\desktop\src-tauri\resources\python\cpython-3.12.13-*) and the one the
# engine-pack venvs are built against. The last time a dev venv drifted to 3.13,
# the frozen macOS workers only ran on macOS 26; the Windows equivalent is an
# engine pack whose wheels do not match the runtime it will be loaded into.
#
# Windows notes: prefer `python` over `python3`, and beware the Microsoft Store
# alias stub - a zero-byte python.exe under %LOCALAPPDATA%\Microsoft\WindowsApps
# that opens the Store instead of running anything. Probing it produces NO
# output, which is the tell. The py.exe launcher is checked first because
# `py -3.12` names the version we want even when several are installed.
$PythonExe     = $null
$PythonVerText = $null
$pythonNotes   = [System.Collections.Generic.List[string]]::new()

function Test-StoreAliasStub {
    param([string]$Path)
    if (-not $Path) { return $false }
    if ($Path -notlike '*\WindowsApps\*') { return $false }
    try { return ((Get-Item -LiteralPath $Path).Length -eq 0) } catch { return $true }
}

# Candidate list, in order. PYTHON_PATH always wins - the caller was explicit.
$pythonCandidates = [System.Collections.Generic.List[object]]::new()
if ($env:PYTHON_PATH) {
    $pythonCandidates.Add([pscustomobject]@{ Exe = $env:PYTHON_PATH; Args = @('--version'); Label = 'PYTHON_PATH' })
}
$pythonCandidates.Add([pscustomobject]@{ Exe = 'py';      Args = @('-3.12', '--version'); Label = 'py -3.12' })
$pythonCandidates.Add([pscustomobject]@{ Exe = 'python';  Args = @('--version');          Label = 'python' })
$pythonCandidates.Add([pscustomobject]@{ Exe = 'python3'; Args = @('--version');          Label = 'python3' })

foreach ($candidate in $pythonCandidates) {
    $probe = Invoke-Probe -Exe $candidate.Exe -Arguments $candidate.Args
    if (-not $probe.Path) { continue }

    if (Test-StoreAliasStub -Path $probe.Path) {
        $pythonNotes.Add("$($candidate.Label) is the Microsoft Store alias stub ($($probe.Path)) - it opens the Store, it is not an interpreter")
        continue
    }
    if (-not $probe.Ok) {
        # No output at all from a `--version` is the other face of the Store stub
        # (and of a broken install). Either way it is not usable.
        $pythonNotes.Add("$($candidate.Label) produced no usable version output - likely the Microsoft Store alias stub or a broken install")
        continue
    }

    $ver = ConvertTo-VersionOrNull $probe.Output
    if (-not $ver) {
        $pythonNotes.Add("$($candidate.Label) reported an unparseable version: $($probe.Output)")
        continue
    }
    if ($ver.Major -ne 3 -or $ver.Minor -ne 12) {
        $pythonNotes.Add("$($candidate.Label) is Python $ver - this project needs 3.12.x")
        continue
    }

    # Found a real 3.12. Resolve the actual interpreter path: `py -3.12` is a
    # launcher, not something the worker venvs can be created from directly, and
    # setup-local-models.ps1 wants an executable in PYTHON_PATH.
    $PythonVerText = $probe.Output
    $resolved = Invoke-Probe -Exe $candidate.Exe -Arguments (@($candidate.Args | Where-Object { $_ -ne '--version' }) + @('-c', 'import sys; print(sys.executable)'))
    if ($resolved.Ok -and $resolved.Output) {
        $PythonExe = $resolved.Output.Trim()
    } else {
        $PythonExe = if ($probe.Path) { $probe.Path } else { $candidate.Exe }
    }
    break
}

if (-not $PythonExe) {
    Add-Row 'Python 3.12' 'MISSING' 'no Python 3.12.x found'
    Add-Miss -Tool 'Python 3.12' -Required -Reason 'not found (3.12 specifically - it is the bundled runtime and what the engine-pack venvs use)' -Fix @(
        'winget install --id Python.Python.3.12 -e',
        'then open a NEW terminal, and confirm:  py -3.12 --version',
        'if you have another Python and want to keep it, point this script at 3.12:',
        '    $env:PYTHON_PATH = "C:\Path\To\Python312\python.exe"'
    )
    foreach ($note in $pythonNotes) { Write-Warn $note }
} else {
    Add-Row 'Python 3.12' 'OK' ("{0}  [{1}]" -f $PythonVerText, $PythonExe)
    # Hand the resolved interpreter down to phase 4 so setup-local-models.ps1
    # builds the venvs from the SAME 3.12 we just validated, rather than from
    # whatever `python` happens to mean once we are a level deeper.
    if (-not $env:PYTHON_PATH) {
        $env:PYTHON_PATH = $PythonExe
        Write-Info "PYTHON_PATH set for this run: $PythonExe"
    }
    foreach ($note in $pythonNotes) { Write-Info "(also seen) $note" }
}

# --- Rust / cargo (optional: only `pnpm app` needs it) -----------------------
$cargoProbe = Invoke-Probe -Exe 'cargo' -Arguments @('--version')
if ($cargoProbe.Ok) {
    Add-Row 'Rust (cargo)' 'OK' ($cargoProbe.Output.Split("`n")[0].Trim())
} else {
    Add-Row 'Rust (cargo)' 'WARN' 'not found - only needed for `pnpm app` (the native Tauri window)'
    Add-Miss -Tool 'Rust' -Reason 'not installed; `pnpm dev` (browser dev mode) still works without it' -Fix @(
        'winget install --id Rustlang.Rustup -e',
        'on Windows Rust ALSO needs the MSVC C++ build tools:',
        '    winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
    )
}

# --- ffmpeg / ffprobe (optional: the packaged app bundles its own) -----------
# `(if ...)` is NOT a legal argument expression in PowerShell - parentheses take
# a pipeline, not a statement - so resolve the names first.
$FfmpegBin  = if ($env:FFMPEG_PATH)  { $env:FFMPEG_PATH }  else { 'ffmpeg' }
$FfprobeBin = if ($env:FFPROBE_PATH) { $env:FFPROBE_PATH } else { 'ffprobe' }
$ffmpegProbe  = Invoke-Probe -Exe $FfmpegBin  -Arguments @('-version')
$ffprobeProbe = Invoke-Probe -Exe $FfprobeBin -Arguments @('-version')
if ($ffmpegProbe.Ok -and $ffprobeProbe.Ok) {
    Add-Row 'FFmpeg' 'OK' ($ffmpegProbe.Output.Split("`n")[0].Trim())
} else {
    $which = if ($ffmpegProbe.Ok) { 'ffprobe' } elseif ($ffprobeProbe.Ok) { 'ffmpeg' } else { 'ffmpeg and ffprobe' }
    Add-Row 'FFmpeg' 'WARN' "$which not found - dev convenience only; the packaged app bundles its own"
    Add-Miss -Tool 'FFmpeg' -Reason "$which not on PATH (needed for the dev media pipeline, not for the shipped build)" -Fix @(
        'winget install --id Gyan.FFmpeg -e',
        'or set FFMPEG_PATH / FFPROBE_PATH at an existing build',
        'NOTE: do NOT point the release build at a shared ffmpeg - see docs\RELEASING.md'
    )
}

# --- Print the table ---------------------------------------------------------
Write-Host ''
Write-Host ("  {0,-14} {1,-8} {2}" -f 'TOOL', 'STATUS', 'FOUND') -ForegroundColor White
Write-Host ("  {0,-14} {1,-8} {2}" -f '----', '------', '------') -ForegroundColor DarkGray
foreach ($row in $rows) {
    $color = switch ($row.Status) {
        'OK'      { 'Green' }
        'WARN'    { 'Yellow' }
        'MISSING' { 'Red' }
        default   { 'Gray' }
    }
    Write-Host ("  {0,-14} {1,-8} {2}" -f $row.Tool, $row.Status, $row.Detail) -ForegroundColor $color
}
Write-Host ''

# --- Windows-specific notes --------------------------------------------------
# These are advice, never failures. They are Windows-only by nature, so they sit
# outside the shared table that the macOS twin mirrors.
Write-Info 'Windows notes:'

# WebView2 - preinstalled on Win10/11, so only worth a word when it is absent.
$webView2Present = $false
foreach ($key in @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)) {
    try {
        $pv = (Get-ItemProperty -Path $key -Name 'pv' -ErrorAction Stop).pv
        if ($pv -and $pv -ne '0.0.0.0') { $webView2Present = $true; break }
    } catch { }
}
if (-not $webView2Present) {
    Write-Warn '  WebView2 runtime not detected. It is preinstalled on Windows 10/11, but the'
    Write-Warn '  Tauri window will not open without it. Install the Evergreen runtime:'
    Write-Warn '    winget install --id Microsoft.EdgeWebView2Runtime -e'
}

# MSVC build tools - Rust on Windows links with MSVC; rustup alone is not enough.
$ProgramFilesX86 = ${env:ProgramFiles(x86)}
if (-not $ProgramFilesX86) { $ProgramFilesX86 = $env:ProgramFiles }
$vsWhere = if ($ProgramFilesX86) { Join-Path $ProgramFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe' } else { $null }
$vcToolsPresent = $false
if ($vsWhere -and (Test-Path -LiteralPath $vsWhere)) {
    $vsProbe = Invoke-Probe -Exe $vsWhere -Arguments @('-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath')
    if ($vsProbe.Ok -and $vsProbe.Output) { $vcToolsPresent = $true }
}
if ($vcToolsPresent) {
    Write-Ok '  MSVC C++ build tools present (needed by Rust for `pnpm app`).'
} elseif ($cargoProbe.Ok) {
    Write-Warn '  Rust is installed but the MSVC C++ build tools were not detected. `pnpm app`'
    Write-Warn '  will fail at link time (link.exe not found). Install them with:'
    Write-Warn '    winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
} else {
    Write-Info '  MSVC C++ build tools not detected - only needed alongside Rust for `pnpm app`.'
}

# Path hygiene. Every one of these has actually broken a build here: the uv and
# PyInstaller paths this project builds go deep, and both tools handle spaces,
# non-ASCII and OneDrive's on-demand placeholder files badly.
if ($RootDir -match '\s') {
    Write-Warn "  The repo path contains a SPACE: $RootDir"
    Write-Warn '  uv / PyInstaller / Tauri sidecar paths handle this poorly. Prefer e.g. C:\dev\videodubber.'
}
if ($RootDir -match '[^\x20-\x7E]') {
    Write-Warn "  The repo path contains NON-ASCII characters: $RootDir"
    Write-Warn '  Move the checkout to an ASCII-only path (e.g. C:\dev\videodubber) before building sidecars.'
}
$oneDriveRoots = @($env:OneDrive, $env:OneDriveCommercial, $env:OneDriveConsumer) | Where-Object { $_ }
$underOneDrive = ($RootDir -match '(?i)OneDrive')
foreach ($od in $oneDriveRoots) {
    if ($RootDir.StartsWith($od, [System.StringComparison]::OrdinalIgnoreCase)) { $underOneDrive = $true }
}
if ($underOneDrive) {
    Write-Warn "  The repo sits under a OneDrive-redirected folder: $RootDir"
    Write-Warn '  OneDrive turns files into on-demand placeholders and syncs node_modules / .venv'
    Write-Warn '  mid-build. Move the checkout OUT of OneDrive (e.g. C:\dev\videodubber).'
}
# Long paths. The threshold is arithmetic, not taste: a pnpm store path such as
# node_modules\.pnpm\@angular+build@22.0.0_<peer hash>\node_modules\@angular\build\src\...
# runs to roughly 200 characters on its own, and MAX_PATH is 260 - so a checkout
# root much past 60 characters starts losing files to "path too long" inside
# node_modules or a worker .venv. Only nag about the switches that are actually
# still off.
if ($RootDir.Length -ge 60) {
    Write-Warn ("  The repo path is {0} characters deep: {1}" -f $RootDir.Length, $RootDir)
    Write-Warn '  Nested node_modules / .venv trees can exceed MAX_PATH (260) from here.'

    $longPathsEnabled = $false
    try {
        $lp = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name 'LongPathsEnabled' -ErrorAction Stop
        $longPathsEnabled = ($lp.LongPathsEnabled -eq 1)
    } catch { }
    if (-not $longPathsEnabled) {
        Write-Warn '  Windows long paths are OFF. In an ELEVATED prompt:'
        Write-Warn "    Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1"
        Write-Warn '  (a reboot or sign-out makes it take effect)'
    }

    $gitLongPaths = $false
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $gitProbe = Invoke-Probe -Exe 'git' -Arguments @('config', '--global', '--get', 'core.longpaths')
        $gitLongPaths = ($gitProbe.Ok -and $gitProbe.Output.Trim() -eq 'true')
    }
    if (-not $gitLongPaths) {
        Write-Warn '  git long paths are OFF:'
        Write-Warn '    git config --global core.longpaths true'
    }
    if ($longPathsEnabled -and $gitLongPaths) {
        Write-Ok '  Long paths are already enabled for both Windows and git.'
    }
}

# --- Phase 1 verdict ---------------------------------------------------------
if ($missingOptional.Count -gt 0) {
    Write-Host ''
    Write-Warn 'Optional prerequisites missing (not fatal):'
    foreach ($entry in $missingOptional) { Write-Warn "  - $entry"; $script:Problems.Add($entry) }
}

if ($missingRequired.Count -gt 0) {
    Write-Host ''
    Write-Err 'Cannot continue - required prerequisites are missing:'
    foreach ($entry in $missingRequired) { Write-Err "  - $entry"; $script:Problems.Add($entry) }
    if ($fixesRequired.Count -gt 0) {
        Write-Host ''
        Write-Host '  MUST FIX - nothing will run until these are installed:' -ForegroundColor Red
        Write-Host ''
        foreach ($line in $fixesRequired) { Write-Plain "  $line" }
    }
    if ($fixesOptional.Count -gt 0) {
        Write-Host ''
        Write-Host '  Optional - bootstrap continues without these:' -ForegroundColor Yellow
        Write-Host ''
        foreach ($line in $fixesOptional) { Write-Plain "  $line" }
    }
    Write-Host ''
    Write-Err 'Install the above, open a NEW terminal, and run `pnpm bootstrap` again.'
    Write-Err 'More detail: docs\LOCAL_SETUP.md and docs\WINDOWS.md'
    exit 1
}

if ($fixesOptional.Count -gt 0) {
    Write-Host ''
    Write-Host '  Optional - bootstrap continues without these:' -ForegroundColor Yellow
    Write-Host ''
    foreach ($line in $fixesOptional) { Write-Plain "  $line" }
}
Write-Host ''
Write-Ok 'All required prerequisites are present.'
$script:Ran.Add('1. PREREQUISITES - all required tools present')

# ---------------------------------------------------------------------------
# Phase 2 - WORKSPACE DEPENDENCIES
# ---------------------------------------------------------------------------
Write-Phase 2 'WORKSPACE DEPENDENCIES'
if ($SkipDeps) {
    Write-Warn 'Skipped (--skip-deps / SKIP_DEPS=1).'
    $script:Skipped.Add('2. WORKSPACE DEPENDENCIES (--skip-deps)')
} else {
    # corepack enable is best-effort. On Windows it writes shims next to node.exe,
    # which can fail without Developer Mode or an elevated prompt - and a working
    # standalone pnpm is a perfectly good outcome, so this must not be fatal.
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        # `2>&1` folds corepack's stderr into the pipeline, and under
        # $ErrorActionPreference = 'Stop' a native command's stderr can still
        # surface as a terminating NativeCommandError. corepack writes to stderr
        # on precisely the failure this block exists to TOLERATE - it cannot
        # write its shims next to node.exe without Developer Mode or elevation -
        # so an unrelaxed preference here would abort the whole bootstrap with a
        # raw exception at the one place the comment above promises not to.
        # Invoke-Probe relaxes it for the same reason; do the same, and restore
        # it in a finally so nothing below inherits 'Continue'.
        $corepackCode = 0
        $previousEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $global:LASTEXITCODE = 0
            & corepack enable 2>&1 | ForEach-Object { Write-Plain "  $_" }
            $corepackCode = $LASTEXITCODE
        } catch {
            Write-Plain "  $($_.Exception.Message)"
            $corepackCode = 1
        } finally {
            $ErrorActionPreference = $previousEap
        }
        if ($corepackCode -ne 0) {
            Write-Warn "corepack enable exited $corepackCode - continuing with the pnpm already on PATH."
            Write-Warn 'If pnpm is missing or the wrong version, run an elevated prompt and retry:'
            Write-Warn "  corepack enable; corepack prepare pnpm@$PnpmPinned --activate"
            $script:Problems.Add('corepack enable failed; using the ambient pnpm')
        } else {
            Write-Ok 'corepack enabled.'
        }
    } else {
        Write-Warn 'corepack not found (it normally ships with Node). Using the pnpm on PATH.'
        $script:Problems.Add('corepack unavailable; using the ambient pnpm')
    }

    # CI wants the lockfile honoured exactly; a developer wants a resolve that can
    # move. Same rule on both halves of this pair - and "same" has to mean the
    # same TEST, not just the same variable: GitHub Actions sets CI=true, not
    # CI=1, so an `-eq '1'` check silently gave CI a developer-style install
    # while the bash twin used --frozen-lockfile. Mirror bash exactly: set, and
    # neither "0" nor "false".
    $ciValue = $env:CI
    $isCi = ($ciValue) -and ($ciValue -ne '0') -and ($ciValue -ne 'false')
    $installArgs = if ($isCi) { @('install', '--frozen-lockfile') } else { @('install') }
    if ($isCi) { Write-Info "CI=$ciValue - pnpm install --frozen-lockfile" }
    Invoke-Phase -Exe 'pnpm' -Arguments $installArgs -What 'pnpm install'
    Write-Ok 'Workspace dependencies installed.'
    $script:Ran.Add('2. WORKSPACE DEPENDENCIES - pnpm install')
}

# ---------------------------------------------------------------------------
# Phase 3 - BUILD THE WORKSPACE LIBRARIES
# ---------------------------------------------------------------------------
Write-Phase 3 'BUILD THE WORKSPACE LIBRARIES'
if ($SkipBuild) {
    Write-Warn 'Skipped (--skip-build / SKIP_BUILD=1).'
    Write-Warn '`pnpm dev` will fail to resolve @videodubber/shared until you run `pnpm build`.'
    $script:Skipped.Add('3. BUILD THE WORKSPACE LIBRARIES (--skip-build)')
} else {
    # This MUST happen before the dev server: @videodubber/shared and
    # @videodubber/media-worker are consumed from dist\, not from src\. A fresh
    # clone that skips this gets a module-resolution error from the Angular dev
    # server that reads like a broken repo.
    Write-Info 'Building @videodubber/shared and @videodubber/media-worker (consumed from dist\).'
    Invoke-Phase -Exe 'pnpm' -Arguments @('build') -What 'pnpm build'
    Write-Ok 'Workspace libraries built.'
    $script:Ran.Add('3. BUILD THE WORKSPACE LIBRARIES - pnpm build')
}

# ---------------------------------------------------------------------------
# Phase 4 - PYTHON WORKERS + MODELS
# ---------------------------------------------------------------------------
Write-Phase 4 'PYTHON WORKERS + MODELS'
if ($SkipPython) {
    Write-Warn 'Skipped (--skip-python / SKIP_PYTHON=1).'
    Write-Warn 'The STT/MT/TTS workers will not start until you run: pwsh scripts\setup-local-models.ps1'
    $script:Skipped.Add('4. PYTHON WORKERS + MODELS (--skip-python)')
} else {
    $setupScript = Join-Path $ScriptDir 'setup-local-models.ps1'
    if (-not (Test-Path -LiteralPath $setupScript)) {
        Write-Err "setup-local-models.ps1 not found at $setupScript"
        $script:Problems.Add('phase 4: setup-local-models.ps1 is missing')
        Write-Summary -Title 'Bootstrap incomplete'
        exit 2
    }

    Write-Info 'This is the slow phase. It creates a .venv per worker, pip installs each'
    Write-Info 'requirements.txt, then downloads models.'
    if ($SkipModels) {
        Write-Info 'Model downloads are DISABLED (--skip-models / SKIP_MODELS=1): venvs only,'
        Write-Info 'roughly 600 MB of wheels.'
    } else {
        Write-Info 'Expect roughly 1.5-2 GB of downloads and 5-20 minutes on a first run'
        Write-Info ('(wheels ~600 MB, faster-whisper "{0}" ~500 MB, an Argos pair ~100 MB, a Piper voice ~60 MB).' -f ($(if ($env:FASTER_WHISPER_MODEL) { $env:FASTER_WHISPER_MODEL } else { 'small' })))
    }
    Write-Info 'Already-downloaded models are reused, so re-running is cheap.'

    # Tunables travel as process environment variables, which setup-local-models.ps1
    # already reads: PYTHON_PATH, FASTER_WHISPER_MODEL, ARGOS_FROM, ARGOS_TO,
    # PIPER_VOICE, VIDEODUBBER_DEV_HOME. They are inherited as-is - we deliberately
    # do not re-marshal them onto a command line, where a value containing a space
    # (a PYTHON_PATH under "Program Files", say) would need quoting we would get
    # wrong exactly once.
    foreach ($name in @('PYTHON_PATH', 'FASTER_WHISPER_MODEL', 'ARGOS_FROM', 'ARGOS_TO', 'PIPER_VOICE', 'VIDEODUBBER_DEV_HOME')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) { Write-Info ("  {0} = {1}" -f $name, $value) }
    }

    # Run it as a CHILD PROCESS, not in-process with `& $setupScript`.
    #
    # In-process, $LASTEXITCODE after a .ps1 that runs off the end is the exit
    # code of the last NATIVE command that script happened to run - not the
    # script's own verdict. setup-local-models.ps1 never calls `exit` on its
    # success path, and it deliberately warns-and-continues past a failed
    # `python -m venv` or `pip install -r requirements.txt` ("it NEVER fails hard
    # if you're offline - it prints manual instructions instead"). So a first run
    # on a flaky link completed the whole setup, printed "Setup complete", and
    # left $LASTEXITCODE = 1 behind from pip - which this phase then reported as
    # "Python worker setup failed", exited 2, and skipped phase 5 entirely. The
    # bash twin cannot have that bug: `bash scripts/setup-local-models.sh` is a
    # process, so it reads a real exit status. A child pwsh gives us the same.
    #
    # The tunables still travel as INHERITED environment variables (a child
    # process inherits them), so nothing with a space in it - a PYTHON_PATH under
    # "Program Files" - is ever re-marshalled onto a command line. -SkipModels is
    # a bare switch with no value, so passing it as an argument is safe.
    #
    # $PID's own executable, not a bare 'pwsh': we are `#requires -Version 7.0`,
    # so the host running us is already the right PowerShell, and reaching for
    # PATH could find a different one.
    $pwshExe = (Get-Process -Id $PID).Path
    if (-not $pwshExe) { $pwshExe = 'pwsh' }
    $setupArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $setupScript)
    if ($SkipModels) { $setupArgs += '-SkipModels' }

    Write-Info ("run: {0} {1}" -f $setupScript, $(if ($SkipModels) { '-SkipModels' } else { '' }))
    $global:LASTEXITCODE = 0
    $setupFailed = $false
    $setupCode = 0
    try {
        & $pwshExe @setupArgs
        $setupCode = $LASTEXITCODE
        if ($setupCode -ne 0) { $setupFailed = $true }
    } catch {
        # Only reachable if the child could not be STARTED at all; a terminating
        # error inside it makes pwsh -File exit non-zero, caught just above.
        Write-Err "setup-local-models.ps1 could not be started: $($_.Exception.Message)"
        $setupFailed = $true
        if ($setupCode -eq 0) { $setupCode = 2 }
    }

    if ($setupFailed) {
        Write-Err ('Python worker setup failed (exit {0}).' -f $setupCode)
        Write-Err 'It is safe to re-run. To retry only this phase:'
        Write-Err '  pwsh scripts\setup-local-models.ps1'
        $script:Problems.Add('phase 4: setup-local-models.ps1 failed')
        Write-Summary -Title 'Bootstrap incomplete'
        exit 2
    }
    Write-Ok 'Python workers set up.'
    $script:Ran.Add('4. PYTHON WORKERS + MODELS - setup-local-models.ps1')
    if ($SkipModels) { $script:Skipped.Add('   model downloads (--skip-models)') }
}

# ---------------------------------------------------------------------------
# Phase 5 - VERIFY
# ---------------------------------------------------------------------------
Write-Phase 5 'VERIFY'
# Reuse the existing doctor rather than growing a second, drifting checker in
# PowerShell. scripts\verify-environment.ts is cross-platform and already prints
# the OK/MISSING/WARN table with per-check criticality and fix hints.
#
# A non-zero exit here is a WARNING, not a bootstrap failure: the doctor also
# probes the running workers and the orchestrator, which are not up yet, and a
# contributor who passed --skip-python on purpose should not be shown a red
# failure for a choice they just made.
if (-not (Test-Path -LiteralPath (Join-Path $RootDir 'node_modules'))) {
    # `pnpm verify` is `tsx scripts/verify-environment.ts`, and tsx lives in
    # node_modules. With --skip-deps there is nothing to run it with, and the
    # resulting ERR_MODULE_NOT_FOUND reads like a broken doctor rather than a
    # skipped install.
    Write-Warn 'node_modules\ is absent (--skip-deps), so the doctor cannot run - it needs tsx.'
    Write-Warn 'Run it later with:  pnpm doctor'
    $script:Skipped.Add('5. VERIFY (no node_modules)')
} else {
    Write-Info 'pnpm verify  (scripts\verify-environment.ts)'
    Write-Host ''
    $global:LASTEXITCODE = 0
    & pnpm verify
    $verifyCode = $LASTEXITCODE
    if ($verifyCode -ne 0) {
        Write-Host ''
        Write-Warn 'The doctor reported problems (see its table above).'
        Write-Warn 'That is not fatal: it also checks optional engines and the dev servers,'
        Write-Warn 'which are not running yet. Re-check any time with:  pnpm doctor'
        $script:Problems.Add("the doctor reported problems - see its table above (exit $verifyCode)")
    } else {
        Write-Host ''
        Write-Ok 'Environment verified.'
    }
    $script:Ran.Add('5. VERIFY - pnpm verify')
}

Write-Summary
exit 0
