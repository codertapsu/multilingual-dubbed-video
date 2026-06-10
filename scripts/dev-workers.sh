#!/usr/bin/env bash
#
# scripts/dev-workers.sh — Start ONLY the 3 Python FastAPI workers for development.
#
# Usage:
#   ./scripts/dev-workers.sh
#
# Starts:
#   - STT worker         (faster-whisper)  on port 5101
#   - Translation worker (Argos Translate) on port 5102
#   - TTS worker         (Piper/fallback)  on port 5103
#
# Each worker activates its local .venv if present, otherwise falls back to
# PYTHON_PATH / python3 with a warning. Missing venvs/ffmpeg are warnings, not
# fatal — see docs/LOCAL_SETUP.md and run scripts/setup-local-models.sh first.
#
# Ctrl-C stops all workers.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
cd "${ROOT_DIR}"

STT_WORKER_PORT="${STT_WORKER_PORT:-5101}"
TRANSLATION_WORKER_PORT="${TRANSLATION_WORKER_PORT:-5102}"
TTS_WORKER_PORT="${TTS_WORKER_PORT:-5103}"
PYTHON_BIN="${PYTHON_PATH:-python3}"

LOG_DIR="${ROOT_DIR}/.dev-logs"
mkdir -p "${LOG_DIR}"

c_reset="\033[0m"; c_red="\033[31m"; c_grn="\033[32m"; c_yel="\033[33m"; c_blu="\033[34m"
info()  { printf "${c_blu}[workers]${c_reset} %s\n" "$*"; }
ok()    { printf "${c_grn}[workers]${c_reset} %s\n" "$*"; }
warn()  { printf "${c_yel}[workers][warn]${c_reset} %s\n" "$*" >&2; }
err()   { printf "${c_red}[workers][error]${c_reset} %s\n" "$*" >&2; }

PIDS=()
cleanup() {
  echo
  info "Stopping workers..."
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill -TERM "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
    fi
  done
  sleep 1 2>/dev/null || true
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill -KILL "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
    fi
  done
  ok "Workers stopped."
}
trap cleanup INT TERM EXIT

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  warn "Python ('${PYTHON_BIN}') not found on PATH. Workers without a .venv will be skipped."
  warn "Set PYTHON_PATH or install Python 3.10+. See docs/LOCAL_SETUP.md."
fi

# Args: <name> <worker-dir> <port>
start_worker() {
  local name="$1" dir="$2" port="$3"
  local wdir="${ROOT_DIR}/workers/${dir}"

  if [[ ! -d "${wdir}" ]]; then
    warn "${name} worker dir missing (${wdir}); skipping. See docs/LOCAL_SETUP.md."
    return
  fi

  local py="${PYTHON_BIN}"
  if [[ -x "${wdir}/.venv/bin/python" ]]; then
    py="${wdir}/.venv/bin/python"
  else
    warn "${name}: no .venv in ${wdir}; using '${PYTHON_BIN}'. Run scripts/setup-local-models.sh."
  fi

  if ! command -v "${py}" >/dev/null 2>&1 && [[ ! -x "${py}" ]]; then
    warn "${name}: no usable python interpreter; skipping."
    return
  fi

  info "Starting ${name} on port ${port} (logs: ${LOG_DIR}/${dir}.log)"
  (
    cd "${wdir}" || exit 1
    exec "${py}" -m uvicorn app.main:app --host 127.0.0.1 --port "${port}" --reload
  ) >"${LOG_DIR}/${dir}.log" 2>&1 &
  PIDS+=("$!")
}

start_worker "STT"         "stt-worker"         "${STT_WORKER_PORT}"
start_worker "Translation" "translation-worker" "${TRANSLATION_WORKER_PORT}"
start_worker "TTS"         "tts-worker"         "${TTS_WORKER_PORT}"

echo
ok "Python workers starting:"
printf "  %-22s %s\n" "STT worker:"         "http://127.0.0.1:${STT_WORKER_PORT}/health"
printf "  %-22s %s\n" "Translation worker:" "http://127.0.0.1:${TRANSLATION_WORKER_PORT}/health"
printf "  %-22s %s\n" "TTS worker:"         "http://127.0.0.1:${TTS_WORKER_PORT}/health"
printf "  Logs: %s\n" "${LOG_DIR}/"
echo "  Press Ctrl-C to stop."
echo

if [[ ${#PIDS[@]} -eq 0 ]]; then
  warn "No workers were started."
  exit 0
fi

while true; do
  if ! wait -n 2>/dev/null; then
    alive=0
    for pid in "${PIDS[@]}"; do
      if kill -0 "${pid}" 2>/dev/null; then alive=1; fi
    done
    if [[ "${alive}" -eq 0 ]]; then
      warn "All workers have exited."
      break
    fi
  fi
done
