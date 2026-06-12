#!/usr/bin/env bash
#
# scripts/package/stage-engine-src.sh — Stage the first-party engine-pack worker
# SOURCE into the Tauri bundle resources, so the packaged app can run the Python
# engine packs with NOTHING for the user to install.
#
# The `tts-neural` (VieNeu) pack runs `python -m vd_tts_engine` inside the uv
# venv, importing the `vd_tts_engine` package from PYTHONPATH. In a source build
# that PYTHONPATH resolves to the repo; in the packaged app there is no repo, so
# we bundle the package as an app RESOURCE and the shell points
# VIDEODUBBER_ENGINE_SRC_DIR at it (see src-tauri/src/sidecar.rs).
#
# Output: apps/desktop/src-tauri/resources/engine-src/vd_tts_engine/  (gitignored;
# tauri.conf.json bundles `resources/engine-src`).
#
# Run from anywhere: bash scripts/package/stage-engine-src.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)"

SRC="${REPO_ROOT}/workers/tts-engine-neural/vd_tts_engine"
DEST_DIR="${REPO_ROOT}/apps/desktop/src-tauri/resources/engine-src"

if [[ ! -d "${SRC}" ]]; then
  echo "ERROR: engine source not found at ${SRC}" >&2
  exit 1
fi

echo "==> Staging engine source: ${SRC} -> ${DEST_DIR}/vd_tts_engine"
rm -rf "${DEST_DIR}"
mkdir -p "${DEST_DIR}"
# Copy the package only (no tests/scripts/caches).
cp -R "${SRC}" "${DEST_DIR}/vd_tts_engine"
find "${DEST_DIR}" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
find "${DEST_DIR}" -type f -name '*.pyc' -delete 2>/dev/null || true

echo "==> Staged files:"
( cd "${DEST_DIR}" && find . -type f | sort )
