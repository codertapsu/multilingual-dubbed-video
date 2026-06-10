#!/usr/bin/env bash
#
# scripts/dev.sh — Start the full VideoDubber stack for local development.
#
# Usage:
#   ./scripts/dev.sh                 # start everything (workers + orchestrator + Angular UI)
#   SKIP_WORKERS=1 ./scripts/dev.sh  # skip the 3 python workers (UI + orchestrator only)
#   SKIP_UI=1 ./scripts/dev.sh       # skip the Angular dev server (workers + orchestrator only)
#
# What it does:
#   1. Verifies pnpm is available (errors out if missing — it is required).
#   2. Starts the 3 Python FastAPI workers (stt:5101, translation:5102, tts:5103),
#      each activating its local .venv if present. Missing venvs are WARNINGS, not
#      fatal — see docs/LOCAL_SETUP.md to create them with scripts/setup-local-models.sh.
#   3. Starts the Node orchestrator (port 5100).
#   4. Starts the Angular dev server (videodubber-desktop).
#   5. Traps SIGINT/SIGTERM and kills all child processes on exit.
#
# This script does NOT install anything. Run scripts/setup-local-models.sh first.
#
set -uo pipefail

# --- Resolve repo root (this script lives in <root>/scripts) -----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
cd "${ROOT_DIR}"

# --- Defaults (override via env) ---------------------------------------------
ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-5100}"
STT_WORKER_PORT="${STT_WORKER_PORT:-5101}"
TRANSLATION_WORKER_PORT="${TRANSLATION_WORKER_PORT:-5102}"
TTS_WORKER_PORT="${TTS_WORKER_PORT:-5103}"
ANGULAR_PORT="${ANGULAR_PORT:-4200}"

PYTHON_BIN="${PYTHON_PATH:-python3}"
LOG_DIR="${ROOT_DIR}/.dev-logs"
mkdir -p "${LOG_DIR}"

# --- Pretty logging ----------------------------------------------------------
c_reset="\033[0m"; c_red="\033[31m"; c_grn="\033[32m"; c_yel="\033[33m"; c_blu="\033[34m"
info()  { printf "${c_blu}[dev]${c_reset} %s\n" "$*"; }
ok()    { printf "${c_grn}[dev]${c_reset} %s\n" "$*"; }
warn()  { printf "${c_yel}[dev][warn]${c_reset} %s\n" "$*" >&2; }
err()   { printf "${c_red}[dev][error]${c_reset} %s\n" "$*" >&2; }

# Track child PIDs so we can clean up on exit.
PIDS=()

cleanup() {
  echo
  info "Shutting down dev stack..."
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      # Kill the whole process group of each child (negative PID) to catch uvicorn/ng reloaders.
      kill -TERM "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
    fi
  done
  # Give children a moment, then hard-kill survivors.
  sleep 1 2>/dev/null || true
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill -KILL "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
    fi
  done
  ok "Stopped."
}
trap cleanup INT TERM EXIT

# --- Preconditions -----------------------------------------------------------
if ! command -v pnpm >/dev/null 2>&1; then
  err "pnpm is not installed. Install it with: npm i -g pnpm   (see docs/LOCAL_SETUP.md)"
  exit 1
fi
ok "pnpm $(pnpm --version) found."

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  warn "Python ('${PYTHON_BIN}') not found on PATH. The workers will not start."
  warn "Set PYTHON_PATH or install Python 3.10+. See docs/LOCAL_SETUP.md."
fi

# Warn (do not fail) if ffmpeg/ffprobe are missing — the orchestrator needs them at run time.
check_bin_warn() {
  local bin="$1" envvar="$2"
  local path="${!envvar:-}"
  if [[ -n "${path}" ]]; then
    if [[ -x "${path}" ]]; then ok "${bin} found at \$${envvar}=${path}"; return; fi
    warn "\$${envvar}=${path} is not executable; falling back to PATH lookup."
  fi
  if command -v "${bin}" >/dev/null 2>&1; then
    ok "${bin} found on PATH ($(command -v "${bin}"))."
  else
    warn "${bin} not found (set ${envvar} or install ffmpeg). Rendering/probing will fail. See docs/LOCAL_SETUP.md."
  fi
}
check_bin_warn ffmpeg FFMPEG_PATH
check_bin_warn ffprobe FFPROBE_PATH

