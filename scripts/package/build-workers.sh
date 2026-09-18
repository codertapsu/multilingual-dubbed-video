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
# Where the build interpreter comes from — READ THIS BEFORE CHANGING IT
# --------------------------------------------------------------------
# Until 2026-09 this script froze each worker from the maintainer's DEV venv
# (workers/<worker>/.venv), created by setup-local-models.sh from whatever
# `python3` was ambient. On the macOS release box that is Homebrew python@3.13 on
# a macOS 26 machine, and Homebrew bottles carry the build machine's OS in their
# Mach-O load commands. The PyInstaller launcher looked innocent (minos 11.0), but
# the 175+ CPython extension modules it dlopen()s — _internal/python3.13/
# lib-dynload/*.so, libssl, libcrypto, liblzma, libsqlite3 — were all stamped
# `minos 26.0`. dyld refuses those on any older Mac, so every worker died at
# `import zlib` while tauri.conf.json promised macOS 13.5+. v0.8.1 shipped that:
# 178 Mach-O files at minos 26.0 inside the published .app. It was invisible on
# the only validation machine, which runs macOS 26.
#
# So the release build no longer touches the dev venvs at all. It creates a
# THROWAWAY venv per worker from the standalone CPython the repo already bundles
# (apps/desktop/src-tauri/resources/python/cpython-3.12.13-*, minos 11.0 — the
# same interpreter the engine packs use at runtime, so macOS and Windows stop
# shipping different Python versions), installs that worker's requirements.txt
# into it, and freezes from there. A release is therefore a function of files in
# git, not of the maintainer's machine state.
#
# The residual macOS floor after this fix is NOT 11.0: numpy / onnxruntime / av
# publish only macosx_14_0_arm64 wheels, so those .so files land at minos 14.0.
# Capping them via `--python-platform macos` (= macosx_12_0) was measured and does
# NOT work: `av` 18.1.0 has no wheel at or below 12.0 and falls back to a source
# build that fails, and onnxruntime drops from 1.30.0 to 1.23.2.
#
# DECIDED 2026-09-18: bundle.macOS.minimumSystemVersion is 14.0, rather than
# hand-pinning an older wheel set that would then have to be re-pinned on every
# dependency bump. So 14.0 is the floor the whole toolchain derives from — this
# script's MACOSX_DEPLOYMENT_TARGET, build-sidecars.sh's minos gate, MIN_MACOS in
# commands.rs (which withholds the update offer from older Macs), and the
# download table in the release body. If a future wheel raises it again, the gate
# fails the build and names the offending file; move the number in
# tauri.conf.json and everything else follows.
#
# Prerequisites
# -------------
#   * uv (the staged apps/desktop/src-tauri/binaries/vd-uv-<triple>, or `uv` on
#     PATH) and the bundled CPython. build-sidecars.sh stages both BEFORE calling
#     this script for exactly that reason. If either is missing this script falls
#     back to the legacy dev-venv behaviour with a loud warning — a fallback that
#     must never be what cuts a release.
#
# Env knobs
# ---------
#   TARGET_TRIPLE   Override the auto-detected Rust host triple.
#   ONLY            Comma list to build a subset: stt,translation,tts,piper
#   VENV_MODE       "build" (default) throwaway venvs from the bundled CPython;
#                   "dev" reuses workers/<worker>/.venv (the pre-2026-09 behaviour).
#   BUILD_PYTHON    Explicit interpreter to seed the throwaway venvs with.
#   UV_BIN          Explicit uv binary.
#   WHEEL_PYTHON_PLATFORM
#                   Passed to `uv pip install --python-platform` (e.g. "macos" to
#                   cap wheels at macosx_12_0). Unset = resolve natively. See the
#                   measurement above before reaching for it.
#   MACOSX_DEPLOYMENT_TARGET
#                   Defaults to bundle.macOS.minimumSystemVersion from
#                   tauri.conf.json so anything compiled during the build targets
#                   the floor the installer declares.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)"
BIN_DIR="${REPO_ROOT}/apps/desktop/src-tauri/binaries"
PYI_TMP="${BIN_DIR}/.pyi"
# One-dir worker trees ship as a Tauri *resource* folder (externalBin only holds
# single files). The desktop shell launches each worker exe from here.
RES_WORKERS="${REPO_ROOT}/apps/desktop/src-tauri/resources/workers"
PY_RES="${REPO_ROOT}/apps/desktop/src-tauri/resources/python"
BUILD_REQS="${SCRIPT_DIR}/build-requirements.txt"
# piper's venv additionally pins piper-tts (see that file for why it is not in
# workers/tts-worker/requirements.txt).
BUILD_REQS_PIPER="${SCRIPT_DIR}/build-requirements-piper.txt"
# Throwaway build venvs live under the PyInstaller scratch dir, not in workers/,
# so nothing here can be mistaken for (or silently become) a dev venv.
BUILD_VENV_ROOT="${PYI_TMP}/venvs"

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

