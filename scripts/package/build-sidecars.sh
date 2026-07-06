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

# `resources/default-models` is a DECLARED Tauri resource — always exists.
DM_RES="${REPO_ROOT}/apps/desktop/src-tauri/resources/default-models"
# Bundling the default models is OPT-IN (BUNDLE_DEFAULT_MODELS=1): it makes a
# first en->vi / zh->vi dub work fully offline, but adds ~1 GB to the installer.
# The DEFAULT is a small installer that downloads the models on first run (like
# v0.2.0) — the runtime seed-copy (sidecar.rs) simply no-ops when none are bundled.
if [[ "${BUNDLE_DEFAULT_MODELS:-0}" == "1" ]]; then
  echo ""; echo "### Default-pipeline models — BUNDLED (offline out-of-box, +~1 GB) ###"
  # WHICH pairs is the single source of truth defaultBundle.ts (today en->vi +
  # zh->vi); the staging script derives the rest. The assertion below then fails
  # the release if any bundled pair's models are missing.
  bash "${SCRIPT_DIR}/fetch-default-models.sh" || \
    echo "WARNING: default-model staging failed; the installer will need a first-run download." >&2
else
  echo ""; echo "### Default-pipeline models — NOT bundled (small installer; download on first run) ###"
  # Clear any previously-staged models so a small build never carries them.
  rm -rf "${DM_RES}/huggingface" "${DM_RES}/argos" "${DM_RES}/piper"
fi
mkdir -p "${DM_RES}"
[[ -n "$(ls -A "${DM_RES}" 2>/dev/null)" ]] || \
  echo "Default-pipeline models are bundled here only when BUNDLE_DEFAULT_MODELS=1 (offline out-of-box dub); otherwise the app downloads them on first run." > "${DM_RES}/README.txt"

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

# --- Release bundle assertion ------------------------------------------------
# A RELEASE must ship the bundled uv + CPython (so the optional Python engine
# packs install with NOTHING preinstalled), and — WHEN opted into bundling the
# default models — those too. Fail the build rather than silently ship a degraded
# installer. Set ASSERT_BUNDLE=0 to downgrade to warnings for a partial build.
if [[ "${ASSERT_BUNDLE:-1}" == "1" ]]; then
  miss=0
  need() { if compgen -G "$2" >/dev/null; then :; else echo "::error:: missing bundled $1 ($2)"; miss=1; fi; }
  if [[ "${BUNDLE_DEFAULT_MODELS:-0}" == "1" ]]; then
    need "default whisper model" "${DM_RES}/huggingface/models--*"
    # Assert EACH bundled pair's Argos leg + Piper voice individually, derived from
    # the SAME source of truth the staging used (defaultBundle.ts via the bridge).
    # A pair-agnostic glob (argos/*) would pass even with a pair missing — this
    # loop is the real release gate the bundled-pairs feature relies on.
    if plan="$("${REPO_ROOT}/node_modules/.bin/tsx" "${REPO_ROOT}/packages/node-orchestrator/scripts/print-default-bundle.ts" --sh 2>/dev/null)"; then
      while IFS=$'\t' read -r kind a b _; do
        case "$kind" in
          # Anchor the version suffix (`-`) so a leg can't false-match a longer
          # language code (en_vi- vs en_vie-).
          argos) need "Argos ${a}->${b}" "${DM_RES}/argos/translate-${a}_${b}-"* ;;
          # A Piper voice needs BOTH the model AND its .onnx.json config to load.
          piper) need "Piper voice ${a}" "${DM_RES}/piper/${a}.onnx"
                 need "Piper config ${a}" "${DM_RES}/piper/${a}.onnx.json" ;;
        esac
      done <<< "$plan"
    else
      echo "::error:: could not compute the default-bundle plan for the release assertion"; miss=1
    fi
  fi
  [[ "${SKIP_UV:-0}" == "1" ]]     || need "uv binary"        "${BIN_DIR}/vd-uv-${TRIPLE}${EXE_SUFFIX}"
  [[ "${SKIP_PYTHON:-0}" == "1" ]] || need "bundled CPython"  "${PY_RES}/cpython-"*
  if [[ "${miss}" == "1" ]]; then
    echo "::error:: release bundle is MISSING required built-in dependencies (see above)." >&2
    echo "          Re-run with network, or set ASSERT_BUNDLE=0 to ship a degraded build on purpose." >&2
    exit 1
  fi
  echo "✓ bundle assertion passed: default models + uv + CPython are all bundled."
fi
