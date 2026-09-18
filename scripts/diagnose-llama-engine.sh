#!/usr/bin/env bash
#
# scripts/diagnose-llama-engine.sh — capture everything needed to diagnose a
# llama.cpp engine that will not start. POSIX twin of diagnose-llama-engine.ps1.
#
# WHY THIS EXISTS: the .ps1 half has existed since the GTX 1650 driver
# investigation (docs/TROUBLESHOOTING.md), and `pnpm diagnose:llama` routes
# through scripts/run.mjs — which means on macOS it printed "no .sh
# implementation for task diagnose-llama-engine" and stopped. Every user on the
# platform the app is primarily developed on had no way to produce the one
# artifact a bug report needs.
#
# The problem it solves is the same on both platforms: the app only surfaces the
# LAST ~1200 characters of an engine's stderr, which is rarely where the real
# cause is — a missing shared library, a Gatekeeper kill or a device probe
# failure all print early and then scroll away. This runs the installed
# llama-server exactly as the orchestrator does, with the same arguments, and
# writes the FULL output plus the machine's GPU context to one file you can
# attach to a bug report.
#
# Nothing here changes the app or its packs; it only reads and runs.
#
#   bash scripts/diagnose-llama-engine.sh                   # or: pnpm diagnose:llama
#   bash scripts/diagnose-llama-engine.sh --model chat-gemma4-12b
#   bash scripts/diagnose-llama-engine.sh --bisect          # see below
#
# WHAT DIFFERS FROM THE WINDOWS TWIN, AND WHY. Every check is here; some report
# "does not apply on this platform" rather than being silently dropped, which is
# itself information in a bug report:
#
#   * NVIDIA driver floor. The `minNvidiaDriver` gate in the engine catalog is on
#     the win32 `llama-cpp-cuda` pack only. macOS runs `llama-cpp-metal`, whose
#     driver is part of the OS and cannot be updated independently — so the macOS
#     equivalent of "which driver?" is "which macOS, on which chip?", and that is
#     what this reports. On Linux the pack is `llama-cpp-linux` (Vulkan/CPU), so
#     the CUDA floor does not apply there either; nvidia-smi is still read for
#     context when present.
#   * DLL check -> shared-library check. `*.dll` beside llama-server.exe becomes
#     `*.dylib` (macOS) / `*.so` (Linux), and the macOS run adds the two failure
#     modes Windows does not have: the com.apple.quarantine attribute and a
#     broken/absent code signature. Either makes llama-server die instantly with
#     "Killed: 9" and nothing on stderr at all — the exact class of silent exit
#     the DLL check catches on Windows.
#   * -LaunchBlocking sets CUDA_LAUNCH_BLOCKING=1. It is accepted here and still
#     exported, but neither platform's pack is a CUDA build, so it is a no-op —
#     the report says so rather than implying the run was instrumented.
#   * Backend comparison. On Windows the single most useful signal is the diff
#     between the CUDA and Vulkan packs on the same machine. There is no second
#     llama pack on macOS or Linux, so the closest equivalent is offered instead:
#     `--ngl 0` (everything on CPU) against the default fit.
#
# WHY --bisect EXISTS (identical reasoning to the .ps1). When llama.cpp dies
# inside a device CHECK it prints the real message through GGML_LOG_ERROR, which
# llama.cpp routes to an ASYNCHRONOUS logger that abort() never flushes. Only the
# final ggml_abort line, written with a direct fprintf, survives. So on an abort
# the one string you want is unrecoverable from ANY stderr capture, this script's
# included. --bisect gets at the cause the other way: it runs the same model
# three times with only the memory knobs changed, and the pattern of which runs
# survive identifies the cause without ever needing the message.
#
#     baseline   the app's exact arguments                  (-fitt 512)
#     headroom   same, but three times the fitter's margin  (-fitt 1536)
#     starved    a token GPU offload, fitter off            (-ngl 4 -fit off)
#
#   baseline dies, headroom + starved live -> not enough VRAM/unified-memory
#     headroom. The llama.cpp fitter models model + KV + graph arena, but a
#     backend may also take scratch outside all three. Fix is app-side: a bigger
#     -fitt.
#   starved dies too -> not memory at all. A 4-layer offload leaves gigabytes
#     free; if it still aborts, the kernel is at fault and the fix is a different
#     llama.cpp build.
#   everything lives -> the failure is load-order or timing, not this config.
#
# NOTE: `set -e` is deliberately NOT used. This is a diagnostic: nearly every
# command in it is expected to fail on some machine, and the failure IS the
# output. The .ps1 twin says the same thing as $ErrorActionPreference='Continue'.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
case "${UNAME_S}" in
  Darwin) PLATFORM="macos"; DEFAULT_RUNTIME="llama-cpp-metal"; LIB_EXT="dylib" ;;
  Linux)  PLATFORM="linux"; DEFAULT_RUNTIME="llama-cpp-linux"; LIB_EXT="so" ;;
  *)
    echo "diagnose-llama-engine.sh: this script covers macOS and Linux; on Windows run" >&2
    echo "  pwsh scripts\\diagnose-llama-engine.ps1" >&2
    exit 1 ;;
