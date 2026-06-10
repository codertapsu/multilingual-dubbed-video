#!/usr/bin/env bash
#
# scripts/package/fetch-ffmpeg.sh — Fetch static, libass-enabled ffmpeg + ffprobe
# and stage them as Tauri externalBin sidecars.
#
# Output (in apps/desktop/src-tauri/binaries/):
#     ffmpeg-<target-triple>[.exe]
#     ffprobe-<target-triple>[.exe]
#
# Why libass? Burned-in subtitles use FFmpeg's `subtitles` filter, which requires
# a build linked against libass. The default Homebrew `ffmpeg` omits it; the
# static builds below include it. We verify with `ffmpeg -filters | grep subtitles`.
#
# Sources (all ship full/`-gpl` builds WITH libass):
#   * macOS arm64/x64 : https://www.osxexperts.net  (static, notarized) OR copy
#                       from `brew --prefix ffmpeg` if that build has libass.
#   * Windows x64     : https://www.gyan.dev/ffmpeg/builds (release-full)
#   * Linux x64       : https://johnvansickle.com/ffmpeg (release static) or BtbN.
#
# These URLs change with each release; pin a known-good version per platform via
# the env knobs below, or override the whole URL. The script is defensive: it
# checks the libass `subtitles` filter is present before staging.
#
# Env knobs
# ---------
#   TARGET_TRIPLE     Override the auto-detected Rust host triple.
#   FFMPEG_URL        Direct URL to an archive containing ffmpeg(+ffprobe).
#   FFMPEG_FROM_BREW  "1" => copy from `brew --prefix ffmpeg` (macOS only).
#   FFMPEG_VERSION    Version tag used in default URLs (best-effort).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)"
BIN_DIR="${REPO_ROOT}/apps/desktop/src-tauri/binaries"
WORK="${BIN_DIR}/.ffmpeg"

resolve_triple() {
  if [[ -n "${TARGET_TRIPLE:-}" ]]; then echo "${TARGET_TRIPLE}"; return; fi
  if command -v rustc >/dev/null 2>&1; then rustc -Vv | sed -n 's/^host: //p'; return; fi
  echo "ERROR: rustc not found and TARGET_TRIPLE not set." >&2; exit 1
}

TRIPLE="$(resolve_triple)"
EXE_SUFFIX=""
case "${TRIPLE}" in *windows*) EXE_SUFFIX=".exe" ;; esac

echo "==> Fetching libass-enabled ffmpeg/ffprobe"
echo "    triple: ${TRIPLE}"
mkdir -p "${BIN_DIR}" "${WORK}"
rm -rf "${WORK:?}/"*

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1}"

# ---------------------------------------------------------------------------
# Stage helper: copy a found ffmpeg/ffprobe pair to the triple-suffixed names
# after verifying the `subtitles` (libass) filter exists.
# ---------------------------------------------------------------------------
verify_and_stage() {
  local ffmpeg_src="$1" ffprobe_src="$2"
  if [[ ! -f "${ffmpeg_src}" || ! -f "${ffprobe_src}" ]]; then
    echo "ERROR: ffmpeg/ffprobe not found at expected paths:" >&2
    echo "       ffmpeg=${ffmpeg_src}" >&2
    echo "       ffprobe=${ffprobe_src}" >&2
    exit 1
  fi
  chmod +x "${ffmpeg_src}" "${ffprobe_src}" || true

  echo "==> Verifying libass (subtitles filter)..."
  # Capture first (avoids set -o pipefail / BSD-grep \b portability surprises).
  local _filters
  _filters="$("${ffmpeg_src}" -hide_banner -filters 2>/dev/null || true)"
  if ! printf '%s\n' "${_filters}" | grep -qi 'subtitles'; then
    echo "ERROR: this ffmpeg build is missing the 'subtitles' filter (no libass)." >&2
    echo "       Burned-in subtitles will not work. Use a -gpl/full static build." >&2
    exit 1
  fi
  echo "    libass OK."

  cp -f "${ffmpeg_src}" "${BIN_DIR}/ffmpeg-${TRIPLE}${EXE_SUFFIX}"
  cp -f "${ffprobe_src}" "${BIN_DIR}/ffprobe-${TRIPLE}${EXE_SUFFIX}"
  chmod +x "${BIN_DIR}/ffmpeg-${TRIPLE}${EXE_SUFFIX}" "${BIN_DIR}/ffprobe-${TRIPLE}${EXE_SUFFIX}" || true
}