# ---------------------------------------------------------------------------
# macOS: build against the floor the installer declares, not the build host's OS.
# Read it from tauri.conf.json so the two cannot drift (build-sidecars.sh's gate
# compares the shipped binaries against the same value).
# ---------------------------------------------------------------------------
if [[ "${TRIPLE}" == *apple-darwin* ]]; then
  declared_min="14.0"
  if command -v node >/dev/null 2>&1; then
    declared_min="$(node -p "require('${REPO_ROOT}/apps/desktop/src-tauri/tauri.conf.json').bundle?.macOS?.minimumSystemVersion ?? '14.0'" 2>/dev/null || echo "14.0")"
  fi
  export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-${declared_min}}"
fi

# ---------------------------------------------------------------------------
# Locate uv + the bundled standalone CPython that seeds the build venvs.
# ---------------------------------------------------------------------------
UV=""
resolve_uv() {
  if [[ -n "${UV_BIN:-}" ]]; then UV="${UV_BIN}"; return; fi
  if [[ -x "${BIN_DIR}/vd-uv-${TRIPLE}${EXE_SUFFIX}" ]]; then
    UV="${BIN_DIR}/vd-uv-${TRIPLE}${EXE_SUFFIX}"; return
  fi
  if command -v uv >/dev/null 2>&1; then UV="$(command -v uv)"; return; fi
  UV=""
}

BUILD_PY=""
resolve_build_python() {
  if [[ -n "${BUILD_PYTHON:-}" ]]; then BUILD_PY="${BUILD_PYTHON}"; return; fi
  # fetch-python.sh strips the bin/python and bin/python3 aliases (Tauri's macOS
  # bundler dereferences symlinks, so each alias became another 18 MB copy), so
  # look for the versioned name. Windows keeps python.exe at the root.
  # Two explicit globs rather than python3.[0-9]* so `python3.12-config` can
  # never be picked as the interpreter.
  local _c
  for _c in "${PY_RES}"/cpython-*/bin/python3.[0-9] "${PY_RES}"/cpython-*/bin/python3.[0-9][0-9] "${PY_RES}"/cpython-*/python.exe; do
    if [[ -x "${_c}" ]]; then BUILD_PY="${_c}"; return; fi
  done
  BUILD_PY=""
}

VENV_MODE="${VENV_MODE:-build}"
if [[ "${VENV_MODE}" == "build" ]]; then
  resolve_uv
  resolve_build_python
  if [[ -z "${UV}" || -z "${BUILD_PY}" ]]; then
    echo "" >&2
    echo "############################################################" >&2
    echo "WARNING: falling back to the DEV venvs (workers/*/.venv)." >&2
    [[ -n "${UV}" ]]      || echo "  - no uv found (looked for ${BIN_DIR}/vd-uv-${TRIPLE}${EXE_SUFFIX} and 'uv' on PATH; run fetch-uv.sh)" >&2
    [[ -n "${BUILD_PY}" ]] || echo "  - no bundled CPython found under ${PY_RES}/cpython-* (run fetch-python.sh)" >&2
    echo "  The frozen workers will inherit whatever interpreter created those" >&2
    echo "  venvs. On macOS that is how v0.8.1 shipped workers stamped minos 26.0" >&2
    echo "  under a 13.5 floor. DO NOT cut a release from this path." >&2
    echo "############################################################" >&2
    echo "" >&2
    VENV_MODE="dev"
  fi