esac

# --- Defaults ----------------------------------------------------------------
# Engine packs install under <config>/engines (enginePackStore.ts). The packaged
# app roots config at ~/VideoDubber (sidecar.rs); `pnpm dev` points
# VIDEODUBBER_CONFIG_DIR at ~/VideoDubber-dev instead, so honour it — otherwise
# this diagnoses the installed app while the user is reporting a dev-stack bug.
if [ -n "${VIDEODUBBER_CONFIG_DIR:-}" ]; then
  ENGINES_DIR="${VIDEODUBBER_CONFIG_DIR}/engines"
else
  ENGINES_DIR="${HOME}/VideoDubber/engines"
fi
RUNTIME="${DEFAULT_RUNTIME}"
MODEL=""
SECONDS_LIMIT=90
FITT=512
NGL=-1
LAUNCH_BLOCKING=0
BISECT=0
RAW=0

usage() {
  cat <<EOF
scripts/diagnose-llama-engine.sh — run the installed llama-server exactly as the
app does and capture the full output.

  bash scripts/diagnose-llama-engine.sh [options]      (or: pnpm diagnose:llama)

Options (the POSIX spelling of the .ps1 twin's parameters):
  --runtime NAME       Runtime pack to test. Default: ${DEFAULT_RUNTIME}, the only
                       llama pack this platform has — override it only to point
                       at a pack installed under a different directory name.
  --model NAME         Model pack whose model.gguf to load.
                       Default: the first installed one.
  --engines-dir DIR    Engine-pack root. Default: ${ENGINES_DIR}
  --seconds N          How long to let each server run (default 90). Loading a
                       12B is slow; give it room.
  --fitt MiB           The fitter's per-device free-memory target (llama.cpp
                       -fitt). Default 512, which is what the app passes.
  --ngl N              Force a GPU layer count instead of fitting. Implies
                       '-fit off' and drops -fitt: setting -ngl while the fitter
                       is live is exactly the combination that aborts at load
                       ("n_gpu_layers already set by user to 999, abort"), so
                       this script never produces it. --ngl 0 = CPU only.
  --launch-blocking    Export CUDA_LAUNCH_BLOCKING=1 for the child. Accepted for
                       parity; a no-op on this platform's packs (see the header).
  --bisect             Run baseline/headroom/starved into ONE report. Overrides
                       --fitt / --ngl.
  --raw                Do not collapse consecutive identical log lines. The
                       report is faithful either way — collapsing is compression,
                       not truncation, and every run of repeats is replaced by
                       its first line plus an explicit count — but --verbose
                       emits the same line hundreds of times and it buries the
                       signal.
  -h, --help           This text.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime)         shift; [ "$#" -gt 0 ] || { echo "--runtime needs a value" >&2; exit 2; }; RUNTIME="$1" ;;
    --runtime=*)       RUNTIME="${1#--runtime=}" ;;
    --model)           shift; [ "$#" -gt 0 ] || { echo "--model needs a value" >&2; exit 2; }; MODEL="$1" ;;
    --model=*)         MODEL="${1#--model=}" ;;
    --engines-dir)     shift; [ "$#" -gt 0 ] || { echo "--engines-dir needs a value" >&2; exit 2; }; ENGINES_DIR="$1" ;;
    --engines-dir=*)   ENGINES_DIR="${1#--engines-dir=}" ;;
    --seconds)         shift; [ "$#" -gt 0 ] || { echo "--seconds needs a value" >&2; exit 2; }; SECONDS_LIMIT="$1" ;;
    --seconds=*)       SECONDS_LIMIT="${1#--seconds=}" ;;
    --fitt)            shift; [ "$#" -gt 0 ] || { echo "--fitt needs a value" >&2; exit 2; }; FITT="$1" ;;
    --fitt=*)          FITT="${1#--fitt=}" ;;
    --ngl)             shift; [ "$#" -gt 0 ] || { echo "--ngl needs a value" >&2; exit 2; }; NGL="$1" ;;
    --ngl=*)           NGL="${1#--ngl=}" ;;
    --launch-blocking) LAUNCH_BLOCKING=1 ;;
    --bisect)          BISECT=1 ;;
    --raw)             RAW=1 ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; echo "" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# --- Report file -------------------------------------------------------------
