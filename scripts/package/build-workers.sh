#!/usr/bin/env bash
#
# scripts/package/build-workers.sh — Freeze the three Python workers into
# self-contained sidecar binaries via PyInstaller.
#
# Output (in apps/desktop/src-tauri/binaries/):
#     vd-stt-worker-<target-triple>[.exe]
#     vd-translation-worker-<target-triple>[.exe]
#     vd-tts-worker-<target-triple>[.exe]
#     vd-piper-<target-triple>[.exe]        (frozen piper-tts CLI; spawned by
#                                            the TTS worker per segment)
#
# Tauri appends the Rust *target triple* to externalBin base names, so each
# sidecar MUST be suffixed with the triple of the host you build on
# (e.g. aarch64-apple-darwin, x86_64-pc-windows-msvc, x86_64-unknown-linux-gnu).
# Discover it with:  rustc -Vv | sed -n 's/^host: //p'
#
# Prerequisites
# -------------
#   * Each worker has a venv at workers/<worker>/.venv with its runtime deps
#     installed (scripts/setup-local-models.sh does this for dev). In CI we
#     create fresh venvs — see .github/workflows/release.yml.
#   * PyInstaller installed INTO each worker venv (this script installs it if
#     missing).
#
# Env knobs
# ---------
#   TARGET_TRIPLE   Override the auto-detected Rust host triple.
#   PYI_ONEFILE     "1" (default) one-file binary; "0" => one-dir (faster start,
#                   but Tauri externalBin expects a single file, so one-file is
#                   the supported mode here).
#   ONLY            Comma list to build a subset: stt,translation,tts
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)"
BIN_DIR="${REPO_ROOT}/apps/desktop/src-tauri/binaries"
PYI_TMP="${BIN_DIR}/.pyi"

# ---------------------------------------------------------------------------
# Resolve the Rust target triple (Tauri externalBin suffix).
# ---------------------------------------------------------------------------
resolve_triple() {
  if [[ -n "${TARGET_TRIPLE:-}" ]]; then
    echo "${TARGET_TRIPLE}"
    return
  fi
  if command -v rustc >/dev/null 2>&1; then
    rustc -Vv | sed -n 's/^host: //p'
    return
  fi
  echo "ERROR: rustc not found and TARGET_TRIPLE not set. Install Rust (rustup) or export TARGET_TRIPLE." >&2
  exit 1
}

TRIPLE="$(resolve_triple)"
EXE_SUFFIX=""
case "${TRIPLE}" in
  *windows*) EXE_SUFFIX=".exe" ;;
esac

echo "==> Building Python worker sidecars"
echo "    repo:    ${REPO_ROOT}"
echo "    triple:  ${TRIPLE}"
echo "    out:     ${BIN_DIR}"
mkdir -p "${BIN_DIR}"

# worker key | venv subdir | spec file | output base name
# NOTE: "piper" is not a worker service — it's the frozen piper-tts CLI the TTS
# worker spawns per segment. It builds from the TTS worker's venv.
WORKERS=(
  "stt|stt-worker|vd-stt-worker"
  "translation|translation-worker|vd-translation-worker"
  "tts|tts-worker|vd-tts-worker"
  "piper|tts-worker|vd-piper"
)

ONLY="${ONLY:-stt,translation,tts,piper}"

want() { [[ ",${ONLY}," == *",$1,"* ]]; }

build_one() {
  local key="$1" subdir="$2" base="$3"
  local worker_dir="${REPO_ROOT}/workers/${subdir}"
  local venv="${worker_dir}/.venv"
  local spec="${SCRIPT_DIR}/${base}.spec"

  if [[ ! -d "${venv}" ]]; then
    echo "ERROR: venv missing for ${key} worker at ${venv}." >&2
    echo "       Run scripts/setup-local-models.sh first, or create it in CI." >&2
    exit 1
  fi

  # Resolve the venv's python (POSIX layout; CI/Windows handled by the .ps1).
  local py="${venv}/bin/python"
  [[ -x "${py}" ]] || py="${venv}/bin/python3"

  echo ""
  echo "==> [${key}] PyInstaller -> ${base}${EXE_SUFFIX}"

  # Ensure PyInstaller is present in this worker's venv.
  "${py}" -m pip install --quiet --upgrade pyinstaller >/dev/null

  # The piper CLI freezes the piper-tts package, which is deliberately NOT in
  # the TTS worker's requirements.txt (the worker calls the binary, not the
  # package). Make sure it's present in the build venv (CI venvs are fresh).
  if [[ "${key}" == "piper" ]]; then
    "${py}" -m pip install --quiet "piper-tts>=1.4" >/dev/null
  fi

  local dist="${PYI_TMP}/${key}"
  local work="${PYI_TMP}/build-${key}"
  rm -rf "${dist}" "${work}"

  # IMPORTANT: run from REPO_ROOT so the .spec's `os.getcwd()` resolves the repo
  # root (the specs intentionally use cwd, not __file__, for portability).
  ( cd "${REPO_ROOT}" && "${py}" -m PyInstaller \
      --noconfirm --clean \
      --distpath "${dist}" \
      --workpath "${work}" \
      "${spec}" )

  local produced="${dist}/${base}${EXE_SUFFIX}"
  if [[ ! -f "${produced}" ]]; then
    echo "ERROR: expected ${produced} but it was not produced." >&2
    exit 1
  fi

  local target="${BIN_DIR}/${base}-${TRIPLE}${EXE_SUFFIX}"
  cp -f "${produced}" "${target}"
  chmod +x "${target}" || true
  echo "    -> ${target}"
}

for entry in "${WORKERS[@]}"; do
  IFS='|' read -r key subdir base <<<"${entry}"
  if want "${key}"; then
    build_one "${key}" "${subdir}" "${base}"
  else
    echo "==> [${key}] skipped (ONLY=${ONLY})"
  fi
done

echo ""
echo "==> Worker sidecars built:"
ls -1 "${BIN_DIR}"/vd-*-"${TRIPLE}"${EXE_SUFFIX} 2>/dev/null || true
