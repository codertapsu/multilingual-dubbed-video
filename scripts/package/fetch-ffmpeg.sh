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
# These binaries are bundled into the installer and, on macOS, deep-signed with
# the maintainer's Developer ID and notarized — the strongest distribution wrapper
# we have, wrapped around a payload that used to be fetched from
# `/redirect/latest/` with no version and no checksum. So the URL and its sha256
# are PINNED in scripts/package/pinned-downloads.json and verified after download.
# The script is also defensive about capability: it checks the libass `subtitles`
# filter is present before staging.
#
# Env knobs
# ---------
#   TARGET_TRIPLE     Override the auto-detected Rust host triple.
#   FFMPEG_URL        Direct URL to an archive containing ffmpeg(+ffprobe).
#   FFMPEG_FROM_BREW  "1" => copy from `brew --prefix ffmpeg` (macOS only).
#                     NOT portable — rejected for release builds by the
#                     portability check unless the brew build is static.
#   FFMPEG_BIN /      Stage these exact binaries instead of downloading
#   FFPROBE_BIN       (build-time opt-in; must be a STATIC build). The runtime
#                     FFMPEG_PATH/FFPROBE_PATH are deliberately NOT honored here.
#   FFMPEG_PINS       "0" => resolve the newest upstream build instead of the
#                     pinned one (development only; the download is then NOT
#                     checksum-verified and the build is not reproducible).
#
# Pinned URLs + sha256 live in scripts/package/pinned-downloads.json. Overriding
# FFMPEG_URL / FFPROBE_URL / FFMPEG_BIN bypasses the pin AND its checksum — those
# are dev knobs, not release knobs.
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

PINS_FILE="${SCRIPT_DIR}/pinned-downloads.json"

# The pins are read with python3 (the interpreter release-upload.sh next door
# already uses for JSON). Check it ONCE and fail loudly, because the alternative
# failure is silent in the two ways that matter: under `set -e` a missing python3
# aborts the build inside a `$(pin ...)` assignment with a bare "command not
# found" and no mention of pins, and a lenient skip would stage an UNVERIFIED
# ffmpeg into a Developer-ID-signed, notarized app — the exact outcome the pins
# exist to prevent. The Git Bash / WSL branches below are where python3 is most
# likely to be absent. FFMPEG_PINS=0 opts out explicitly and loudly instead.
if [[ -f "${PINS_FILE}" && "${FFMPEG_PINS:-1}" == "1" ]] \
   && ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required to read $(basename "${PINS_FILE}"), which holds the" >&2
  echo "       pinned url + sha256 for the ffmpeg this build bundles and signs." >&2
  echo "       Install python3, or set FFMPEG_PINS=0 to download an UNVERIFIED build." >&2
  exit 1
fi

# Read one pinned value, e.g. `pin ffmpeg "${TRIPLE}" ffmpeg url`. Prints nothing
# (exit 0) when the path is absent, so callers can fall back deliberately.
pin() {
  [[ -f "${PINS_FILE}" ]] || return 0
  # Honour the opt-out HERE, not only at the call sites: every branch below calls
  # pin() unconditionally and only *then* decides whether to use the result, so
  # without this FFMPEG_PINS=0 would still shell out to python3 — and would still
  # fail on a box that has none, which is the one thing the opt-out is for.
  [[ "${FFMPEG_PINS:-1}" == "1" ]] || return 0
  python3 -c '
import json, sys
node = json.load(open(sys.argv[1]))
for key in sys.argv[2:]:
    if not isinstance(node, dict) or key not in node:
        sys.exit(0)
    node = node[key]
print(node if isinstance(node, str) else "")
' "${PINS_FILE}" "$@"
}

# Fail the build when a bundled download does not match its pin. A mismatch means
# the pin is stale (upstream re-cut the build) or the bytes are not what was
# reviewed — neither may be signed and shipped on a shrug.
verify_sha256() {
  local file="$1" expected="$2" label="$3"
  if [[ -z "${expected}" ]]; then
    echo "WARNING: no pinned sha256 for ${label}; staging an UNVERIFIED binary into a signed app." >&2
    return 0
  fi
  local actual
  actual="$(shasum -a 256 "${file}" 2>/dev/null | awk '{print $1}')"
  [[ -n "${actual}" ]] || actual="$(sha256sum "${file}" | awk '{print $1}')"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "ERROR: ${label} failed its checksum." >&2
    echo "       expected ${expected}" >&2
    echo "       actual   ${actual}" >&2
    echo "       Refresh the pin in scripts/package/pinned-downloads.json (see the '//' notes there)." >&2
    exit 1
  fi
  echo "    sha256 OK (${label})"
}

