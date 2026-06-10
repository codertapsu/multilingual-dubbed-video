#Requires -Version 5.1
<#
.SYNOPSIS
    Start ONLY the backend services (no UI), in the foreground, on Windows.
.DESCRIPTION
    Starts the Node orchestrator (5100) and the 3 Python workers (5101/5102/5103)
    without the Angular dev server. This is what the Tauri desktop shell launches
    on startup so opening the app brings the backend up, and quitting it tears the
    backend down (the shell stops this process tree). Thin wrapper over dev.ps1
    with -SkipUi.
.EXAMPLE
    .\scripts\start-services.ps1
#>
[CmdletBinding()]
param()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $ScriptDir 'dev.ps1') -SkipUi @args
