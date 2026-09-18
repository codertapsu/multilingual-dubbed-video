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

# PINNED (not "latest"): the orchestrator can self-install this same uv release
# when no sidecar is bundled, and it verifies a per-platform sha256 pinned in
# packages/node-orchestrator/src/engines/uvBootstrap.ts. Keep the two in lockstep
# — a unit test fails the build if they drift. Override with UV_VERSION=latest
# for a one-off experiment.
UV_VERSION="${UV_VERSION:-0.12.1}"
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

# VERIFY. This binary is bundled into the installer and, on macOS, deep-signed
# with the maintainer's Developer ID and notarized — while the RUNTIME twin of
# this very fetch (engines/uvBootstrap.ts) has always checked a pinned sha256.
# The build-time path being the weaker of the two is backwards, so the same
# hashes are mirrored in pinned-downloads.json and enforced here.
PINS_FILE="${SCRIPT_DIR}/pinned-downloads.json"
expected=""
if [[ -f "${PINS_FILE}" && -z "${UV_URL:-}" && "${UV_VERSION}" != "latest" ]]; then
  # Hard requirement, not a soft skip. Under `set -e` a missing python3 would
  # abort inside the assignment below with a bare "command not found" and no
  # mention of pins; skipping instead would stage an UNVERIFIED uv into a
  # Developer-ID-signed, notarized app. UV_URL= opts out of the pin explicitly.
  command -v python3 >/dev/null 2>&1 || {
    echo "ERROR: python3 is required to read $(basename "${PINS_FILE}"), which holds the" >&2
    echo "       pinned sha256 for the uv this build bundles and signs." >&2
    echo "       Install python3, or set UV_URL=<archive> to opt out of the pin." >&2
    exit 1
  }
  expected="$(python3 -c '
import json, sys
pins = json.load(open(sys.argv[1])).get("uv", {})
# Only trust the hashes when they belong to the version we actually asked for.
print(pins.get(sys.argv[2], "") if pins.get("version") == sys.argv[3] else "")
' "${PINS_FILE}" "${TRIPLE}" "${UV_VERSION}")"
fi
if [[ -n "${expected}" ]]; then
  actual="$(shasum -a 256 "${archive}" 2>/dev/null | awk '{print $1}')"
  [[ -n "${actual}" ]] || actual="$(sha256sum "${archive}" | awk '{print $1}')"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "ERROR: uv archive failed its checksum." >&2
    echo "       expected ${expected}" >&2
    echo "       actual   ${actual}" >&2
    echo "       Refresh scripts/package/pinned-downloads.json (and UV_ARTIFACTS in" >&2
    echo "       packages/node-orchestrator/src/engines/uvBootstrap.ts — they must agree)." >&2
    exit 1
  fi
  echo "    sha256 OK (uv ${UV_VERSION} ${TRIPLE})"
else
  echo "WARNING: no pinned sha256 for uv ${UV_VERSION} on ${TRIPLE}; staging an UNVERIFIED binary." >&2
fi

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
