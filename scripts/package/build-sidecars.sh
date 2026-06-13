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

# `resources/workers` is a DECLARED Tauri resource (the one-dir stt/translation/tts
# trees land here). It MUST exist at `tauri build` time even if SKIP_WORKERS was set,
# or the bundle step aborts on the missing declared resource. Guarantee it.
WORKERS_RES="${REPO_ROOT}/apps/desktop/src-tauri/resources/workers"
mkdir -p "${WORKERS_RES}"
[[ -n "$(ls -A "${WORKERS_RES}" 2>/dev/null)" ]] || \
  echo "One-dir Python worker trees (vd-stt/translation/tts-worker) are staged here at build time." > "${WORKERS_RES}/README.txt"

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

if [[ "${SKIP_PYTHON:-0}" != "1" ]]; then
  echo ""; echo "### Bundled CPython for uv (offline engine-pack installs) ###"
  # Non-fatal: if this fails, uv falls back to downloading CPython on first pack
  # install (needs network). Bundling it lets pack installs work on flaky links.
  bash "${SCRIPT_DIR}/fetch-python.sh" || echo "WARNING: python pre-install failed; engine packs will have uv download CPython on first install (needs a reliable connection to GitHub)." >&2
fi

# `resources/python` is a DECLARED Tauri resource (tauri.conf.json), so it MUST
# exist at `tauri build` time even if the optional pre-install above was skipped
# or failed — otherwise the bundle step aborts. Guarantee it (a placeholder keeps
# it non-empty; the runtime treats "no cpython-* inside" as "not bundled" and has
# uv download CPython on first use).
PY_RES="${REPO_ROOT}/apps/desktop/src-tauri/resources/python"
mkdir -p "${PY_RES}"
if ! find "${PY_RES}" -maxdepth 1 -name 'cpython-*' | grep -q .; then
  echo "Bundled CPython for uv is staged here by fetch-python at build time. If absent, the app downloads CPython on first engine-pack install." > "${PY_RES}/README.txt"
fi

if [[ "${SKIP_ENGINE_SRC:-0}" != "1" ]]; then
  echo ""; echo "### Engine-pack worker source (vd_tts_engine) ##############"
  # Cheap (copies a few Python files). Bundled as an app resource so the packaged
  # app can run the VieNeu neural-TTS pack with nothing for the user to install.
  # Node script (cross-platform) so POSIX + Windows stage it identically.
  node "${SCRIPT_DIR}/stage-engine-src.mjs"
fi

echo ""
echo "############################################################"
echo "# Done. Sidecars in ${BIN_DIR}:"
echo "############################################################"
ls -1 "${BIN_DIR}" | grep -E "^(videodubber-orchestrator|vd-piper|vd-uv|ffmpeg|ffprobe)-" || {
  echo "WARNING: no sidecars matched the expected naming. Check the logs above." >&2
}
echo "# One-dir worker trees in resources/workers:"
ls -1d "${REPO_ROOT}/apps/desktop/src-tauri/resources/workers"/*/ 2>/dev/null || echo "  (none)"

# Sanity: warn if any expected base is missing for this triple. The 3 server
# workers are one-dir trees under resources/workers/<base>/ (not single files).
EXE_SUFFIX=""
case "${TRIPLE}" in *windows*) EXE_SUFFIX=".exe" ;; esac
for base in videodubber-orchestrator vd-piper vd-uv ffmpeg ffprobe; do
  f="${BIN_DIR}/${base}-${TRIPLE}${EXE_SUFFIX}"
  [[ -f "${f}" ]] || echo "NOTE: missing ${f} (skipped or failed?)."
done
for base in vd-stt-worker vd-translation-worker vd-tts-worker; do
  d="${REPO_ROOT}/apps/desktop/src-tauri/resources/workers/${base}"
  [[ -x "${d}/${base}${EXE_SUFFIX}" ]] || echo "NOTE: missing one-dir worker ${d}/${base}${EXE_SUFFIX} (skipped or failed?)."
done