fi

echo "==> Building Python worker sidecars"
echo "    repo:    ${REPO_ROOT}"
echo "    triple:  ${TRIPLE}"
echo "    out:     ${BIN_DIR}"
echo "    venvs:   ${VENV_MODE}"
if [[ "${VENV_MODE}" == "build" ]]; then
  echo "    python:  ${BUILD_PY}"
  echo "    uv:      ${UV}"
fi
if [[ -n "${MACOSX_DEPLOYMENT_TARGET:-}" ]]; then
  echo "    macos:   MACOSX_DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET}"
fi
mkdir -p "${BIN_DIR}"

# key | worker subdir (its requirements.txt) | output base name | bundle mode
#   — four fields, split on "|" by the `read` at the bottom of this file. "piper"
#   deliberately reuses the tts-worker subdir for its .spec while prepare_build_venv
#   skips that worker's requirements.txt for it (see below).
# NOTE: "piper" is not a worker service — it's the frozen piper-tts CLI the TTS
# worker spawns per segment. It gets its OWN build venv holding nothing but
# piper-tts, so the TTS worker tree stops carrying piper's onnxruntime/sympy.
# The 3 server workers are one-dir (fast start, no per-launch extraction). piper
# is the on-demand CLI the TTS worker spawns by path — kept one-file (externalBin).
WORKERS=(
  "stt|stt-worker|vd-stt-worker|onedir"
  "translation|translation-worker|vd-translation-worker|onedir"
  "tts|tts-worker|vd-tts-worker|onedir"
  "piper|tts-worker|vd-piper|onefile"
)

ONLY="${ONLY:-stt,translation,tts,piper}"

want() { [[ ",${ONLY}," == *",$1,"* ]]; }

# ---------------------------------------------------------------------------
# Create the throwaway build venv for one worker and install its declared deps.
# Recreated from scratch on every run on purpose: the whole point is that the
# artifact depends on requirements.txt + build-requirements.txt and nothing else.
# ---------------------------------------------------------------------------
uv_pip_install_reqs() {
  # $1 = venv dir, $2 = requirements file. Kept as a function (rather than an
  # args array) because macOS still ships bash 3.2, where expanding an EMPTY
  # array under `set -u` aborts the script.
  local venv="$1" reqs="$2"
  if [[ -n "${WHEEL_PYTHON_PLATFORM:-}" ]]; then
    VIRTUAL_ENV="${venv}" "${UV}" pip install --quiet \
      --python-platform "${WHEEL_PYTHON_PLATFORM}" -r "${reqs}"
  else
    VIRTUAL_ENV="${venv}" "${UV}" pip install --quiet -r "${reqs}"
  fi
}

prepare_build_venv() {
  local key="$1" subdir="$2"
  local venv="${BUILD_VENV_ROOT}/${key}"
  local reqs="${REPO_ROOT}/workers/${subdir}/requirements.txt"

  echo "    - creating throwaway build venv: ${venv#"${REPO_ROOT}/"}"
  rm -rf "${venv}"
  mkdir -p "${BUILD_VENV_ROOT}"
  "${UV}" venv --quiet --python "${BUILD_PY}" "${venv}"

  # The piper CLI freezes ONLY piper-tts (see entry_piper.py) — it must not drag
  # the TTS worker's FastAPI stack into a one-file binary.
  local build_reqs="${BUILD_REQS}"
  if [[ "${key}" == "piper" ]]; then
    build_reqs="${BUILD_REQS_PIPER}"
  else
    echo "    - uv pip install -r workers/${subdir}/requirements.txt"
    uv_pip_install_reqs "${venv}" "${reqs}"
  fi
  echo "    - uv pip install -r ${build_reqs#"${SCRIPT_DIR}/"}"
  uv_pip_install_reqs "${venv}" "${build_reqs}"

  BUILD_VENV="${venv}"
}