# --- Helper: start a python worker -------------------------------------------
# Args: <name> <worker-dir> <port> <env-port-var>
start_worker() {
  local name="$1" dir="$2" port="$3" portvar="$4"
  local wdir="${ROOT_DIR}/workers/${dir}"

  if [[ ! -d "${wdir}" ]]; then
    warn "${name} worker dir missing (${wdir}); skipping. See docs/LOCAL_SETUP.md."
    return
  fi

  # Pick the python interpreter: prefer the worker's own venv.
  local py="${PYTHON_BIN}"
  if [[ -x "${wdir}/.venv/bin/python" ]]; then
    py="${wdir}/.venv/bin/python"
  else
    warn "${name}: no .venv found in ${wdir}. Using '${PYTHON_BIN}' from PATH."
    warn "${name}: create the venv with scripts/setup-local-models.sh (docs/LOCAL_SETUP.md)."
  fi

  if ! command -v "${py}" >/dev/null 2>&1 && [[ ! -x "${py}" ]]; then
    warn "${name}: no usable python interpreter; skipping."
    return
  fi

  info "Starting ${name} worker on port ${port} (logs: ${LOG_DIR}/${dir}.log)"
  # Run in its own process group via setsid-like trick: 'set -m' isn't reliable here,
  # so we just background and rely on killing the PID/group in cleanup.
  (
    cd "${wdir}" || exit 1
    # app.main:app is the FastAPI ASGI app; --reload for dev hot reload.
    exec "${py}" -m uvicorn app.main:app --host 127.0.0.1 --port "${port}" --reload
  ) >"${LOG_DIR}/${dir}.log" 2>&1 &
  local pid=$!
  PIDS+=("${pid}")
  # Export the resolved port so the orchestrator/UI know where to reach it.
  export "${portvar}=http://127.0.0.1:${port}"
}

# --- Start workers -----------------------------------------------------------
if [[ "${SKIP_WORKERS:-0}" != "1" ]]; then
  start_worker "STT"         "stt-worker"         "${STT_WORKER_PORT}"        STT_WORKER_URL
  start_worker "Translation" "translation-worker" "${TRANSLATION_WORKER_PORT}" TRANSLATION_WORKER_URL
  start_worker "TTS"         "tts-worker"         "${TTS_WORKER_PORT}"        TTS_WORKER_URL
else
  warn "SKIP_WORKERS=1 — not starting Python workers."
fi

# --- Start orchestrator ------------------------------------------------------
export ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://127.0.0.1:${ORCHESTRATOR_PORT}}"
info "Starting Node orchestrator on port ${ORCHESTRATOR_PORT} (logs: ${LOG_DIR}/orchestrator.log)"
(
  exec pnpm --filter @videodubber/node-orchestrator dev
) >"${LOG_DIR}/orchestrator.log" 2>&1 &
ORCH_PID=$!
PIDS+=("${ORCH_PID}")

# --- Start Angular dev server ------------------------------------------------
if [[ "${SKIP_UI:-0}" != "1" ]]; then
  info "Starting Angular dev server (videodubber-desktop) on port ${ANGULAR_PORT}"
  (
    exec pnpm --filter videodubber-desktop dev
  ) >"${LOG_DIR}/desktop.log" 2>&1 &
  UI_PID=$!
  PIDS+=("${UI_PID}")
else
  warn "SKIP_UI=1 — not starting Angular dev server."
fi

# --- Print URLs --------------------------------------------------------------
echo
ok   "VideoDubber dev stack is starting up."
echo "  ----------------------------------------------------------------"
printf "  %-22s %s\n" "Angular UI:"       "http://127.0.0.1:${ANGULAR_PORT}"
printf "  %-22s %s\n" "Orchestrator:"     "http://127.0.0.1:${ORCHESTRATOR_PORT}"
printf "  %-22s %s\n" "STT worker:"       "http://127.0.0.1:${STT_WORKER_PORT}"
printf "  %-22s %s\n" "Translation worker:" "http://127.0.0.1:${TRANSLATION_WORKER_PORT}"
printf "  %-22s %s\n" "TTS worker:"       "http://127.0.0.1:${TTS_WORKER_PORT}"
echo "  ----------------------------------------------------------------"
printf "  Logs: %s\n" "${LOG_DIR}/"
echo "  Press Ctrl-C to stop everything."
echo

# --- Wait for any child to exit; keep the script alive --------------------------
# 'wait -n' returns when any one child exits. If a child dies, we surface it but
# keep the rest running until the user hits Ctrl-C.
while true; do
  if ! wait -n 2>/dev/null; then
    # Either a child exited non-zero, or there are no children left.
    if [[ ${#PIDS[@]} -eq 0 ]]; then break; fi
    # Re-check whether any tracked PID is still alive.
    alive=0
    for pid in "${PIDS[@]}"; do
      if kill -0 "${pid}" 2>/dev/null; then alive=1; fi
    done
    if [[ "${alive}" -eq 0 ]]; then
      warn "All child processes have exited."
      break
    fi
  fi
done
