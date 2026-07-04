#!/usr/bin/env bash
#
# fetch-default-models.sh — stage the DEFAULT-pipeline models INTO the app bundle
# so a first dub for a bundled language pair works fully OFFLINE, out of the box
# (no first-run download):
#
#   - faster-whisper 'small'   (STT, multilingual) -> resources/default-models/huggingface
#   - the Argos pivot legs      (translation)        -> resources/default-models/argos
#   - the recommended Piper voice(s) (TTS)           -> resources/default-models/piper
#
# WHAT gets staged is NOT hardcoded here — it is derived from the single source of
# truth, packages/node-orchestrator/src/setup/defaultBundle.ts (DEFAULT_PAIRS),
# via the print-default-bundle.ts bridge. To add/change a bundled pair, edit that
# TS file and rebuild; this script restages automatically. Today the defaults are
# en->vi and zh->vi (zh->vi pivots through English, so it stages BOTH zh->en and
# en->vi Argos legs; the shared en->vi leg is staged once).
#
# At runtime the desktop shell (sidecar.rs) seed-copies these into the WRITABLE
# model dirs (<config>/models/{huggingface,argos,piper}) on first launch.
#
# Idempotent: skips a model whose staged output already exists. Override the
# whisper size with DEFAULT_WHISPER_MODEL; skip entirely with SKIP_DEFAULT_MODELS=1.
set -euo pipefail

[[ "${SKIP_DEFAULT_MODELS:-0}" == "1" ]] && { echo "SKIP_DEFAULT_MODELS=1 — skipping default-model staging."; exit 0; }

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"
DEST="apps/desktop/src-tauri/resources/default-models"

STT_PY="${STT_PY:-workers/stt-worker/.venv/bin/python}"
TR_PY="${TR_PY:-workers/translation-worker/.venv/bin/python}"

# --- Derive the staging plan from the single source of truth ------------------
# (packages/node-orchestrator/src/setup/defaultBundle.ts -> DEFAULT_PAIRS). The
# bridge prints tab-separated records: `whisper <m>` / `argos <from> <to>` /
# `piper <id> <onnxUrl> <onnxJsonUrl>`.
TSX="${REPO_ROOT}/node_modules/.bin/tsx"
BRIDGE="${REPO_ROOT}/packages/node-orchestrator/scripts/print-default-bundle.ts"
if [[ ! -x "${TSX}" ]]; then
  echo "::error:: tsx not found at ${TSX} — run 'pnpm install' first." >&2; exit 1
fi
if ! PLAN="$("${TSX}" "${BRIDGE}" --sh)"; then
  echo "::error:: failed to compute the default-bundle plan via ${BRIDGE}." >&2
  echo "          Build the workspace first (pnpm -r build, or at least" >&2
  echo "          'pnpm --filter @videodubber/shared build') so the bridge can import it." >&2
  exit 1
fi

# --- Staging helpers ----------------------------------------------------------
stage_whisper() {
  local size="$1"
  if compgen -G "${DEST}/huggingface/models--*faster-whisper-${size}" >/dev/null; then
    echo "==> whisper '${size}' already staged — skip"; return 0
  fi
  [[ -x "${STT_PY}" ]] || { echo "::error:: STT venv not found at ${STT_PY} (run scripts/setup-local-models.sh or build-workers first)"; exit 1; }
  echo "==> downloading faster-whisper '${size}' into the hub cache"
  "${STT_PY}" - "$size" "${DEST}/huggingface" <<'PY'
import sys
from faster_whisper import download_model
size, cache = sys.argv[1], sys.argv[2]
# cache_dir + output_dir=None -> downloads in the HF hub-cache layout the worker
# (WhisperModel(size, download_root=cache)) loads from, fully offline.
download_model(size, cache_dir=cache)
print("   staged whisper", size)
PY
}

stage_argos() {
  local from="$1" to="$2"
  # Per-pair skip guard (NOT all-or-nothing) so a newly-added leg still installs
  # when another pair's leg is already staged. The trailing `-` anchors the
  # version suffix so `en_vi-` can't false-match a longer code like `en_vie-`.
  if compgen -G "${DEST}/argos/translate-${from}_${to}-*" >/dev/null; then
    echo "==> Argos ${from}->${to} already staged — skip"; return 0
  fi
  [[ -x "${TR_PY}" ]] || { echo "::error:: translation venv not found at ${TR_PY}"; exit 1; }
  echo "==> downloading + installing Argos ${from}->${to} into ARGOS_PACKAGES_DIR"
  ARGOS_PACKAGES_DIR="${REPO_ROOT}/${DEST}/argos" "${TR_PY}" - "$from" "$to" <<'PY'
import sys
import argostranslate.package as pkg
frm, to = sys.argv[1], sys.argv[2]
pkg.update_package_index()
avail = pkg.get_available_packages()
p = next((x for x in avail if x.from_code == frm and x.to_code == to), None)
assert p is not None, f"Argos package {frm}->{to} not found in the index"
pkg.install_from_path(p.download())
print("   staged Argos", frm, "->", to)
PY
}

stage_piper() {
  local id="$1" url="$2" config_url="$3"
  local onnx="${DEST}/piper/${id}.onnx" cfg="${DEST}/piper/${id}.onnx.json"
  # Require BOTH files: a voice without its .onnx.json (sample rate / phoneme
  # config) can't load, so a half-staged voice must re-download, not skip.
  if [[ -f "${onnx}" && -f "${cfg}" ]]; then
    echo "==> Piper '${id}' already staged — skip"; return 0
  fi
  echo "==> downloading Piper voice ${id}"
  # Download to temp paths and only move into place once BOTH succeed, so a
  # mid-download failure never leaves a stray .onnx that masks the missing JSON
  # (the `if` condition keeps `set -e` from aborting before cleanup).
  if curl -fsSL "${url}" -o "${onnx}.part" && curl -fsSL "${config_url}" -o "${cfg}.part"; then
    mv -f "${onnx}.part" "${onnx}"
    mv -f "${cfg}.part" "${cfg}"
    echo "   staged Piper ${id}"
  else
    rm -f "${onnx}.part" "${cfg}.part"
    echo "::error:: failed to download Piper voice ${id}"; exit 1
  fi
}

echo "############################################################"
echo "# Staging default-pipeline models -> ${DEST}"
echo "${PLAN}" | sed 's/^/#   /'
echo "############################################################"
mkdir -p "${DEST}/huggingface" "${DEST}/argos" "${DEST}/piper"

# Drive staging from the plan. A here-string keeps the loop in THIS shell, so a
# helper's `exit 1` aborts the whole script (a pipe would subshell it).
while IFS=$'\t' read -r kind a b c; do
  case "$kind" in
    whisper) stage_whisper "$a" ;;
    argos)   stage_argos "$a" "$b" ;;
    piper)   stage_piper "$a" "$b" "$c" ;;
    '') ;;  # tolerate a trailing blank line
    *) echo "::warning:: unknown default-bundle record: ${kind}" >&2 ;;
  esac
done <<< "${PLAN}"

echo "==> default-model staging complete:"
# Informational only — never let a du/permission hiccup abort before the sentinel.
du -sh "${DEST}"/huggingface "${DEST}"/argos "${DEST}"/piper 2>/dev/null | sed 's/^/    /' || true
echo "DEFAULT_MODELS_STAGED_OK"