STAMP="$(date +%Y%m%d-%H%M%S)"
if [ -d "${HOME}/Desktop" ]; then
  REPORT_DIR="${HOME}/Desktop"
else
  # Headless Linux boxes have no Desktop; the report still has to land somewhere
  # the user can find without being told a second time.
  REPORT_DIR="${HOME}"
fi
REPORT="${REPORT_DIR}/videodubber-llama-diagnosis-${STAMP}.txt"
: > "${REPORT}"

TMP_DIR="${TMPDIR:-/tmp}"

# W: write one block to both the terminal and the report (the .ps1's Tee-Object).
W() { printf '%s\n' "$*" | tee -a "${REPORT}"; }

c_reset="\033[0m"; c_cyn="\033[36m"
hint() { printf "${c_cyn}%s${c_reset}\n" "$*"; }

W "VideoDubber llama.cpp engine diagnosis - ${STAMP}"
W "========================================================================"

# --- 1. machine + GPU --------------------------------------------------------
# On Windows this section is dominated by the NVIDIA driver version, because a
# CUDA build on a driver older than its toolkit loads the model, allocates every
# buffer and only THEN aborts, with nothing in the message pointing at a driver
# (546.29 failed, 610.88 ran the identical allocation). Neither platform here
# ships a CUDA pack, so the equivalent context is the chip, the OS and the
# memory the fitter is fitting into.
W ""
W "## GPU / driver"
if [ "${PLATFORM}" = "macos" ]; then
  W "backend: Metal (llama-cpp-metal). Apple's Metal driver ships WITH macOS and"
  W "  cannot be updated independently, so the NVIDIA driver-floor check from the"
  W "  Windows twin (CUDA 12.4 packs need 551.61+, minNvidiaDriver in the engine"
  W "  catalog) DOES NOT APPLY here. The OS + chip below are its equivalent."
  W ""
  W "chip:   $(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"
  W "OS:     $(sw_vers -productName 2>/dev/null || echo macOS) $(sw_vers -productVersion 2>/dev/null || echo '?') ($(sw_vers -buildVersion 2>/dev/null || echo '?'))"
  _mem_bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  W "RAM:    $((_mem_bytes / 1024 / 1024)) MB unified memory (shared with the GPU — the"
  W "        fitter's per-device 'free memory' is a slice of THIS, not a separate card)"
  W "cores:  $(sysctl -n hw.ncpu 2>/dev/null || echo '?') CPU"
  W ""
  W "GPU (system_profiler SPDisplaysDataType):"
  W "$(system_profiler SPDisplaysDataType 2>/dev/null | sed -n '1,40p' || echo '  (system_profiler unavailable)')"
else
  W "backend: Vulkan/CPU (llama-cpp-linux). The catalog's minNvidiaDriver gate is"
  W "  on the win32 llama-cpp-cuda pack ONLY, so the 551.61+ floor does not apply"
  W "  to this pack. nvidia-smi is read below purely for context."
  W ""
  if command -v nvidia-smi >/dev/null 2>&1; then
    W "$(nvidia-smi --query-gpu=name,driver_version,memory.total,memory.free,compute_cap --format=csv 2>&1)"
  else
    W "nvidia-smi NOT FOUND — no NVIDIA driver on PATH (expected on AMD/Intel machines)."
  fi
  if command -v vulkaninfo >/dev/null 2>&1; then
    W "vulkaninfo devices:"
    W "$(vulkaninfo --summary 2>&1 | sed -n '1,40p')"
  else
    W "vulkaninfo NOT FOUND — install the Vulkan SDK/tools to enumerate devices"
    W "  (the pack does not need it; this is diagnostics only)."
  fi
  W "OS:     $(uname -srm 2>/dev/null || echo unknown)"
  W "RAM:    $(awk '/MemTotal/ {printf "%d MB total", $2/1024} /MemAvailable/ {printf ", %d MB available", $2/1024}' /proc/meminfo 2>/dev/null || echo unknown)"
fi

# --- 2. what is installed ----------------------------------------------------
W ""
W "## Installed engine packs (${ENGINES_DIR})"
if [ ! -d "${ENGINES_DIR}" ]; then
  W "  MISSING - is the app installed? (set --engines-dir, or VIDEODUBBER_CONFIG_DIR"
  W "  if you are diagnosing the dev stack, whose home is ~/VideoDubber-dev)"
  W ""
  W "report: ${REPORT}"
  exit 1
