#!/usr/bin/env bash
#
# scripts/start-services.sh — Start ONLY the backend services (no UI), in the
# foreground, with clean shutdown on SIGTERM/SIGINT.
#
#   * Node orchestrator   (port 5100)
#   * STT worker          (port 5101)
#   * Translation worker  (port 5102)
#   * TTS worker          (port 5103)
#
# This is what the Tauri desktop shell launches on startup so that opening the
# app brings the whole backend up, and quitting the app tears it down (the shell
# sends SIGTERM to this script, whose EXIT trap stops every child). It is a thin
# wrapper over scripts/dev.sh with the Angular UI disabled (SKIP_UI=1), so the
# desktop window itself is the UI.
#
# You can also run it directly to host just the backend (e.g. when developing
# the UI with `pnpm dev:desktop`, or driving the API from scripts/tests).
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
exec env SKIP_UI=1 bash "${SCRIPT_DIR}/dev.sh" "$@"