build_one() {
  local key="$1" subdir="$2" base="$3" mode="$4"
  local worker_dir="${REPO_ROOT}/workers/${subdir}"
  local spec="${SCRIPT_DIR}/${base}.spec"
  local venv

  echo ""
  echo "==> [${key}] PyInstaller -> ${base}${EXE_SUFFIX}"

  if [[ "${VENV_MODE}" == "build" ]]; then
    prepare_build_venv "${key}" "${subdir}"
    venv="${BUILD_VENV}"
  else
    venv="${worker_dir}/.venv"
    if [[ ! -d "${venv}" ]]; then
      echo "ERROR: venv missing for ${key} worker at ${venv}." >&2
      echo "       Run scripts/setup-local-models.sh first, or unset VENV_MODE to build from the bundled CPython." >&2
      exit 1
    fi
  fi

  # Resolve the venv's python (POSIX layout; CI/Windows handled by the .ps1).
  local py="${venv}/bin/python"
  [[ -x "${py}" ]] || py="${venv}/bin/python3"

  if [[ "${VENV_MODE}" == "dev" ]]; then
    # Legacy path: the dev venv predates build-requirements.txt, so install the
    # pinned freezer into it. Never `--upgrade` — that is what made every build
    # silently adopt whatever PyInstaller PyPI served that morning.
    local dev_reqs="${BUILD_REQS}"
    [[ "${key}" == "piper" ]] && dev_reqs="${BUILD_REQS_PIPER}"
    "${py}" -m pip install --quiet -r "${dev_reqs}" >/dev/null
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

  if [[ "${mode}" == "onedir" ]]; then
    # COLLECT output: ${dist}/${base}/ (the exe + its _internal/ libs). Ship the
    # whole tree as a resource folder; the desktop shell launches the exe by path.
    local produced_dir="${dist}/${base}"
    local produced_exe="${produced_dir}/${base}${EXE_SUFFIX}"
    if [[ ! -f "${produced_exe}" ]]; then
      echo "ERROR: expected ${produced_exe} but it was not produced." >&2
      exit 1
    fi
    local target_dir="${RES_WORKERS}/${base}"
    mkdir -p "${RES_WORKERS}"
    rm -rf "${target_dir}"
    cp -R "${produced_dir}" "${target_dir}"
    chmod +x "${target_dir}/${base}${EXE_SUFFIX}" || true
    echo "    -> ${target_dir}/ (one-dir)"
  else
    local produced="${dist}/${base}${EXE_SUFFIX}"
    if [[ ! -f "${produced}" ]]; then
      echo "ERROR: expected ${produced} but it was not produced." >&2
      exit 1
    fi
    local target="${BIN_DIR}/${base}-${TRIPLE}${EXE_SUFFIX}"
    cp -f "${produced}" "${target}"
    chmod +x "${target}" || true
    echo "    -> ${target}"
  fi
}

for entry in "${WORKERS[@]}"; do
  IFS='|' read -r key subdir base mode <<<"${entry}"
  if want "${key}"; then
    build_one "${key}" "${subdir}" "${base}" "${mode}"
  else
    echo "==> [${key}] skipped (ONLY=${ONLY})"
  fi
done

echo ""
echo "==> Worker sidecars built:"
ls -1 "${BIN_DIR}"/vd-*-"${TRIPLE}"${EXE_SUFFIX} 2>/dev/null || true
echo "    one-dir worker trees:"
ls -1d "${RES_WORKERS}"/*/ 2>/dev/null || true
if [[ "${VENV_MODE}" == "dev" ]]; then
  echo ""
  echo "WARNING: built from the DEV venvs — not reproducible, and on macOS not" >&2
  echo "         portable below the build host's OS. See the header of this script." >&2
fi