fi
for _d in "${ENGINES_DIR}"/*/; do
  [ -d "${_d}" ] || continue
  _name="$(basename "${_d}")"
  _mb="$(du -sm "${_d}" 2>/dev/null | cut -f1)"
  W "$(printf '  %-28s %8s MB' "${_name}" "${_mb:-?}")"
done

RUNTIME_DIR="${ENGINES_DIR}/${RUNTIME}"
if [ ! -d "${RUNTIME_DIR}" ]; then
  W ""
  W "Runtime '${RUNTIME}' is NOT installed. Install it in Settings -> Engines."
  W ""
  W "report: ${REPORT}"
  exit 1
fi

EXE="$(find "${RUNTIME_DIR}" -type f -name 'llama-server' 2>/dev/null | head -1)"
if [ -z "${EXE}" ]; then
  W ""
  W "llama-server not found under ${RUNTIME_DIR} - the pack extracted wrong."
  W ""
  W "report: ${REPORT}"
  exit 1
fi
W ""
W "## Runtime: ${RUNTIME}"
W "  exe: ${EXE}"
if [ ! -x "${EXE}" ]; then
  # Windows has no execute bit, so the .ps1 cannot have this check. Here the
  # extractor must preserve the mode: a 0644 llama-server is "Permission denied"
  # at launch, which the app reports as an engine that exited immediately.
  W "  mode: NOT EXECUTABLE ($(ls -l "${EXE}" 2>/dev/null | awk '{print $1}')) — the pack"
  W "        extracted without the execute bit; the app cannot launch this at all."
  W "        fix: chmod +x '${EXE}'"
  W ""
  W "report: ${REPORT}"
  exit 1
fi

EXE_DIR="$(cd "$(dirname "${EXE}")" >/dev/null 2>&1 && pwd)"

# The Windows twin lists the DLLs beside llama-server.exe because a missing CUDA
# runtime DLL is a silent 'server exits immediately' with no useful message. The
# same failure exists here with .dylib/.so, so list them and then name the ones
# the build actually needs.
W ""
W "## Shared libraries beside llama-server (*.${LIB_EXT})"
_found_libs=0
for _lib in "${EXE_DIR}"/*."${LIB_EXT}"; do
  [ -f "${_lib}" ] || continue
  _found_libs=1
  W "  $(basename "${_lib}")"
done
[ "${_found_libs}" -eq 0 ] && W "  (none — this build statically links ggml, which is normal for some releases)"

if [ "${PLATFORM}" = "macos" ]; then
  for _need in libggml-base.dylib libggml-cpu.dylib libggml-metal.dylib libggml.dylib libllama.dylib; do
    if [ -f "${EXE_DIR}/${_need}" ]; then _s=present; else _s=ABSENT; fi
    W "$(printf '  required? %-24s %s' "${_need}" "${_s}")"
  done
  # Metal shaders. Recent llama.cpp embeds them in libggml-metal; older builds
  # loaded ggml-metal.metal from beside the binary and failed at device init
  # without it. Report whichever this pack has rather than assuming.
  W "  metal shaders:  $(ls "${EXE_DIR}"/*.metal "${EXE_DIR}"/*.metallib 2>/dev/null | tr '\n' ' ' | sed 's/ $//' || true)"
  W "                  (empty = embedded in the library, which is normal on current builds)"
else
  for _need in libggml-base.so libggml-cpu.so libggml-vulkan.so libggml.so libllama.so; do
    if [ -f "${EXE_DIR}/${_need}" ]; then _s=present; else _s=ABSENT; fi
    W "$(printf '  required? %-24s %s' "${_need}" "${_s}")"
  done
fi

# Dynamic-link resolution: the direct analogue of "which DLL is missing".
W ""
W "## Dynamic library resolution"
if [ "${PLATFORM}" = "macos" ]; then
  W "$(otool -L "${EXE}" 2>&1 | sed 's/^/  /' | sed -n '1,40p')"
else
  W "$(ldd "${EXE}" 2>&1 | sed 's/^/  /' | sed -n '1,40p')"
  W "  (any 'not found' line above IS the reason the server exits immediately)"
fi

if [ "${PLATFORM}" = "macos" ]; then
  # THE macOS-ONLY FAILURE MODE, and the reason this is not a straight port.
  # Engine packs are DOWNLOADED, so every file in them carries
  # com.apple.quarantine. Gatekeeper then kills an unsigned/ad-hoc Mach-O with
  # SIGKILL and writes nothing to stderr at all — the app reports "engine exited
  # immediately" and the 1200-character stderr window is empty, because there
  # never was any stderr. Windows has no equivalent, so the .ps1 has no such check.
  W ""
  W "## Gatekeeper (macOS only — no Windows equivalent)"
  _q="$(xattr -p com.apple.quarantine "${EXE}" 2>/dev/null || true)"
  if [ -n "${_q}" ]; then
    W "  com.apple.quarantine: PRESENT (${_q})"
    W "    -> this alone can make llama-server die with 'Killed: 9' and EMPTY stderr."
    W "    -> clear it for the whole pack:  xattr -dr com.apple.quarantine '${RUNTIME_DIR}'"
  else
    W "  com.apple.quarantine: absent (good)"
  fi
  W "  codesign -dv:"
  W "$(codesign -dv "${EXE}" 2>&1 | sed 's/^/    /')"
  W "  spctl assessment:"
  W "$(spctl -a -vv -t execute "${EXE}" 2>&1 | sed 's/^/    /')"
  W "    (a 'rejected' verdict here is expected for an upstream ggml-org binary and"
  W "     is NOT by itself the fault — the quarantine attribute above is what bites)"
fi

# --- 3. model ----------------------------------------------------------------
if [ -z "${MODEL}" ]; then
  for _d in "${ENGINES_DIR}"/*/; do
    if [ -f "${_d}model.gguf" ]; then MODEL="$(basename "${_d}")"; break; fi
  done
