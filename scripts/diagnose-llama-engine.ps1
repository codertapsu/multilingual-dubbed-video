#requires -Version 7.0
<#
.SYNOPSIS
  Capture everything needed to diagnose a llama.cpp engine that will not start.

.DESCRIPTION
  The app only surfaces the LAST ~1200 characters of an engine's stderr, which is
  rarely where the real cause is — a missing DLL, a driver mismatch or a device
  probe failure all print early and then scroll away. This runs the installed
  llama-server exactly as the orchestrator does, with the same arguments, and
  writes the FULL output plus the machine's GPU/driver context to one file you
  can attach to a bug report.

  Nothing here changes the app or its packs; it only reads and runs.

    pwsh scripts\diagnose-llama-engine.ps1
    pwsh scripts\diagnose-llama-engine.ps1 -Runtime llama-cpp-vulkan   # compare backends
    pwsh scripts\diagnose-llama-engine.ps1 -Model chat-gemma4-12b
    pwsh scripts\diagnose-llama-engine.ps1 -Bisect                     # see below

  WHY -Bisect EXISTS. When llama.cpp dies inside a CUDA_CHECK it calls
  ggml_cuda_error(), which prints the actual message ("CUDA error: <msg>", the
  device, the failing statement) through GGML_LOG_ERROR — and llama.cpp routes
  that to an ASYNCHRONOUS logger that abort() never flushes. Only the final
  ggml_abort line, written with a direct fprintf, survives. So on an abort the
  one string you want is unrecoverable from ANY stderr capture, this script's
  included. -Bisect gets at the cause the other way: it runs the same model
  three times with only the memory knobs changed, and the pattern of which runs
  survive identifies the cause without ever needing the message.

    baseline   the app's exact arguments                  (-fitt 512)
    headroom   same, but three times the fitter's margin  (-fitt 1536)
    starved    a token GPU offload, fitter off            (-ngl 4 -fit off)

  Read the result like this:

    baseline dies, headroom + starved live -> not enough VRAM headroom. The
      llama.cpp fitter models model + KV + graph arena, but the CUDA backend
      ALSO takes a ggml_cuda_pool and a cuBLAS workspace outside all three.
      Vulkan has no such pool, which is why its projection lands exact and
      CUDA's does not. Fix is app-side: a bigger -fitt on CUDA.
    starved dies too -> not memory at all. A 4-layer offload leaves gigabytes
      free; if it still aborts, the kernel is at fault and the fix is a
      different llama.cpp build or a compute-capability gate.
    everything lives -> the failure is load-order or timing, not this config.

.PARAMETER Runtime
  Runtime pack to test (default: llama-cpp-cuda). Others: llama-cpp-vulkan,
  llama-cpp-metal, llama-cpp-linux.

.PARAMETER Model
  Model pack whose model.gguf to load. Default: the first installed one.

.PARAMETER EnginesDir
  Engine-pack root. Default: %USERPROFILE%\VideoDubber\engines.

.PARAMETER Seconds
  How long to let each server run before stopping it (default 90). Loading a 12B
  on a small card is slow; give it room.

.PARAMETER Fitt
  The fitter's per-device free-memory target in MiB (llama.cpp `-fitt`). Default
  512, which is what the app passes. Raise it to buy headroom the fitter does not
  otherwise account for.

