#!/usr/bin/env bash
#
# scripts/package/build-sidecars.sh — Build ALL Tauri externalBin sidecars for a
# fully self-contained installer:
#
#   videodubber-orchestrator   (Node SEA)        <- build-orchestrator.sh
#   vd-stt-worker              (PyInstaller)     <- build-workers.sh
#   vd-translation-worker      (PyInstaller)     <- build-workers.sh
#   vd-tts-worker              (PyInstaller)     <- build-workers.sh
#   vd-piper                   (PyInstaller)     <- build-workers.sh (piper CLI)
#   ffmpeg / ffprobe           (static, libass)  <- fetch-ffmpeg.sh
#
# All land in apps/desktop/src-tauri/binaries/ suffixed with the Rust target
# triple (e.g. -aarch64-apple-darwin), which is exactly what tauri.conf.json's
# bundle.externalBin expects.
#
# Run from anywhere:  bash scripts/package/build-sidecars.sh
# Or via pnpm:        pnpm package:sidecars
#
# Env knobs (forwarded to the sub-scripts)
# ---------
#   TARGET_TRIPLE   Override the auto-detected Rust host triple.
#   SKIP_WORKERS    "1" => skip the PyInstaller worker sidecars.
#   SKIP_ORCH       "1" => skip the Node orchestrator sidecar.
#   SKIP_FFMPEG     "1" => skip the ffmpeg/ffprobe fetch.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)"
BIN_DIR="${REPO_ROOT}/apps/desktop/src-tauri/binaries"

# Load .env so machine-specific paths (FFMPEG_PATH/FFPROBE_PATH for the local
# ffmpeg-copy mode, PYTHON_PATH, etc.) are available to this script AND every
# sub-script it spawns. Without this, fetch-ffmpeg.sh can't find a local
# libass-enabled ffmpeg and falls back to a network download.
if [[ -f "${REPO_ROOT}/.env" ]]; then set -a; . "${REPO_ROOT}/.env"; set +a; fi

resolve_triple() {
  if [[ -n "${TARGET_TRIPLE:-}" ]]; then echo "${TARGET_TRIPLE}"; return; fi
  if command -v rustc >/dev/null 2>&1; then rustc -Vv | sed -n 's/^host: //p'; return; fi
  echo "ERROR: rustc not found and TARGET_TRIPLE not set." >&2; exit 1
}
TRIPLE="$(resolve_triple)"
export TARGET_TRIPLE="${TRIPLE}"

echo "############################################################"
echo "# VideoDubber — building self-contained sidecars"
echo "#   triple: ${TRIPLE}"
echo "#   out:    ${BIN_DIR}"
echo "############################################################"

mkdir -p "${BIN_DIR}"

if [[ "${SKIP_ORCH:-0}" != "1" ]]; then
  echo ""; echo "### Orchestrator ###########################################"
  bash "${SCRIPT_DIR}/build-orchestrator.sh"
fi

if [[ "${SKIP_WORKERS:-0}" != "1" ]]; then
  echo ""; echo "### Python workers #########################################"
  bash "${SCRIPT_DIR}/build-workers.sh"
fi

if [[ "${SKIP_FFMPEG:-0}" != "1" ]]; then
  echo ""; echo "### FFmpeg / ffprobe #######################################"
  bash "${SCRIPT_DIR}/fetch-ffmpeg.sh"
fi

if [[ "${SKIP_UV:-0}" != "1" ]]; then
  echo ""; echo "### uv (engine-pack Python env manager) ####################"
  # Non-fatal: a missing uv only disables the optional Python engine packs;
  # the base app + model downloads still work fully.
  bash "${SCRIPT_DIR}/fetch-uv.sh" || echo "WARNING: uv fetch failed; Python engine packs (neural TTS / separation / alignment) will be unavailable until uv is bundled or installed." >&2
fi

if [[ "${SKIP_ENGINE_SRC:-0}" != "1" ]]; then
  echo ""; echo "### Engine-pack worker source (vd_tts_engine) ##############"
  # Cheap (copies a few Python files). Bundled as an app resource so the packaged
  # app can run the VieNeu neural-TTS pack with nothing for the user to install.
  bash "${SCRIPT_DIR}/stage-engine-src.sh"
fi

echo ""
echo "############################################################"
echo "# Done. Sidecars in ${BIN_DIR}:"
echo "############################################################"
ls -1 "${BIN_DIR}" | grep -E "^(videodubber-orchestrator|vd-(stt|translation|tts)-worker|vd-piper|vd-uv|ffmpeg|ffprobe)-" || {
  echo "WARNING: no sidecars matched the expected naming. Check the logs above." >&2
}

# Sanity: warn if any expected base is missing for this triple.
EXE_SUFFIX=""
case "${TRIPLE}" in *windows*) EXE_SUFFIX=".exe" ;; esac
for base in videodubber-orchestrator vd-stt-worker vd-translation-worker vd-tts-worker vd-piper vd-uv ffmpeg ffprobe; do
  f="${BIN_DIR}/${base}-${TRIPLE}${EXE_SUFFIX}"
  [[ -f "${f}" ]] || echo "NOTE: missing ${f} (skipped or failed?)."
done