fi
GGUF="${ENGINES_DIR}/${MODEL}/model.gguf"
if [ -z "${MODEL}" ] || [ ! -f "${GGUF}" ]; then
  W ""
  W "No model.gguf found (looked for pack '${MODEL:-<none installed>}'). Install a model in Settings -> Engines."
  W ""
  W "report: ${REPORT}"
  exit 1
fi
W ""
W "## Model: ${MODEL}"
W "$(printf '  %s (%s MB)' "${GGUF}" "$(du -m "${GGUF}" 2>/dev/null | cut -f1)")"

# --- 4. what the binary itself reports ---------------------------------------
W ""
W "## llama-server --version"
W "$("${EXE}" --version 2>&1)"
W "## llama-server --list-devices"
W "$("${EXE}" --list-devices 2>&1)"

# --- 5. the real run(s), with the app's exact arguments ----------------------
#
# Build the argv the orchestrator uses. The LAUNCH_ARGS line below MIRRORS
# ENGINE_LAUNCH_SPECS['local-llm'].args in engineManager.ts, exactly as the .ps1
# twin does. engines.test.ts asserts the PowerShell copy against the spec ('the
# diagnostic script launches llama-server with the orchestrator's exact
# arguments') and parses that file by name, so it does not currently police this
# one — the marker and the identical quoting are here so it can, and so that a
# human changing one has an obvious reason to change all three.
#
# --verbose is the only unconditional addition: the app does not pass it, but the
# extra device/allocation lines are the whole point of this exercise.
#
# shellcheck disable=SC2034
build_launch_args() {  # build_launch_args PORT FITT NGL  -> sets LAUNCH_ARGS[]
  # The locals are named $Port / $Fitt / $Gguf — PowerShell spelling, not bash's
  # — on purpose: engines.test.ts pulls the quoted tokens off the line under the
  # marker and substitutes exactly those three names before comparing against
  # the spec. Same names here means extending that test to this file is a
  # one-line change instead of a second parser.
  local Port="$1" Fitt="$2" ngl="$3" Gguf="${GGUF}"
  # ENGINE_LAUNCH_SPECS-MIRROR (keep in step with engineManager.ts; see above)
  LAUNCH_ARGS=('--host' '127.0.0.1' '--port' "$Port" '-c' '8192' '-fitt' "$Fitt" '--no-jinja' '--chat-template' 'chatml' '-m' "$Gguf")
  if [ "${ngl}" -ge 0 ] 2>/dev/null; then
    # An explicit -ngl and a live fitter is the combination that aborts at load,
    # so forcing layers turns fitting off outright and drops the now-meaningless
    # free-memory target. (Spliced as a whole line rather than by index: bash 3.2
    # array slicing around a removed pair is exactly where this would rot.)
    LAUNCH_ARGS=('--host' '127.0.0.1' '--port' "$Port" '-c' '8192' '-ngl' "$ngl" '-fit' 'off' '--no-jinja' '--chat-template' 'chatml' '-m' "$Gguf")
  fi
  LAUNCH_ARGS+=('--verbose')
}

