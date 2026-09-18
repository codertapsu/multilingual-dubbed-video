#Requires -Version 5.1
<#
.SYNOPSIS
    Stop the ENTIRE VideoDubber stack in one command (Windows).
.DESCRIPTION
    Stops whatever is listening on the stack ports (Angular UI + orchestrator +
    the 3 Python workers), regardless of how it was started. Port-based, so it is
    reliable and side-effect-free.
.EXAMPLE
    .\scripts\stop.ps1      # or: pnpm stop  (if on Windows with pwsh)
#>
[CmdletBinding()]
param()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir

# Load .env so custom ports are honored (existing env wins).
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
    $v = [Environment]::GetEnvironmentVariable($name)
    if ($v) { $v } else { $default }
}
$Ports = @(
    (PortOr 'ANGULAR_PORT' '1420'),
    (PortOr 'ORCHESTRATOR_PORT' '5100'),
    (PortOr 'STT_WORKER_PORT' '5101'),
    (PortOr 'TRANSLATION_WORKER_PORT' '5102'),
    (PortOr 'TTS_WORKER_PORT' '5103')
)

function Write-Info { param($m) Write-Host "[stop] $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "[stop] $m" -ForegroundColor Green }

$any = $false

# 1. The supervisor first, from the pidfile start.ps1 writes. stop.ps1 never read
# it, so `.dev-logs\stack.pid` was orphaned on every stop and a stale pid file sat
# there implying a running stack. stop.sh has always TERMed the supervisor's
# process group and removed the file; this is the Windows equivalent.
$PidFile = Join-Path $RootDir '.dev-logs\stack.pid'
if (Test-Path $PidFile) {
    $supervisor = (Get-Content $PidFile -Raw).Trim()
    if ($supervisor -match '^\d+$' -and (Get-Process -Id ([int]$supervisor) -ErrorAction SilentlyContinue)) {
        $any = $true
        Write-Info "Supervisor PID $supervisor (from stack.pid) -> stopping (tree)"
        taskkill /PID $supervisor /T /F 2>$null | Out-Null
    }
    Remove-Item -Force $PidFile -ErrorAction SilentlyContinue
}

# 2. Then sweep the ports, which also catches a stack started any other way.
foreach ($port in $Ports) {
    try {
        $conns = Get-NetTCPConnection -State Listen -LocalPort ([int]$port) -ErrorAction SilentlyContinue
    } catch { $conns = $null }
    $pids = @($conns | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -and $_ -ne 0 })
    foreach ($processId in $pids) {
        $any = $true
        Write-Info "Port :$port -> stopping PID $processId (tree)"
        taskkill /PID $processId /T /F 2>$null | Out-Null
    }
}

if ($any) { Write-Ok 'VideoDubber stack stopped.' }
else { Write-Ok 'Nothing was running on the stack ports (already stopped).' }
