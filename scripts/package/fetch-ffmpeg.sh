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
# Sources (all ship -gpl/full builds WITH libass):
#   * macOS arm64/x64 : https://ffmpeg.martin-riedl.de  (static, notarized) — the
#                       default; or a libass `brew` build (FFMPEG_FROM_BREW=1).
#   * Windows x64     : https://github.com/BtbN/FFmpeg-Builds (win64-gpl .zip).
#   * Linux x64       : https://github.com/BtbN/FFmpeg-Builds (linux64-gpl .tar.xz).
#                       GitHub-hosted = reliable from CI; johnvansickle.com blocks
#                       datacenter IPs (curl exit 22) so it is NOT used here.
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

# Load .env (when run standalone) so the local-copy mode below can find a
# libass-enabled ffmpeg via FFMPEG_PATH/FFPROBE_PATH instead of downloading.
# build-sidecars.sh already loads it; this makes the script self-sufficient too.
if [[ -f "${REPO_ROOT}/.env" ]]; then set -a; . "${REPO_ROOT}/.env"; set +a; fi

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
  # 0755 (owner WRITE bit), not just +x: static ffmpeg archives ship read-only
  # (0555), and Tauri's macOS bundler runs `xattr -cr` on the bundled binaries
  # to strip extended attributes — which needs write permission, or it fails
  # with "failed to run xattr" (EACCES on a read-only file). Clear any download
  # quarantine too while we're here.
  chmod 0755 "${BIN_DIR}/ffmpeg-${TRIPLE}${EXE_SUFFIX}" "${BIN_DIR}/ffprobe-${TRIPLE}${EXE_SUFFIX}" || true
  xattr -c "${BIN_DIR}/ffmpeg-${TRIPLE}${EXE_SUFFIX}" "${BIN_DIR}/ffprobe-${TRIPLE}${EXE_SUFFIX}" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# macOS: copy from Homebrew (must have libass — `brew install ffmpeg` does on
# recent formulae) OR download a static notarized build from osxexperts.
# ---------------------------------------------------------------------------
fetch_macos() {
  # 1. Explicit Homebrew opt-in (FFMPEG_FROM_BREW=1). NOT auto-used, because
  #    Homebrew ffmpeg is dynamically linked to /opt/homebrew dylibs and is NOT
  #    portable — fine for local testing, wrong for a distributable installer.
  if [[ "${FFMPEG_FROM_BREW:-0}" == "1" ]] && command -v brew >/dev/null 2>&1; then
    local brew_ff=""
    local full_prefix; full_prefix="$(brew --prefix ffmpeg-full 2>/dev/null || true)"
    if [[ -n "${full_prefix}" && -x "${full_prefix}/bin/ffmpeg" ]]; then
      brew_ff="${full_prefix}/bin"
    else
      local prefix; prefix="$(brew --prefix ffmpeg 2>/dev/null || true)"
      [[ -n "${prefix}" && -x "${prefix}/bin/ffmpeg" ]] && brew_ff="${prefix}/bin"
    fi
    if [[ -n "${brew_ff}" ]]; then
      echo "==> Using Homebrew ffmpeg at ${brew_ff} (FFMPEG_FROM_BREW=1; NOT portable)."
      verify_and_stage "${brew_ff}/ffmpeg" "${brew_ff}/ffprobe"
      return
    fi
  fi

  # 2. Download a STATIC, libass-enabled, portable build. Default to the
  #    Martin-Riedl macOS arm64/x64 static release (signed+notarized, links only
  #    against macOS system frameworks — verified with `otool -L`). This is what
  #    makes the distributable .dmg self-contained. Override with FFMPEG_URL/
  #    FFPROBE_URL to pin a specific build.
  local arch="arm64"; case "${TRIPLE}" in x86_64-*) arch="amd64" ;; esac
  local ff_url="${FFMPEG_URL:-https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch}/release/ffmpeg.zip}"
  local fp_url="${FFPROBE_URL:-https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch}/release/ffprobe.zip}"
  echo "==> Downloading static ffmpeg:  ${ff_url}"
  curl -fsSL "${ff_url}" -o "${WORK}/ffmpeg.zip"
  echo "==> Downloading static ffprobe: ${fp_url}"
  curl -fsSL "${fp_url}" -o "${WORK}/ffprobe.zip"
  unzip -o -q "${WORK}/ffmpeg.zip" -d "${WORK}/ff"
  unzip -o -q "${WORK}/ffprobe.zip" -d "${WORK}/fp"
  verify_and_stage \
    "$(find "${WORK}/ff" -name ffmpeg -type f | head -n1)" \
    "$(find "${WORK}/fp" -name ffprobe -type f | head -n1)"
}