# Two folds, each replacing a RUN OF CONSECUTIVE lines with its first line plus
# an explicit count in place. Order is preserved, every fold is visible and
# counted, and --raw disables both:
#
#   1. identical messages (timestamp stripped) -> "repeated N times". --verbose
#      emits ggml_cuda_graph_set_enabled / ggml_metal chatter hundreds of times in
#      a row; that one line was 21% of the last Windows report.
#   2. per-tensor load chatter -> "N per-tensor lines". llama.cpp names all ~658
#      tensors on every pass, and the fitter makes six passes, each name followed
#      by its own buffer-type line — 52% of the last report, and never once the
#      reason a server would not start. This is the only fold that drops distinct
#      text, which is why it is named rather than inferred.
#
# Implemented in awk because macOS ships bash 3.2 and this has to stream a
# multi-hundred-kilobyte file without building an array in the shell.
# Sets FMT_NOTE (the one-line summary that goes on the "## stderr [label]"
# heading) and FMT_FILE (a file holding the body). Two out-params rather than a
# single stream because the caller needs them in different places, and folding a
# 900 KB capture twice to get at both halves is not free.
FMT_NOTE=""
FMT_FILE=""
format_captured() {  # format_captured FILE LABEL STREAM
  local path="$1" label="$2" stream="$3" bytes stats
  FMT_FILE="${TMP_DIR}/llama-diag-fold-${STAMP}-${label}-${stream}.txt"
  if [ ! -s "${path}" ]; then
    FMT_NOTE=""
    printf '%s\n' "  (empty)" > "${FMT_FILE}"
    return 0
  fi
  bytes="$(wc -c < "${path}" | tr -d ' ')"
  if [ "${RAW}" -eq 1 ]; then
    FMT_NOTE="  (${bytes} bytes, verbatim)"
    cp "${path}" "${FMT_FILE}"
    return 0
  fi
  stats="${TMP_DIR}/llama-diag-stats-${STAMP}-${label}-${stream}.txt"
  awk -v STATS="${stats}" '
    function flush_prev(   ) {
      if (!have) return
      print prevline
      if (n > 1) {
        if (prevkey == PT) {
          printf "      ... [%d per-tensor create_tensor/buffer-type lines folded; --raw keeps them]\n", n
          tensors += n - 1
        } else {
          printf "      ... [previous line repeated %d times]\n", n
          repeats += n - 1
        }
      }
    }
    BEGIN { PT = "\001per-tensor"; have = 0; repeats = 0; tensors = 0 }
    {
      key = $0
      sub(/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+ /, "", key)
      # POSIX awk has no \w; [A-Za-z0-9_] is the same class.
      if (key ~ /^[A-Za-z0-9_]? ?(create_tensor: |tensor .+ buffer type overridden)/) key = PT
      if (have && key == prevkey) { n++; next }
      flush_prev()
      prevkey = key; prevline = $0; n = 1; have = 1
    }
    # Parenthesised so the `>` is unambiguously a redirection and not a
    # comparison against the last printf argument.
    END { flush_prev(); printf("%d %d\n", repeats, tensors) > STATS }
  ' "${path}" > "${FMT_FILE}"
  local out_bytes rep ten
  out_bytes="$(wc -c < "${FMT_FILE}" | tr -d ' ')"
  rep="$(cut -d' ' -f1 "${stats}" 2>/dev/null || echo 0)"
  ten="$(cut -d' ' -f2 "${stats}" 2>/dev/null || echo 0)"
  FMT_NOTE="  (${bytes} bytes raw -> ${out_bytes}: ${rep:-0} repeated lines collapsed, ${ten:-0} per-tensor lines folded; --raw to disable)"
  rm -f "${stats}"
}

