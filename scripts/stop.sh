#!/usr/bin/env bash
#
# scripts/stop.sh — Stop the ENTIRE VideoDubber stack in one command.
#
# Usage:
#   ./scripts/stop.sh        # or: pnpm stop
#
# Stops whatever is listening on the stack's ports (Angular UI + orchestrator +
# the 3 Python workers), no matter how it was started — `pnpm dev`, `pnpm start`
# (detached), individual `pnpm dev:*` commands, or the Tauri desktop shell's
# managed services. Port-based so it is reliable and side-effect-free.
#
# Override ports via env (same names as dev.sh): ANGULAR_PORT, ORCHESTRATOR_PORT,
# STT_WORKER_PORT, TRANSLATION_WORKER_PORT, TTS_WORKER_PORT.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

# Load .env so custom ports are honored (values already set win).
if [[ -f "${ROOT_DIR}/.env" ]]; then set -a; . "${ROOT_DIR}/.env"; set +a; fi

ANGULAR_PORT="${ANGULAR_PORT:-1420}"
ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-5100}"
STT_WORKER_PORT="${STT_WORKER_PORT:-5101}"
TRANSLATION_WORKER_PORT="${TRANSLATION_WORKER_PORT:-5102}"
TTS_WORKER_PORT="${TTS_WORKER_PORT:-5103}"
PORTS=("${ANGULAR_PORT}" "${ORCHESTRATOR_PORT}" "${STT_WORKER_PORT}" "${TRANSLATION_WORKER_PORT}" "${TTS_WORKER_PORT}")

c_reset="\033[0m"; c_grn="\033[32m"; c_yel="\033[33m"; c_blu="\033[34m"
info() { printf "${c_blu}[stop]${c_reset} %s\n" "$*"; }
ok()   { printf "${c_grn}[stop]${c_reset} %s\n" "$*"; }
warn() { printf "${c_yel}[stop][warn]${c_reset} %s\n" "$*" >&2; }

# List PIDs listening on a TCP port (macOS/Linux via lsof; fallback to fuser).
listeners() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"${port}" -sTCP:LISTEN 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser "${port}/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true
  fi
}

# 1) If a detached stack pidfile exists, TERM that supervisor (its trap cleans up
#    its own children), then remove the pidfile.
PIDFILE="${ROOT_DIR}/.dev-logs/stack.pid"
if [[ -f "${PIDFILE}" ]]; then
  pid="$(cat "${PIDFILE}" 2>/dev/null || true)"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    info "Stopping detached supervisor (pid ${pid})..."
    kill -TERM "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
  fi
  rm -f "${PIDFILE}"
fi

# 2) Port sweep: TERM then (after a grace period) KILL anything still listening.
found=0
for port in "${PORTS[@]}"; do
  pids="$(listeners "${port}")"
  if [[ -n "${pids}" ]]; then
    found=1
    info "Port :${port} -> stopping $(echo "${pids}" | tr '\n' ' ')"
    # shellcheck disable=SC2086
    kill -TERM ${pids} 2>/dev/null || true
  fi
done

if [[ "${found}" -eq 1 ]]; then
  sleep 1 2>/dev/null || true
  for port in "${PORTS[@]}"; do
    pids="$(listeners "${port}")"
    if [[ -n "${pids}" ]]; then
      warn "Port :${port} still up -> SIGKILL $(echo "${pids}" | tr '\n' ' ')"
      # shellcheck disable=SC2086
      kill -KILL ${pids} 2>/dev/null || true
    fi
  done
  ok "VideoDubber stack stopped."
else
  ok "Nothing was running on the stack ports (already stopped)."
fi