# ---------------------------------------------------------------------------
# macOS: copy from Homebrew (must have libass — `brew install ffmpeg` does on
# recent formulae) OR download a static notarized build from osxexperts.
# ---------------------------------------------------------------------------
fetch_macos() {
  if [[ "${FFMPEG_FROM_BREW:-0}" == "1" ]] && command -v brew >/dev/null 2>&1; then
    local prefix; prefix="$(brew --prefix ffmpeg 2>/dev/null || true)"
    if [[ -n "${prefix}" && -x "${prefix}/bin/ffmpeg" ]]; then
      echo "==> Using Homebrew ffmpeg at ${prefix}"
      verify_and_stage "${prefix}/bin/ffmpeg" "${prefix}/bin/ffprobe"
      return
    fi
    echo "WARN: brew --prefix ffmpeg not usable; falling back to download." >&2
  fi

  # osxexperts hosts per-arch zips of ffmpeg and ffprobe separately.
  local arch="arm64"
  case "${TRIPLE}" in x86_64-*) arch="intel" ;; esac
  local ff_url="${FFMPEG_URL:-https://www.osxexperts.net/ffmpeg${FFMPEG_VERSION//./}${arch}.zip}"
  local fp_url="${FFPROBE_URL:-https://www.osxexperts.net/ffprobe${FFMPEG_VERSION//./}${arch}.zip}"

  echo "==> Downloading ffmpeg:  ${ff_url}"
  curl -fsSL "${ff_url}" -o "${WORK}/ffmpeg.zip"
  echo "==> Downloading ffprobe: ${fp_url}"
  curl -fsSL "${fp_url}" -o "${WORK}/ffprobe.zip"
  unzip -o -q "${WORK}/ffmpeg.zip" -d "${WORK}/ff"
  unzip -o -q "${WORK}/ffprobe.zip" -d "${WORK}/fp"
  verify_and_stage \
    "$(find "${WORK}/ff" -name ffmpeg -type f | head -n1)" \
    "$(find "${WORK}/fp" -name ffprobe -type f | head -n1)"
}

# ---------------------------------------------------------------------------
# Linux: johnvansickle static release (amd64) — single tarball has both bins.
# ---------------------------------------------------------------------------
fetch_linux() {
  local url="${FFMPEG_URL:-https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz}"
  echo "==> Downloading ${url}"
  curl -fsSL "${url}" -o "${WORK}/ffmpeg.tar.xz"
  tar -xJf "${WORK}/ffmpeg.tar.xz" -C "${WORK}"
  local dir; dir="$(find "${WORK}" -maxdepth 1 -type d -name 'ffmpeg-*-static' | head -n1)"
  verify_and_stage "${dir}/ffmpeg" "${dir}/ffprobe"
}

# ---------------------------------------------------------------------------
# Windows: gyan.dev release-full (has libass). Single zip has both bins under
# bin/. This branch is used by Git Bash / WSL on the runner; the .ps1 is the
# native path on Windows runners.
# ---------------------------------------------------------------------------
fetch_windows() {
  local url="${FFMPEG_URL:-https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z}"
  echo "==> Downloading ${url}"
  curl -fsSL "${url}" -o "${WORK}/ffmpeg.7z"
  if ! command -v 7z >/dev/null 2>&1; then
    echo "ERROR: 7z required to extract the gyan.dev build. Use the .ps1 on Windows runners." >&2
    exit 1
  fi
  7z x -y -o"${WORK}/ff" "${WORK}/ffmpeg.7z" >/dev/null
  local dir; dir="$(find "${WORK}/ff" -maxdepth 1 -type d -name 'ffmpeg-*' | head -n1)"
  verify_and_stage "${dir}/bin/ffmpeg.exe" "${dir}/bin/ffprobe.exe"
}

# ---------------------------------------------------------------------------
# Local-copy mode (any OS): stage an existing libass-enabled ffmpeg/ffprobe
# instead of downloading. Set FFMPEG_BIN+FFPROBE_BIN (or FFMPEG_PATH+FFPROBE_PATH),
# e.g. macOS `brew install ffmpeg-full`. Handy for LOCAL builds.
#   NOTE: dynamically-linked local binaries run on THIS machine but are NOT
#   portable (they depend on system dylibs). For distributable installers, CI
#   should use a STATIC libass build via the download branches above.
# ---------------------------------------------------------------------------
LOCAL_FFMPEG="${FFMPEG_BIN:-${FFMPEG_PATH:-}}"
LOCAL_FFPROBE="${FFPROBE_BIN:-${FFPROBE_PATH:-}}"
if [[ -n "${LOCAL_FFMPEG}" && -n "${LOCAL_FFPROBE}" ]]; then
  echo "==> Staging ffmpeg/ffprobe from local paths (not portable — local build only)."
  verify_and_stage "${LOCAL_FFMPEG}" "${LOCAL_FFPROBE}"
  echo ""
  echo "==> ffmpeg sidecars staged:"
  ls -1 "${BIN_DIR}"/ff{mpeg,probe}-"${TRIPLE}"${EXE_SUFFIX} 2>/dev/null || true
  exit 0
fi

case "${TRIPLE}" in
  *apple-darwin*) fetch_macos ;;
  *linux*)        fetch_linux ;;
  *windows*)      fetch_windows ;;
  *) echo "ERROR: unsupported triple ${TRIPLE} for ffmpeg fetch." >&2; exit 1 ;;
esac

echo ""
echo "==> ffmpeg sidecars staged:"
ls -1 "${BIN_DIR}"/ff{mpeg,probe}-"${TRIPLE}"${EXE_SUFFIX} 2>/dev/null || true