# Returns 0 when the run became healthy, 1 otherwise (the .ps1 returns $true/$false).
invoke_llama_run() {  # invoke_llama_run LABEL WHY PORT FITT NGL
  local label="$1" why="$2" port="$3" fitt="$4" ngl="$5"
  build_launch_args "${port}" "${fitt}" "${ngl}"

  W ""
  W "------------------------------------------------------------------------"
  W "## RUN: ${label}"
  [ -n "${why}" ] && W "  ${why}"
  W "  ${EXE} ${LAUNCH_ARGS[*]}"
  if [ "${LAUNCH_BLOCKING}" -eq 1 ]; then
    W "  env: CUDA_LAUNCH_BLOCKING=1 (accepted for parity with the Windows twin;"
    W "       this pack is not a CUDA build, so it has NO effect on this run)"
  fi

  local out="${TMP_DIR}/llama-diag-out-${STAMP}-${label}.txt"
  local err="${TMP_DIR}/llama-diag-err-${STAMP}-${label}.txt"
  : > "${out}"; : > "${err}"

  # Launch inside a SUBSHELL whose own stderr is discarded, and have that
  # subshell record the child's pid and exit status in files.
  #
  # Why not just `"${EXE}" … &` and `wait`: when a background job dies from a
  # signal, bash announces it on the shell's ORIGINAL stderr —
  #   scripts/diagnose-llama-engine.sh: line NNN: 91582 Abort trap: 6 …
  # — and that announcement cannot be redirected at the `wait` (it is a job
  # notification, not the builtin's output; `{ wait; } 2>/dev/null` does not
  # catch it either). A SIGABRT is the single most likely outcome of the thing
  # this script exists to diagnose, so the common case printed what looks like a
  # crash IN THIS SCRIPT, to a user who is already confused about why nothing
  # works. The subshell moves that notification to its own /dev/null, and the
  # status arrives through ${codefile} instead. llama-server's own stdout/stderr
  # are redirected separately and are untouched by this.
  local pidfile="${TMP_DIR}/llama-diag-pid-${STAMP}-${label}"
  local codefile="${TMP_DIR}/llama-diag-code-${STAMP}-${label}"
  rm -f "${pidfile}" "${codefile}"
  (
    [ "${LAUNCH_BLOCKING}" -eq 1 ] && export CUDA_LAUNCH_BLOCKING=1
    "${EXE}" "${LAUNCH_ARGS[@]}" >"${out}" 2>"${err}" &
    _child=$!
    printf '%s' "${_child}" > "${pidfile}"
    wait "${_child}"
    printf '%s' "$?" > "${codefile}"
  ) 2>/dev/null &
  local runner=$!

  # The pidfile appears within milliseconds; give it a bounded moment anyway.
  local spin=0
  while [ ! -s "${pidfile}" ] && [ "${spin}" -lt 50 ]; do sleep 0.1; spin=$((spin + 1)); done
  local pid=""
  [ -s "${pidfile}" ] && pid="$(cat "${pidfile}")"

  local healthy=1 i=0 exited=0
  while [ "${i}" -lt "${SECONDS_LIMIT}" ]; do
    sleep 1
    # The codefile is the authoritative "it exited" signal AND carries the
    # status, so there is no window where the pid is gone but the code is not.
    # -s, not -f: `> "${codefile}"` CREATES the file before printf writes the
    # status into it, so -f has a (tiny) window where the file exists and is
    # empty — and taking it would drop the exit code, which on an aborting
    # engine is the single most valuable line in the whole report.
    if [ -s "${codefile}" ]; then exited=1; break; fi
    if curl -fsS -m 2 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then healthy=0; break; fi
    i=$((i + 1))
  done

  local code=""
  if [ "${exited}" -eq 1 ]; then
    code="$(cat "${codefile}" 2>/dev/null || true)"
  elif [ -n "${pid}" ]; then
    # We stopped it, so there is no meaningful exit status to report. NB this
    # is a deliberate divergence, not parity: the .ps1 tests $proc.HasExited
    # AFTER its own Stop-Process, which is always true by then, so a healthy
    # Windows run prints "process exit code: -1" underneath "became healthy".
    # Reporting the code of a process WE killed is worse than reporting none.
    kill -TERM "${pid}" 2>/dev/null
    sleep 1
    kill -KILL "${pid}" 2>/dev/null
  fi
  wait "${runner}" 2>/dev/null
  rm -f "${pidfile}" "${codefile}"

  W ""
  if [ "${healthy}" -eq 0 ]; then
    W "## RESULT [${label}]: became healthy - this configuration WORKS"
  else
    W "## RESULT [${label}]: never became healthy"
  fi
  if [ -n "${code}" ]; then
    W "  process exit code: ${code}"
    # The POSIX counterpart of Windows' 0xC0000409: a shell reports a signalled
    # child as 128+signo, and SIGABRT is 6. In llama.cpp that means a GGML_ABORT
    # — a failed device CHECK, not a crash in our own code.
    case "${code}" in
      134) W "  (134 = 128+SIGABRT = abort() / GGML_ABORT, i.e. a failed assertion or device CHECK)" ;;
      137) W "  (137 = 128+SIGKILL — on macOS usually Gatekeeper (see the Gatekeeper section above) or the OOM killer)" ;;
      139) W "  (139 = 128+SIGSEGV — a segfault, not a memory-fit problem)" ;;
      126) W "  (126 = not executable / wrong architecture for this machine)" ;;
    esac
  fi

  format_captured "${err}" "${label}" stderr
  W ""
  W "## stderr [${label}]${FMT_NOTE}"
  tee -a "${REPORT}" < "${FMT_FILE}"
  rm -f "${FMT_FILE}"

  format_captured "${out}" "${label}" stdout
  W ""
  W "## stdout [${label}]${FMT_NOTE}"
  tee -a "${REPORT}" < "${FMT_FILE}"
  rm -f "${FMT_FILE}"

  rm -f "${out}" "${err}"

  return "${healthy}"
}

# bash 3.2 has no associative arrays, so the three bisect outcomes live in three
# plain variables rather than a hash. Three is not enough to need one.
R_BASELINE=1; R_HEADROOM=1; R_STARVED=1