# ---------------------------------------------------------------------------
# Stage helper: copy a found ffmpeg/ffprobe pair to the triple-suffixed names
# after verifying the `subtitles` (libass) filter exists.
# ---------------------------------------------------------------------------
##
# Refuse a binary that depends on libraries the USER'S machine won't have.
#
# WHY THIS IS A HARD ERROR: a dynamically-linked ffmpeg runs perfectly on the
# build machine and then fails to launch on every other Mac — and because
# ffmpeg drives probe/extract/render, EVERY dub fails, not some edge case. This
# actually shipped: v0.3.0's macOS bundle linked
# /opt/homebrew/Cellar/ffmpeg-full/8.1.2_1/lib/*.dylib. The Windows script has
# always required a static single-file build; this is the missing bash half.
#
# Allowed: OS-guaranteed locations only (/usr/lib, /System/Library on macOS;
# the core glibc set on Linux). Anything under /opt, /usr/local, $HOME, or a
# relative @rpath/@loader_path is a build-machine artifact.
assert_portable() {
  local bin="$1" label="$2"
  case "$(uname -s)" in
    Darwin)
      command -v otool >/dev/null 2>&1 || return 0
      local bad
      bad="$(otool -L "${bin}" 2>/dev/null | tail -n +2 | awk '{print $1}' \
        | grep -v -E '^(/usr/lib/|/System/Library/)' || true)"
      if [[ -n "${bad}" ]]; then
        echo "ERROR: ${label} is NOT portable — it links non-system libraries:" >&2
        printf '       %s\n' ${bad} >&2
        echo "       Those paths exist only on this build machine, so the app would fail" >&2
        echo "       on every other Mac (all dubbing needs ffmpeg)." >&2
        echo "       Fix: unset FFMPEG_PATH/FFPROBE_PATH (and FFMPEG_BIN/FFPROBE_BIN) so this" >&2
        echo "       script downloads a STATIC build, or point them at a static ffmpeg." >&2
        exit 1
      fi
      ;;
    Linux)
      command -v ldd >/dev/null 2>&1 || return 0
      local bad_l
      bad_l="$(ldd "${bin}" 2>/dev/null | awk '{print $1}' \
        | grep -v -E '^(linux-vdso|libc\.so|libm\.so|libdl\.so|libpthread\.so|librt\.so|ld-linux|libgcc_s\.so|libstdc\+\+\.so)' \
        | grep -E '^lib' || true)"
      if [[ -n "${bad_l}" ]]; then
        echo "ERROR: ${label} is NOT portable — it needs non-core libraries:" >&2
        printf '       %s\n' ${bad_l} >&2
        echo "       Use a STATIC build (unset FFMPEG_PATH/FFPROBE_BIN to auto-download one)." >&2
        exit 1
      fi
      ;;
  esac
}