# Resolve the newest PERMANENT dated-autobuild asset URL via the GitHub API.
# BtbN's rolling `latest` release DELETES + re-uploads its assets on every
# rebuild (~hourly), so any releases/{latest/download,download/latest}/ URL 404s
# during that window. Dated `autobuild-*` releases are immutable once published,
# so we pick the newest one carrying the requested asset. $1 = filename suffix
# (e.g. "linux64-gpl.tar.xz"). Honors GITHUB_TOKEN to dodge API rate limits.
resolve_btbn_asset() {
  local suffix="$1"; local auth=()
  [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  curl -fsSL "${auth[@]}" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=15" \
    | python3 -c '
import sys, json
suffix = sys.argv[1]
for rel in json.load(sys.stdin):
    if not rel["tag_name"].startswith("autobuild-"):  # skip the rolling `latest`
        continue
    for a in rel.get("assets", []):
        n = a["name"]
        if n.endswith(suffix) and "shared" not in n:
            print(a["browser_download_url"]); sys.exit(0)
sys.exit(1)
' "$suffix"
}

# ---------------------------------------------------------------------------
# Linux: johnvansickle static release (amd64) — single tarball has both bins.
# ---------------------------------------------------------------------------
fetch_linux() {
  # BtbN GitHub builds: reliable from CI runners (GitHub-hosted), unlike
  # johnvansickle.com which rate-limits / blocks datacenter IPs (curl exit 22 in
  # CI). The -gpl build is static and includes libass (subtitles) + libx264/x265
  # (H.264/HEVC render). Binaries live under bin/ in a single ffmpeg-* top dir.
  # Resolve a permanent dated-autobuild asset via the API (see resolve_btbn_asset).
  local url="${FFMPEG_URL:-$(resolve_btbn_asset linux64-gpl.tar.xz)}"
  if [ -z "${url}" ]; then echo "ERROR: could not resolve a BtbN linux64-gpl asset from the GitHub API." >&2; exit 1; fi
  echo "==> Downloading ${url}"
  curl -fsSL --retry 3 --retry-delay 5 "${url}" -o "${WORK}/ffmpeg.tar.xz"
  tar -xJf "${WORK}/ffmpeg.tar.xz" -C "${WORK}"
  local dir; dir="$(find "${WORK}" -maxdepth 1 -type d -name 'ffmpeg-*' | head -n1)"
  verify_and_stage "${dir}/bin/ffmpeg" "${dir}/bin/ffprobe"
}

# ---------------------------------------------------------------------------
# Windows: gyan.dev release-full (has libass). Single zip has both bins under
# bin/. This branch is used by Git Bash / WSL on the runner; the .ps1 is the
# native path on Windows runners.
# ---------------------------------------------------------------------------
fetch_windows() {
  # BtbN GitHub builds: a .zip (no 7z needed) with libass + libx264/x265. gyan.dev
  # ships the *full* build only as .7z; its *.zip is 'essentials'. This branch is
  # the Git Bash / WSL path; fetch-ffmpeg.ps1 is the native Windows-runner path.
  # Resolve a permanent dated-autobuild asset via the API (see resolve_btbn_asset).
  local url="${FFMPEG_URL:-$(resolve_btbn_asset win64-gpl.zip)}"
  if [ -z "${url}" ]; then echo "ERROR: could not resolve a BtbN win64-gpl asset from the GitHub API." >&2; exit 1; fi
  echo "==> Downloading ${url}"
  curl -fsSL --retry 3 --retry-delay 5 "${url}" -o "${WORK}/ffmpeg.zip"
  unzip -o -q "${WORK}/ffmpeg.zip" -d "${WORK}/ff"
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