if [ "${BISECT}" -eq 1 ]; then
  W ""
  W "## MODE: --bisect (three configurations, one report)"
  W "  The actual device error string cannot be captured — llama.cpp logs it"
  W "  through an ASYNCHRONOUS logger, which abort() never flushes. These three"
  W "  runs identify the cause from which of them survive instead."
  invoke_llama_run baseline "the app's exact arguments - reproduces the failure" 5199 512 -1
  R_BASELINE=$?
  invoke_llama_run headroom "same, but 3x the fitter free-memory target - survives iff the cause is unmodelled backend scratch" 5200 1536 -1
  R_HEADROOM=$?
  # NB: with -fit off the MoE expert weights of the offloaded layers stay on the
  # GPU, so a 4-layer offload can allocate MORE device memory than a fitted
  # 20-layer one (2070 vs 1750 MiB, measured on the Windows box). It is still a
  # useful third data point, but `headroom` is the run that settles a memory
  # question.
  invoke_llama_run starved "token 4-layer offload, fitter off - dies only if the kernel, not the fit, is at fault" 5201 512 4
  R_STARVED=$?
else
  invoke_llama_run single "" 5199 "${FITT}" "${NGL}"
fi

W ""
W "========================================================================"
if [ "${BISECT}" -eq 1 ]; then
  W "## SUMMARY"
  W "$(printf '  %-10s %s' baseline "$([ "${R_BASELINE}" -eq 0 ] && echo WORKS || echo failed)")"
  W "$(printf '  %-10s %s' headroom "$([ "${R_HEADROOM}" -eq 0 ] && echo WORKS || echo failed)")"
  W "$(printf '  %-10s %s' starved  "$([ "${R_STARVED}"  -eq 0 ] && echo WORKS || echo failed)")"
  if [ "${R_BASELINE}" -eq 0 ]; then
    # These three knobs only move MEMORY. A working baseline therefore says the
    # cause was never in them, and something OUTSIDE this script changed since
    # the failing report — so name the usual suspects rather than shrugging at
    # "not deterministic".
    W ""
    W "  => Baseline WORKS. These runs only vary memory, so if it failed before,"
    W "     something outside them changed. In order of likelihood:"
    if [ "${PLATFORM}" = "macos" ]; then
      W "       1. another process had been holding unified memory during the failing"
      W "          run (on Apple Silicon the GPU shares RAM with everything else)"
      W "       2. a macOS update, which is also a Metal driver update"
      W "       3. a different engine-pack or model version"
      W "       4. the pack had been re-downloaded and was still quarantined"
    else
      W "       1. another process had been holding VRAM during the failing run"
      W "       2. a GPU driver update"
      W "       3. a different engine-pack or model version"
    fi
  elif [ "${R_HEADROOM}" -ne 0 ] && [ "${R_STARVED}" -ne 0 ]; then
    W ""
    W "  => Not memory. 'headroom' backs the fitter off to a fraction of the device"
    W "     and it still failed, so suspect the build/driver for this GPU."
    W "     Re-read the GPU section at the top of this report FIRST."
  elif [ "${R_HEADROOM}" -eq 0 ]; then
    W ""
    W "  => Headroom. The fitter's 512 MiB margin does not cover this backend's"
    W "     own scratch; raising -fitt is the fix."
  else
    W ""
    W "  => Mixed result - read the per-run allocations above rather than trusting"
    W "     this summary; the knobs did not separate the cause cleanly."
  fi
fi
W "Report written to: ${REPORT}"

hint ""
hint "Attach that file."
if [ "${PLATFORM}" = "macos" ]; then
  hint "On Windows the most useful signal is the diff between the CUDA and Vulkan packs"
  hint "on one machine. macOS ships only llama-cpp-metal, so there is no second backend"
  hint "to diff against; the closest equivalent is GPU-vs-CPU on this same machine:"
  hint "  bash scripts/diagnose-llama-engine.sh              # Metal, fitted (what the app does)"
  hint "  bash scripts/diagnose-llama-engine.sh --ngl 0      # CPU only"
  hint "  bash scripts/diagnose-llama-engine.sh --bisect     # the three memory configurations"
else
  hint "llama-cpp-linux is the only Linux pack, so there is no second backend to diff"
  hint "against; the closest equivalent is GPU-vs-CPU on this same machine:"
  hint "  bash scripts/diagnose-llama-engine.sh              # Vulkan, fitted (what the app does)"
  hint "  bash scripts/diagnose-llama-engine.sh --ngl 0      # CPU only"
  hint "  bash scripts/diagnose-llama-engine.sh --bisect     # the three memory configurations"
fi
