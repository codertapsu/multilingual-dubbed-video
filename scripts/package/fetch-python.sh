#!/usr/bin/env bash
#
# scripts/package/fetch-python.sh — Pre-install a standalone CPython into a Tauri
# RESOURCE dir so the packaged app's `uv` never has to download an interpreter at
# runtime.
#
# Why
# ---
# The optional Python engine packs (neural TTS, vocal separation, forced
# alignment) are materialized on the user's machine with `uv venv --python 3.12`.
# By default uv DOWNLOADS a managed standalone CPython from GitHub
# (astral-sh/python-build-standalone) on first use. On flaky / restricted
# international links (e.g. GitHub's release CDN from parts of Asia) that download
# fails with "error sending request for URL", and EVERY engine pack install dies.
#
# So at BUILD time (on CI, where GitHub is reachable) we have uv install the
# interpreter into apps/desktop/src-tauri/resources/python and bundle it. At
# RUNTIME the desktop shell points uv at it via UV_PYTHON_INSTALL_DIR +
# UV_PYTHON_DOWNLOADS=never (see apps/desktop/src-tauri/src/sidecar.rs), so pack
# installs use the bundled interpreter with no network for the runtime itself.
#
# Native only: uv installs the interpreter for the runner's own platform, which
# matches TARGET_TRIPLE because the release matrix builds each target natively.
#
# Env knobs
# ---------
#   TARGET_TRIPLE   Override the auto-detected Rust host triple (locating vd-uv).
#   PY_VERSION      CPython version to install (default 3.12 — matches uv.ts).
#   UV_BIN          Path to a uv binary to use (default: the staged vd-uv, then PATH).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)"
BIN_DIR="${REPO_ROOT}/apps/desktop/src-tauri/binaries"
DEST="${REPO_ROOT}/apps/desktop/src-tauri/resources/python"
PY_VERSION="${PY_VERSION:-3.12}"

resolve_triple() {
  if [[ -n "${TARGET_TRIPLE:-}" ]]; then echo "${TARGET_TRIPLE}"; return; fi
  if command -v rustc >/dev/null 2>&1; then rustc -Vv | sed -n 's/^host: //p'; return; fi
  echo "ERROR: rustc not found and TARGET_TRIPLE not set." >&2; exit 1
}
TRIPLE="$(resolve_triple)"
EXE_SUFFIX=""
case "${TRIPLE}" in *windows*) EXE_SUFFIX=".exe" ;; esac

# Locate uv: prefer the freshly-staged sidecar, then a uv on PATH.
UV="${UV_BIN:-}"
if [[ -z "${UV}" ]]; then
  if [[ -x "${BIN_DIR}/vd-uv-${TRIPLE}${EXE_SUFFIX}" ]]; then
    UV="${BIN_DIR}/vd-uv-${TRIPLE}${EXE_SUFFIX}"
  elif command -v uv >/dev/null 2>&1; then
    UV="$(command -v uv)"
  fi
fi
if [[ -z "${UV}" ]]; then
  echo "ERROR: no uv binary found (looked for ${BIN_DIR}/vd-uv-${TRIPLE}${EXE_SUFFIX} and 'uv' on PATH)." >&2
  echo "       Run fetch-uv.sh first, or set UV_BIN." >&2
  exit 1
fi

echo "==> Pre-installing CPython ${PY_VERSION} for the bundled uv"
echo "    uv:     ${UV}"
echo "    triple: ${TRIPLE}"
echo "    dest:   ${DEST}"

rm -rf "${DEST}"
mkdir -p "${DEST}"

UV_PYTHON_INSTALL_DIR="${DEST}" "${UV}" python install "${PY_VERSION}"

# uv adds a convenience alias (cpython-3.12-<triple>) that is an ABSOLUTE symlink
# to the versioned dir — it would dangle once bundled at a different path. Drop
# all top-level symlinks; uv still resolves the real versioned dir by scanning.
find "${DEST}" -maxdepth 1 -type l -exec rm -f {} +
# Remove uv's scratch/lock state (not needed in the bundle).
rm -rf "${DEST}/.temp" "${DEST}/.lock" 2>/dev/null || true

# Sanity: there must be a real cpython-* runtime left.
if ! find "${DEST}" -maxdepth 1 -type d -name 'cpython-*' | grep -q .; then
  echo "ERROR: no cpython-* runtime present in ${DEST} after install." >&2
  exit 1
fi

echo ""
echo "==> Bundled Python staged:"
find "${DEST}" -maxdepth 1 -type d -name 'cpython-*' -exec echo "    {}" \;
du -sh "${DEST}" 2>/dev/null | sed 's/^/    total: /' || true