verify_and_stage() {
  local ffmpeg_src="$1" ffprobe_src="$2"
  if [[ ! -f "${ffmpeg_src}" || ! -f "${ffprobe_src}" ]]; then
    echo "ERROR: ffmpeg/ffprobe not found at expected paths:" >&2
    echo "       ffmpeg=${ffmpeg_src}" >&2
    echo "       ffprobe=${ffprobe_src}" >&2
    exit 1
  fi
  chmod +x "${ffmpeg_src}" "${ffprobe_src}" || true

  # Portability BEFORE anything else: staging a machine-local build is the one
  # failure that silently survives the whole release pipeline (it signs,
  # notarizes, and installs — it just can't run).
  echo "==> Verifying portability (no build-machine libraries)..."
  assert_portable "${ffmpeg_src}" "ffmpeg (${ffmpeg_src})"
  assert_portable "${ffprobe_src}" "ffprobe (${ffprobe_src})"
  echo "    portable OK."

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

  # 2. Download a STATIC, libass-enabled, portable build: the Martin-Riedl macOS
  #    arm64/x64 static release (signed+notarized, links only against macOS system
  #    frameworks — verified with `otool -L`). This is what makes the distributable
  #    .dmg self-contained.
  #
  #    The URL is the PERMANENT versioned path from pinned-downloads.json, not
  #    `/redirect/latest/`: the redirect meant two releases cut a month apart
  #    carried different, unrecorded ffmpeg builds — the shipped 0.9.0 binary is
  #    ffmpeg 9.0 and nothing in the repo or the release says so.
  local arch="arm64"; case "${TRIPLE}" in x86_64-*) arch="amd64" ;; esac
  local ff_url fp_url ff_sha fp_sha
  ff_url="$(pin ffmpeg "${TRIPLE}" ffmpeg url)"
  fp_url="$(pin ffmpeg "${TRIPLE}" ffprobe url)"
  ff_sha="$(pin ffmpeg "${TRIPLE}" ffmpeg sha256)"
  fp_sha="$(pin ffmpeg "${TRIPLE}" ffprobe sha256)"
  if [[ "${FFMPEG_PINS:-1}" != "1" || -z "${ff_url}" ]]; then
    echo "WARNING: using /redirect/latest/ instead of the pin — this build is not reproducible." >&2
    ff_url="https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch}/release/ffmpeg.zip"
    fp_url="https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch}/release/ffprobe.zip"
    ff_sha=""; fp_sha=""
  fi
  # An explicit URL override is a dev knob and carries no pin, so it carries no hash.
  if [[ -n "${FFMPEG_URL:-}" ]]; then ff_url="${FFMPEG_URL}"; ff_sha=""; fi
  if [[ -n "${FFPROBE_URL:-}" ]]; then fp_url="${FFPROBE_URL}"; fp_sha=""; fi
  echo "==> Downloading static ffmpeg:  ${ff_url}"
  curl -fsSL "${ff_url}" -o "${WORK}/ffmpeg.zip"
  verify_sha256 "${WORK}/ffmpeg.zip" "${ff_sha}" "macOS ffmpeg.zip"
  echo "==> Downloading static ffprobe: ${fp_url}"
  curl -fsSL "${fp_url}" -o "${WORK}/ffprobe.zip"
  verify_sha256 "${WORK}/ffprobe.zip" "${fp_sha}" "macOS ffprobe.zip"
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
  local url sha
  url="$(pin ffmpeg "${TRIPLE}" archive url)"
  sha="$(pin ffmpeg "${TRIPLE}" archive sha256)"
  if [[ "${FFMPEG_PINS:-1}" != "1" || -z "${url}" ]]; then
    echo "WARNING: re-resolving the newest BtbN autobuild instead of the pin — not reproducible, not verified." >&2
    url="$(resolve_btbn_asset linux64-gpl.tar.xz)"; sha=""
  fi
  if [[ -n "${FFMPEG_URL:-}" ]]; then url="${FFMPEG_URL}"; sha=""; fi
  if [ -z "${url}" ]; then echo "ERROR: no pinned BtbN linux64-gpl asset and none resolvable from the GitHub API." >&2; exit 1; fi
  echo "==> Downloading ${url}"
  curl -fsSL --retry 3 --retry-delay 5 "${url}" -o "${WORK}/ffmpeg.tar.xz"
  verify_sha256 "${WORK}/ffmpeg.tar.xz" "${sha}" "BtbN linux64-gpl"
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
  local url sha
  url="$(pin ffmpeg "${TRIPLE}" archive url)"
  sha="$(pin ffmpeg "${TRIPLE}" archive sha256)"
  if [[ "${FFMPEG_PINS:-1}" != "1" || -z "${url}" ]]; then
    echo "WARNING: re-resolving the newest BtbN autobuild instead of the pin — not reproducible, not verified." >&2
    url="$(resolve_btbn_asset win64-gpl.zip)"; sha=""
  fi
  if [[ -n "${FFMPEG_URL:-}" ]]; then url="${FFMPEG_URL}"; sha=""; fi
  if [ -z "${url}" ]; then echo "ERROR: no pinned BtbN win64-gpl asset and none resolvable from the GitHub API." >&2; exit 1; fi
  echo "==> Downloading ${url}"
  curl -fsSL --retry 3 --retry-delay 5 "${url}" -o "${WORK}/ffmpeg.zip"
  verify_sha256 "${WORK}/ffmpeg.zip" "${sha}" "BtbN win64-gpl"
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
# Local-copy mode is opt-in via FFMPEG_BIN/FFPROBE_BIN ONLY.
#
# It used to also accept FFMPEG_PATH/FFPROBE_PATH — but those are the
# ORCHESTRATOR'S RUNTIME vars (node-orchestrator/src/config.ts), and this script
# sources `.env` (above), where a developer naturally sets them so dev runs find
# ffmpeg. The result: a release build silently staged the build machine's
# Homebrew binaries. That is exactly how v0.3.0 shipped a macOS bundle linked to
# /opt/homebrew/Cellar/ffmpeg-full — unrunnable on any other Mac. A runtime
# setting must never steer a build, so the two namespaces are now separate
# (assert_portable() is the backstop, not the only defense).
LOCAL_FFMPEG="${FFMPEG_BIN:-}"
LOCAL_FFPROBE="${FFPROBE_BIN:-}"
if [[ -n "${LOCAL_FFMPEG}" && -n "${LOCAL_FFPROBE}" ]]; then
  echo "==> Staging ffmpeg/ffprobe from local paths (must be a STATIC build)."
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
