#!/usr/bin/env bash
#
# scripts/package/fetch-uv.sh — Fetch the `uv` binary (Astral) and stage it as a
# Tauri externalBin sidecar `vd-uv-<target-triple>`.
#
# Why bundle uv? The optional "engine packs" that run in Python (neural TTS,
# vocal separation, forced alignment) are materialized into a self-contained
# uv-managed environment. uv can also download its OWN standalone CPython, so
# with uv bundled the user needs NOTHING preinstalled — they just open the app
# and click "Install" on an engine. See packages/node-orchestrator/src/engines.
#
# uv publishes per-target release assets whose triples match Rust's host triple
# for the platforms we ship:
#   aarch64-apple-darwin, x86_64-apple-darwin,
#   x86_64-pc-windows-msvc,
#   x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu
#
# Env knobs
# ---------
#   TARGET_TRIPLE   Override the auto-detected Rust host triple.
#   UV_VERSION      Pin a uv release (e.g. "0.9.2"); default "latest".
#   UV_URL          Override the full archive URL.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)"
BIN_DIR="${REPO_ROOT}/apps/desktop/src-tauri/binaries"
WORK="${BIN_DIR}/.uv"

resolve_triple() {
  if [[ -n "${TARGET_TRIPLE:-}" ]]; then echo "${TARGET_TRIPLE}"; return; fi
  if command -v rustc >/dev/null 2>&1; then rustc -Vv | sed -n 's/^host: //p'; return; fi
  echo "ERROR: rustc not found and TARGET_TRIPLE not set." >&2; exit 1
}

TRIPLE="$(resolve_triple)"
EXE_SUFFIX=""
case "${TRIPLE}" in *windows*) EXE_SUFFIX=".exe" ;; esac

echo "==> Fetching uv (self-contained Python env manager for engine packs)"
echo "    triple: ${TRIPLE}"
mkdir -p "${BIN_DIR}" "${WORK}"
rm -rf "${WORK:?}/"*

UV_VERSION="${UV_VERSION:-latest}"
# uv archives: .zip for windows, .tar.gz elsewhere; the archive root contains
# `uv-<triple>/uv[.exe]`.
ARCHIVE_EXT="tar.gz"
case "${TRIPLE}" in *windows*) ARCHIVE_EXT="zip" ;; esac

if [[ -n "${UV_URL:-}" ]]; then
  url="${UV_URL}"
elif [[ "${UV_VERSION}" == "latest" ]]; then
  url="https://github.com/astral-sh/uv/releases/latest/download/uv-${TRIPLE}.${ARCHIVE_EXT}"
else
  url="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${TRIPLE}.${ARCHIVE_EXT}"
fi

echo "==> Downloading ${url}"
archive="${WORK}/uv.${ARCHIVE_EXT}"
curl -fsSL "${url}" -o "${archive}"

echo "==> Extracting..."
mkdir -p "${WORK}/x"
if [[ "${ARCHIVE_EXT}" == "zip" ]]; then
  unzip -o -q "${archive}" -d "${WORK}/x"
else
  tar -xzf "${archive}" -C "${WORK}/x"
fi

uv_src="$(find "${WORK}/x" -name "uv${EXE_SUFFIX}" -type f | head -n1)"
if [[ -z "${uv_src}" || ! -f "${uv_src}" ]]; then
  echo "ERROR: uv binary not found in the downloaded archive." >&2
  exit 1
fi
chmod +x "${uv_src}" || true

# Sanity: the binary runs.
"${uv_src}" --version >/dev/null 2>&1 || { echo "ERROR: downloaded uv is not runnable." >&2; exit 1; }

target="${BIN_DIR}/vd-uv-${TRIPLE}${EXE_SUFFIX}"
cp -f "${uv_src}" "${target}"
chmod +x "${target}" || true

echo ""
echo "==> uv sidecar staged:"
ls -1 "${target}"
"${target}" --version 2>/dev/null | sed 's/^/    /'