.PARAMETER Ngl
  Force a GPU layer count (llama.cpp `-ngl`) instead of fitting. Implies
  `-fit off` and drops `-fitt`: setting -ngl while the fitter is live is exactly
  the combination that used to abort at load ("n_gpu_layers already set by user
  to 999, abort"), so the script never produces it. Omit to let llama.cpp fit,
  which is what the app does.

.PARAMETER LaunchBlocking
  Set CUDA_LAUNCH_BLOCKING=1 for the child. Kernel errors then surface at the
  call site that caused them instead of at the next unrelated CUDA_CHECK, which
  separates "the allocator ran out" from "a kernel failed to launch".

.PARAMETER Bisect
  Run the three configurations above in sequence into ONE report. Overrides
  -Fitt / -Ngl.

.PARAMETER Raw
  Do not collapse consecutive identical log lines. The report is faithful either
  way — collapsing is compression, not truncation, and every run of repeats is
  replaced by its first line plus an explicit count — but --verbose emits the
  same 'ggml_cuda_graph_set_enabled' line hundreds of times and it buried the
  signal in 900 KB of noise.
#>
[CmdletBinding()]
param(
  [string]$Runtime = 'llama-cpp-cuda',
  [string]$Model,
  [string]$EnginesDir = (Join-Path $env:USERPROFILE 'VideoDubber\engines'),
  [int]$Seconds = 90,
  [int]$Fitt = 512,
  [int]$Ngl = -1,
  [switch]$LaunchBlocking,
  [switch]$Bisect,
  [switch]$Raw
)
$ErrorActionPreference = 'Continue'

$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$report = Join-Path ([Environment]::GetFolderPath('Desktop')) "videodubber-llama-diagnosis-$stamp.txt"
function W { param($t) $t | Tee-Object -FilePath $report -Append | Out-Null; Write-Host $t }

W "VideoDubber llama.cpp engine diagnosis - $stamp"
W ("=" * 72)

# --- 1. machine + driver ----------------------------------------------------
W "`n## GPU / driver"
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  W (nvidia-smi --query-gpu=name,driver_version,memory.total,memory.free,compute_cap --format=csv 2>&1 | Out-String)
  W "nvidia-smi CUDA runtime line:"
  W ((nvidia-smi 2>&1 | Select-String 'CUDA Version') -join "`n")
} else {
  W "nvidia-smi NOT FOUND — no NVIDIA driver on PATH (expected on AMD/Intel machines)."
}
W ("OS: " + (Get-CimInstance Win32_OperatingSystem).Caption + " " + [Environment]::OSVersion.Version)
W ("RAM: {0:N1} GB" -f ((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB))

# --- 2. what is installed ---------------------------------------------------
W "`n## Installed engine packs ($EnginesDir)"
if (-not (Test-Path $EnginesDir)) { W "  MISSING - is the app installed?"; W "`nreport: $report"; exit 1 }
Get-ChildItem $EnginesDir -Directory | ForEach-Object {
  $sz = (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  W ("  {0,-28} {1,8:N0} MB" -f $_.Name, ($sz / 1MB))
}

$runtimeDir = Join-Path $EnginesDir $Runtime
if (-not (Test-Path $runtimeDir)) { W "`nRuntime '$Runtime' is NOT installed. Install it in Settings -> Engines."; W "`nreport: $report"; exit 1 }

$exe = Get-ChildItem $runtimeDir -Recurse -Filter 'llama-server.exe' | Select-Object -First 1
if (-not $exe) { W "`nllama-server.exe not found under $runtimeDir - the pack extracted wrong."; W "`nreport: $report"; exit 1 }
W "`n## Runtime: $Runtime`n  exe: $($exe.FullName)"

# The CUDA build needs its runtime DLLs beside the exe; a missing one is a
# silent 'server exits immediately' with no useful message.
W "`n## DLLs beside llama-server.exe"
Get-ChildItem $exe.DirectoryName -Filter '*.dll' | ForEach-Object { W ("  " + $_.Name) }
foreach ($need in @('cudart64_12.dll','cublas64_12.dll','cublasLt64_12.dll','ggml-cuda.dll')) {
  $present = Test-Path (Join-Path $exe.DirectoryName $need)
  W ("  required? {0,-22} {1}" -f $need, $(if ($present) { 'present' } else { 'ABSENT' }))
}

# --- 3. model ---------------------------------------------------------------
if (-not $Model) {
  $Model = (Get-ChildItem $EnginesDir -Directory |
            Where-Object { Test-Path (Join-Path $_.FullName 'model.gguf') } |
            Select-Object -First 1).Name
}
$gguf = Join-Path (Join-Path $EnginesDir $Model) 'model.gguf'
if (-not (Test-Path $gguf)) { W "`nNo model.gguf found (looked for pack '$Model'). Install a model in Settings -> Engines."; W "`nreport: $report"; exit 1 }
W ("`n## Model: {0}`n  {1} ({2:N0} MB)" -f $Model, $gguf, ((Get-Item $gguf).Length / 1MB))

# --- 4. what the binary itself reports --------------------------------------
W "`n## llama-server --version"
W ((& $exe.FullName --version 2>&1 | Out-String))
W "## llama-server --list-devices"
W ((& $exe.FullName --list-devices 2>&1 | Out-String))

# --- 5. the real run(s), with the app's exact arguments ----------------------

<#
  Build the argv the orchestrator uses. The `$appArgs` line below MIRRORS
  ENGINE_LAUNCH_SPECS['local-llm'].args in engineManager.ts and is asserted
  against it by engines.test.ts ('the diagnostic script launches llama-server
  with the orchestrator's exact arguments') — so this diagnostic cannot silently
  drift from what the app really does. If you change one, the test fails until
  you change the other.

  --verbose is the only unconditional addition: the app does not pass it, but
  the extra device/allocation lines are the whole point of this exercise.
#>
function Get-LaunchArgs {
  param([string]$Gguf, [int]$Port, [int]$Fitt, [int]$Ngl)
  # ENGINE_LAUNCH_SPECS-MIRROR (keep in step with engineManager.ts; see above)
  $appArgs = @('--host','127.0.0.1','--port',"$Port",'-c','8192','-fitt',"$Fitt",'--no-jinja','--chat-template','chatml','-m',"$Gguf")
  if ($Ngl -ge 0) {
    # An explicit -ngl and a live fitter is the combination that aborts at load,
    # so forcing layers turns fitting off outright and drops the now-meaningless
    # free-memory target.
    $i = $appArgs.IndexOf('-fitt')
    $appArgs = @($appArgs[0..($i - 1)]) + @('-ngl',"$Ngl",'-fit','off') + @($appArgs[($i + 2)..($appArgs.Count - 1)])
  }
  return $appArgs + @('--verbose')
}

# Two folds, each replacing a RUN OF CONSECUTIVE lines with its first line plus
# an explicit count in place. Order is preserved, every fold is visible and
# counted, and -Raw disables both:
#
#   1. identical messages (timestamp stripped) -> "repeated N times". --verbose
#      emits ggml_cuda_graph_set_enabled hundreds of times in a row; that one
#      line was 21% of the last report.
#   2. per-tensor load chatter -> "N per-tensor lines". llama.cpp names all ~658
#      tensors on every pass, and the fitter makes six passes, each name followed
#      by its own buffer-type line — 52% of the last report, and never once the
#      reason a server would not start. This is the only fold that drops distinct
#      text, which is why it is named rather than inferred.
function Format-Captured {
  param([string]$Path)
  $text = Get-Content $Path -Raw -ErrorAction SilentlyContinue
  if ([string]::IsNullOrEmpty($text)) { return @{ Text = '  (empty)'; Note = '' } }
  if ($Raw) { return @{ Text = $text; Note = ("  ({0:N0} bytes, verbatim)" -f $text.Length) } }

  $PERTENSOR = "`0per-tensor"
  $out = [System.Collections.Generic.List[string]]::new()
  $prevKey = $null; $prevLine = $null; $n = 0; $repeats = 0; $tensors = 0

  foreach ($line in (($text -split "`r?`n") + $null)) {
    if ($null -ne $line) {
      $key = $line -replace '^\d+\.\d+\.\d+\.\d+ ', ''
      if ($key -match '^\w? ?(create_tensor: |tensor .+ buffer type overridden)') { $key = $PERTENSOR }
      if ($null -ne $prevKey -and $key -eq $prevKey) { $n++; continue }
    }
    if ($null -ne $prevKey) {
      $out.Add($prevLine)
      if ($n -gt 1) {
        if ($prevKey -eq $PERTENSOR) {
          $out.Add("      ... [$n per-tensor create_tensor/buffer-type lines folded; -Raw keeps them]")
          $tensors += $n - 1
        } else {
          $out.Add("      ... [previous line repeated $n times]")
          $repeats += $n - 1
        }
      }
    }
    if ($null -eq $line) { break }
    $prevKey = $key; $prevLine = $line; $n = 1
  }

  $joined = $out -join "`n"
  @{ Text = $joined
     Note  = ("  ({0:N0} bytes raw -> {1:N0}: {2:N0} repeated lines collapsed, {3:N0} per-tensor lines folded; -Raw to disable)" -f $text.Length, $joined.Length, $repeats, $tensors) }
}

function Invoke-LlamaRun {
  param([string]$Label, [string]$Why, [int]$Port, [int]$Fitt, [int]$Ngl)

  $launchArgs = Get-LaunchArgs -Gguf $gguf -Port $Port -Fitt $Fitt -Ngl $Ngl
  W "`n$('-' * 72)"
  W "## RUN: $Label"
  if ($Why) { W "  $Why" }
  W ("  " + $exe.FullName + " " + ($launchArgs -join ' '))
  if ($LaunchBlocking) { W "  env: CUDA_LAUNCH_BLOCKING=1" }

  $out = Join-Path $env:TEMP "llama-diag-out-$stamp-$Label.txt"
  $err = Join-Path $env:TEMP "llama-diag-err-$stamp-$Label.txt"

  $prevBlocking = $env:CUDA_LAUNCH_BLOCKING
  if ($LaunchBlocking) { $env:CUDA_LAUNCH_BLOCKING = '1' }
  try {
    $proc = Start-Process -FilePath $exe.FullName -ArgumentList $launchArgs -NoNewWindow -PassThru `
                          -RedirectStandardOutput $out -RedirectStandardError $err
  } finally {
    $env:CUDA_LAUNCH_BLOCKING = $prevBlocking
  }

  $healthy = $false
  for ($i = 0; $i -lt $Seconds; $i++) {
    Start-Sleep -Seconds 1
    if ($proc.HasExited) { break }
    try {
      if ((Invoke-WebRequest "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) {
        $healthy = $true; break
      }
    } catch { }
  }
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500

  W "`n## RESULT [$Label]: $(if ($healthy) { 'became healthy - this configuration WORKS' } else { 'never became healthy' })"
  if ($proc.HasExited) {
    $code = $proc.ExitCode
    W "  process exit code: $code"
    # 0xC0000409 is the fail-fast abort() raises; in llama.cpp that means a
    # GGML_ABORT — a failed CUDA_CHECK, not a crash in our own code.
    if ($code -eq -1073740791) { W "  (0xC0000409 STATUS_STACK_BUFFER_OVERRUN = abort() / GGML_ABORT, i.e. a failed assertion or CUDA_CHECK)" }
  }

  $e = Format-Captured -Path $err
  W "`n## stderr [$Label]$($e.Note)"
  W $e.Text
  $o = Format-Captured -Path $out
  W "`n## stdout [$Label]$($o.Note)"
  W $o.Text
  Remove-Item $out, $err -ErrorAction SilentlyContinue

  return $healthy
}

$results = [ordered]@{}
if ($Bisect) {
  W "`n## MODE: -Bisect (three configurations, one report)"
  W "  The actual CUDA error string cannot be captured — ggml_cuda_error() logs it"
  W "  through llama.cpp's ASYNCHRONOUS logger, which abort() never flushes. These"
  W "  three runs identify the cause from which of them survive instead."
  $results['baseline'] = Invoke-LlamaRun -Label 'baseline' -Port 5199 -Fitt 512  -Ngl -1 `
    -Why "the app's exact arguments - reproduces the failure"
  $results['headroom'] = Invoke-LlamaRun -Label 'headroom' -Port 5200 -Fitt 1536 -Ngl -1 `
    -Why 'same, but 3x the fitter free-memory target - survives iff the cause is unmodelled CUDA scratch'
  $results['starved']  = Invoke-LlamaRun -Label 'starved'  -Port 5201 -Fitt 512  -Ngl 4  `
    -Why 'token 4-layer offload, fitter off, gigabytes of VRAM spare - dies only if the kernel, not memory, is at fault'
} else {
  $results['single'] = Invoke-LlamaRun -Label 'single' -Port 5199 -Fitt $Fitt -Ngl $Ngl -Why ''
}

W "`n$('=' * 72)"
if ($Bisect) {
  W "## SUMMARY"
  foreach ($k in $results.Keys) { W ("  {0,-10} {1}" -f $k, $(if ($results[$k]) { 'WORKS' } else { 'failed' })) }
  if     (-not $results['baseline'] -and -not $results['starved']) { W "`n  => Not memory. A 4-layer offload leaves VRAM to spare and it still failed:`n     suspect the kernel/build for this GPU, not the fit." }
  elseif (-not $results['baseline'] -and $results['headroom'])     { W "`n  => Headroom. The fitter's 512 MiB margin does not cover the CUDA-only`n     pool + cuBLAS workspace; raising -fitt on CUDA is the fix." }
  elseif ($results['baseline'])                                    { W "`n  => The baseline started this time. The failure is not deterministic in`n     this configuration - note what else was using the GPU." }
}
W "Report written to: $report"
Write-Host "`nAttach that file." -ForegroundColor Cyan
Write-Host "If you have both runtimes installed, the diff between a failing and a working" -ForegroundColor Cyan
Write-Host "backend on the SAME machine is the most useful signal there is:" -ForegroundColor Cyan
Write-Host "  pwsh scripts\diagnose-llama-engine.ps1 -Runtime llama-cpp-cuda" -ForegroundColor Cyan
Write-Host "  pwsh scripts\diagnose-llama-engine.ps1 -Runtime llama-cpp-vulkan" -ForegroundColor Cyan
