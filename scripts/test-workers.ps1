#requires -Version 5.1
<#
.SYNOPSIS
  Run the Python test suites that `pnpm -r test` cannot reach.

.DESCRIPTION
  Windows counterpart of scripts/test-workers.sh.

  pnpm-workspace.yaml deliberately excludes the Python workers ("The Python
  workers ... are NOT pnpm packages"), so the root `test` script never touches
  them, and .github/workflows/ has no pytest step at all. That left ~109 passing
  tests running nowhere automatically - while build-workers.{sh,ps1} will happily
  freeze and package a worker whose suite is red. They take under a second in
  total, so there is no reason for them to be optional.

.PARAMETER Only
  Comma list of suite directory names (e.g. "stt-worker,tts-worker").

.PARAMETER RequireAll
  Fail when a suite could not be run at all (no venv with pytest), instead of
  reporting it as skipped. Use this in a release wrapper.
#>
[CmdletBinding()]
param(
  [string]$Only = $env:ONLY,
  [switch]$RequireAll = ($env:REQUIRE_ALL -eq '1')
)

$ErrorActionPreference = "Stop"
# ...except around the native calls. In Windows PowerShell 5.1 (which the
# #Requires above allows) a native command whose stderr is REDIRECTED has that
# stderr re-emitted as a NativeCommandError, which "Stop" makes terminating. The
# probe that decides whether to SKIP a suite deliberately runs
# `python -c "import pytest"` and lets it fail with a traceback on stderr, so
# "Stop" would turn the intended skip into a crash — in a script that
# release-windows.ps1 now runs as a release gate. Every native call here reports
# failure through $LASTEXITCODE, which is what this script actually checks.
$NativeEap = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..")

$Suites = @(
  "workers\stt-worker",
  "workers\translation-worker",
  "workers\tts-worker",
  "workers\tts-engine-neural",
  "workers\tts-engine-omnivoice"
)

$wanted = if ($Only) { $Only.Split(",") | ForEach-Object { $_.Trim() } } else { $null }
$failed = @()
$skipped = @()
$ran = 0

foreach ($rel in $Suites) {
  $dir  = Join-Path $RepoRoot $rel
  $name = Split-Path -Leaf $rel
  if ($wanted -and ($wanted -notcontains $name)) { continue }
  if (-not (Test-Path (Join-Path $dir "tests"))) { continue }

  # Prefer the suite's own venv; fall back to any python on PATH that has pytest.
  $py = $null
  foreach ($cand in @("\.venv\Scripts\python.exe", "\.venv\bin\python.exe")) {
    $p = Join-Path $dir $cand.TrimStart('\')
    if (Test-Path $p) { $py = $p; break }
  }
  if (-not $py) {
    $onPath = Get-Command python -ErrorAction SilentlyContinue
    if ($onPath) { $py = $onPath.Source }
  }
  if ($py) {
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = $NativeEap
    & $py -c "import pytest" 2>$null | Out-Null
    $ErrorActionPreference = $prevEap
    if ($LASTEXITCODE -ne 0) { $py = $null }
  }
  if (-not $py) {
    $skipped += "$rel (no venv with pytest - run scripts\setup-local-models.ps1)"
    continue
  }

  Write-Host "==> pytest $rel"
  Push-Location $dir
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = $NativeEap
  try {
    & $py -m pytest -q
    if ($LASTEXITCODE -ne 0) { $failed += $rel } else { $ran++ }
  } finally { $ErrorActionPreference = $prevEap; Pop-Location }
}

Write-Host ""
if ($skipped.Count -gt 0) {
  Write-Host "skipped:"
  $skipped | ForEach-Object { Write-Host "  - $_" }
}
if ($failed.Count -gt 0) {
  Write-Host "FAILED suites:"
  $failed | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
if ($RequireAll -and $skipped.Count -gt 0) {
  Write-Host "ERROR: -RequireAll and $($skipped.Count) suite(s) could not be run (see above)."
  exit 1
}
Write-Host "OK - $ran Python suite(s) passed."
