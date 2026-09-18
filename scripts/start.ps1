#Requires -Version 5.1
<#
.SYNOPSIS
    Start the ENTIRE VideoDubber stack DETACHED in one command (Windows).
.DESCRIPTION
    Launches the full stack (workers + orchestrator + Angular UI) in a background
    process and returns your prompt. Stop it any time with `.\scripts\stop.ps1`.
    Logs go to .dev-logs\stack.log.
.EXAMPLE
    .\scripts\start.ps1     # then open http://localhost:1420
#>
[CmdletBinding()]
param()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
Set-Location $RootDir

$LogDir = Join-Path $RootDir '.dev-logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$StackLog = Join-Path $LogDir 'stack.log'
$PidFile  = Join-Path $LogDir 'stack.pid'

function Write-Ok   { param($m) Write-Host "[start] $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "[start][warn] $m" -ForegroundColor Yellow }

# Honor .env (dev.ps1 does, so the guard + printed URLs must use the same ports).
$EnvFile = Join-Path $RootDir '.env'
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $k, $v = $line.Split('=', 2)
            if (-not [Environment]::GetEnvironmentVariable($k.Trim())) {
                [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim().Trim('"'))
            }
        }
    }
}
function PortOr($name, $default) {
    $v = [Environment]::GetEnvironmentVariable($name); if ($v) { $v } else { $default }
}
$OrchPort = PortOr 'ORCHESTRATOR_PORT' '5100'
$AngPort  = PortOr 'ANGULAR_PORT' '1420'

# Refuse to double-start if EITHER stack port is already in use. Checking only
# the orchestrator (as this did until 2026-09) meant that a stack whose
# orchestrator had died but whose Angular dev server was still up passed the
# guard, and you got a second stack fighting the first for :1420 - matching
# start.sh, which has always guarded both.
foreach ($guard in @(@{ port = $OrchPort; what = 'orchestrator' }, @{ port = $AngPort; what = 'Angular dev server' })) {
    $busy = Get-NetTCPConnection -State Listen -LocalPort ([int]$guard.port) -ErrorAction SilentlyContinue
    if ($busy) {
        Write-Warn "Something is already listening on :$($guard.port) ($($guard.what)). Run .\scripts\stop.ps1 first. Aborting."
        exit 1
    }
}

# Launch dev.ps1 detached; it manages and cleans up its own children. The path is
# quoted so a space in the repo path (e.g. C:\Users\John Doe\...) survives the
# space-join Start-Process does on -ArgumentList.
$p = Start-Process pwsh `
    -ArgumentList @('-NoProfile', '-File', "`"$(Join-Path $ScriptDir 'dev.ps1')`"") `
    -WorkingDirectory $RootDir -RedirectStandardOutput $StackLog -RedirectStandardError "$StackLog.err" `
    -WindowStyle Hidden -PassThru
$p.Id | Out-File -FilePath $PidFile -Encoding ascii

Write-Ok ("VideoDubber stack starting in the background (pid {0})." -f $p.Id)
Write-Host '  ----------------------------------------------------------------'
Write-Host "  Angular UI:   http://localhost:$AngPort"
Write-Host "  Orchestrator: http://127.0.0.1:$OrchPort"
Write-Host ("  Logs:         {0}" -f $LogDir)
# NOT `pnpm stop`: package.json maps it to `bash scripts/stop.sh`, which on
# Windows either fails outright or - with Git Bash installed - runs an
# lsof/fuser sweep that finds nothing and cheerfully reports "already stopped"
# while the stack keeps running.
Write-Host '  Stop:         .\scripts\stop.ps1'
Write-Host '  ----------------------------------------------------------------'
