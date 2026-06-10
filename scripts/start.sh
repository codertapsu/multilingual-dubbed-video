#!/usr/bin/env bash
#
# scripts/start.sh — Start the ENTIRE VideoDubber stack DETACHED (one command).
#
# Usage:
#   ./scripts/start.sh       # or: pnpm start
#
# Unlike `pnpm dev` (which runs in the foreground and stops on Ctrl-C), this
# launches the full stack in the background and returns your terminal. Stop it
# any time with `pnpm stop` (scripts/stop.sh).
#
# Logs go to .dev-logs/. The supervisor PID is written to .dev-logs/stack.pid.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
cd "${ROOT_DIR}"

if [[ -f "${ROOT_DIR}/.env" ]]; then set -a; . "${ROOT_DIR}/.env"; set +a; fi

ANGULAR_PORT="${ANGULAR_PORT:-1420}"
ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-5100}"
LOG_DIR="${ROOT_DIR}/.dev-logs"
PIDFILE="${LOG_DIR}/stack.pid"
mkdir -p "${LOG_DIR}"

c_reset="\033[0m"; c_grn="\033[32m"; c_yel="\033[33m"; c_blu="\033[34m"
info() { printf "${c_blu}[start]${c_reset} %s\n" "$*"; }
ok()   { printf "${c_grn}[start]${c_reset} %s\n" "$*"; }
warn() { printf "${c_yel}[start][warn]${c_reset} %s\n" "$*" >&2; }

# Refuse to double-start if the orchestrator/UI ports are already in use.
already() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}
if already "${ORCHESTRATOR_PORT}" || already "${ANGULAR_PORT}"; then
  warn "Something is already listening on :${ORCHESTRATOR_PORT} or :${ANGULAR_PORT}."
  warn "Run 'pnpm stop' first, or it may already be running. Aborting."
  exit 1
fi

info "Starting the full stack in the background..."
# nohup so closing the terminal doesn't HUP the stack; dev.sh manages + cleans
# up its own children (and is itself stopped by 'pnpm stop' via the pidfile).
nohup bash "${ROOT_DIR}/scripts/dev.sh" >"${LOG_DIR}/stack.log" 2>&1 </dev/null &
SUPERVISOR_PID=$!
echo "${SUPERVISOR_PID}" >"${PIDFILE}"
disown 2>/dev/null || true

ok "VideoDubber stack is starting (supervisor pid ${SUPERVISOR_PID})."
echo "  ----------------------------------------------------------------"
printf "  %-14s %s\n" "Angular UI:"   "http://localhost:${ANGULAR_PORT}"
printf "  %-14s %s\n" "Orchestrator:" "http://127.0.0.1:${ORCHESTRATOR_PORT}"
printf "  %-14s %s\n" "Logs:"         "${LOG_DIR}/ (stack.log + per-service)"
printf "  %-14s %s\n" "Stop:"         "pnpm stop"
echo "  ----------------------------------------------------------------"
echo "  Tip: services take a few seconds to come up. Check 'pnpm verify'."
