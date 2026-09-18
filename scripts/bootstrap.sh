#!/usr/bin/env bash
#
# scripts/bootstrap.sh — Take a freshly cloned VideoDubber repo on a machine that
# may have nothing installed, and leave it in a state where `pnpm dev` works.
#
# Usage:
#   pnpm bootstrap                       # everything
#   pnpm bootstrap --skip-python         # no venvs, no model downloads
#   pnpm bootstrap --skip-models         # venvs yes, ~700 MB of models no
#   pnpm bootstrap --help
#
# This is the POSIX half of a TWIN PAIR. scripts/bootstrap.ps1 is the Windows
# half, and `node scripts/run.mjs bootstrap` picks the right one. The two must
# agree on phase order, phase names, flag names, env-var names, exit codes and
# the shape of the final summary — a reviewer diffs them for drift, so if you
# change one, change the other.
#
# WHY THIS EXISTS
# ---------------
# Until now the repo had a script for every step EXCEPT the first one. A new
# contributor was told to "install the prerequisites" by prose in
# docs/LOCAL_SETUP.md and then left to discover, one failure at a time, that:
#   * `pnpm dev` dies at "Could not resolve @videodubber/shared" if `pnpm build`
#     has not run — the Angular app and the orchestrator consume those packages
#     through their "exports", which point at dist/, not src/;
#   * setup-local-models.sh builds its venvs from whatever `python3` happens to
#     be. On this maintainer's Mac that is 3.14; the repo's bundled runtime is
#     CPython 3.12.13. A 3.13 venv is exactly what shipped v0.8.1's macOS
#     workers with `minos 26.0` extension modules that no older Mac could load
#     (see scripts/package/build-workers.sh for the full autopsy). So this
#     script resolves a REAL 3.12 and hands it over as PYTHON_PATH rather than
#     letting the ambient interpreter decide.
#   * nothing anywhere checked a version floor, so "it doesn't work" arrived as
#     a stack trace instead of a sentence.
#
# WHAT IT WILL NOT DO
# -------------------
# It never installs a system package, never runs sudo, never edits your PATH or
# your shell profile. An onboarding script that installs Homebrew behind your
# back is a worse first impression than one that says "run this command". Every
# missing prerequisite is reported with the exact command for THIS OS, and then
# we stop.
#
# Idempotent: re-running it is a no-op plus a fresh prerequisite table.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
cd "${ROOT_DIR}"

# --- Pretty logging (same register as dev.sh / stop.sh) ----------------------
c_reset="\033[0m"; c_red="\033[31m"; c_grn="\033[32m"; c_yel="\033[33m"
c_blu="\033[34m"; c_bold="\033[1m"; c_dim="\033[2m"
info() { printf "${c_blu}[bootstrap]${c_reset} %s\n" "$*"; }
ok()   { printf "${c_grn}[bootstrap]${c_reset} %s\n" "$*"; }
warn() { printf "${c_yel}[bootstrap][warn]${c_reset} %s\n" "$*" >&2; }
err()  { printf "${c_red}[bootstrap][error]${c_reset} %s\n" "$*" >&2; }

# Numbered phase banner. Both twins print this exact shape.
banner() {
  printf "\n${c_bold}=== Phase %s/5: %s ===${c_reset}\n\n" "$1" "$2"
}

# ---------------------------------------------------------------------------
# Flags. Each is ALSO an env var so CI (and the PowerShell twin, whose switches
# are not environment variables) can drive the same behaviour.
# ---------------------------------------------------------------------------
SKIP_DEPS="${SKIP_DEPS:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_PYTHON="${SKIP_PYTHON:-0}"
SKIP_MODELS="${SKIP_MODELS:-0}"
STRICT="${STRICT:-0}"

usage() {
  cat <<'__HELP__'
scripts/bootstrap.sh — set up a fresh clone so that `pnpm dev` works.

USAGE
  pnpm bootstrap [flags]
  bash scripts/bootstrap.sh [flags]

FLAGS                     ENV EQUIVALENT
  --skip-deps             SKIP_DEPS=1      don't run `pnpm install`
  --skip-build            SKIP_BUILD=1     don't run `pnpm build`
  --skip-python           SKIP_PYTHON=1    don't create venvs or fetch models
  --skip-models           SKIP_MODELS=1    create venvs, but download no models
  --strict                STRICT=1         treat OPTIONAL prerequisites as errors
  -h, --help                               this text

PHASES
  1. PREREQUISITES                  check only — never installs anything
  2. WORKSPACE DEPENDENCIES         corepack enable + pnpm install
  3. BUILD THE WORKSPACE LIBRARIES  pnpm build (dist/ is what the app imports)
  4. PYTHON WORKERS + MODELS        delegates to scripts/setup-local-models.sh
  5. VERIFY                         runs the doctor, scripts/verify-environment.ts

PASSED THROUGH TO setup-local-models.sh, IF YOU SET THEM
  PYTHON_PATH  FASTER_WHISPER_MODEL  ARGOS_FROM  ARGOS_TO  PIPER_VOICE
  VIDEODUBBER_DEV_HOME

EXIT CODES
  0  success (warnings are allowed)
  1  a REQUIRED prerequisite is missing
  2  a phase command failed, or the arguments were wrong
__HELP__
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-deps)   SKIP_DEPS=1 ;;
    --skip-build)  SKIP_BUILD=1 ;;
    --skip-python) SKIP_PYTHON=1 ;;
    --skip-models) SKIP_MODELS=1 ;;
    --strict)      STRICT=1 ;;
    -h|--help)     usage; exit 0 ;;
    *)
      err "Unknown option: $1"
      echo
      usage >&2
      exit 2
      ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Platform facts. Homebrew's prefix differs by architecture, and printing the
# wrong one in a fix hint ("brew install ffmpeg-full" then FFMPEG_PATH=/usr/local
# on an M-series Mac) is worse than printing none.
# ---------------------------------------------------------------------------
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
UNAME_M="$(uname -m 2>/dev/null || echo unknown)"
case "${UNAME_S}" in
  Darwin) OS_KIND="macos" ;;
  Linux)  OS_KIND="linux" ;;
  *)      OS_KIND="other" ;;
esac
if [ "${UNAME_M}" = "arm64" ] || [ "${UNAME_M}" = "aarch64" ]; then
  BREW_PREFIX="/opt/homebrew"   # Apple Silicon
  MAC_ARCH_LABEL="Apple Silicon"
else
  BREW_PREFIX="/usr/local"      # Intel
  MAC_ARCH_LABEL="Intel"
fi

# ---------------------------------------------------------------------------
# version_ge <have> <want> — true when <have> >= <want>, numerically.
#
# Written out longhand because every shortcut here is wrong: `sort -V` is not on
# macOS's BSD sort in every release, and a plain string compare says
# "22.9.0" > "22.12.0" because it compares '9' against '1'. That exact bug is
# why the floors below are tested, not assumed.
#
# bash 3.2 safe: no arrays, no mapfile, no ${var^^}.
# ---------------------------------------------------------------------------
_vpart() {
  # <version> <1|2|3> -> that dotted component as a bare integer ("" -> 0),
  # tolerating suffixes like "1.96.0-nightly" or "8.1.2-tessus".
  #
  # The trailing '.' in the printf is load-bearing. `cut -d. -f2` echoes the
  # WHOLE line when the delimiter does not occur in it, so without it a floor
  # of "22" parsed to 22.22.22 and version_ge said 22 >= 22.12.0 was true.
  # Appending the separator makes a missing component genuinely empty, which
  # the caller then reads as 0.
  printf '%s.' "$1" | cut -d. -f"$2" | sed 's/[^0-9].*$//'
}

version_ge() {
  local have want i hv wv
  have="${1#v}"
  want="${2#v}"
  i=1
  while [ "${i}" -le 3 ]; do
    hv="$(_vpart "${have}" "${i}")"
    wv="$(_vpart "${want}" "${i}")"
    if [ -z "${hv}" ]; then hv=0; fi
    if [ -z "${wv}" ]; then wv=0; fi
    if [ "${hv}" -gt "${wv}" ]; then return 0; fi
    if [ "${hv}" -lt "${wv}" ]; then return 1; fi
    i=$((i + 1))
  done
  return 0
}

# First line of `<cmd> <args>`, or "" if it cannot be run at all.
probe() {
  local out
  out="$("$@" 2>&1 | head -n 1)" || out=""
  printf '%s' "${out}"
}

# ---------------------------------------------------------------------------
# PHASE 1 — PREREQUISITES (check only)
# ---------------------------------------------------------------------------
banner 1 "PREREQUISITES"

# Read the REAL floors out of package.json rather than keeping a second copy
# here that drifts. Parsed with sed, not node: node is one of the things we are
# checking for, so it may not exist yet.
NODE_FLOOR="$(sed -n 's/.*"node"[[:space:]]*:[[:space:]]*">=[[:space:]]*\([0-9][0-9.]*\)".*/\1/p' "${ROOT_DIR}/package.json" | head -n 1)"
if [ -z "${NODE_FLOOR}" ]; then
  NODE_FLOOR="22.12.0"
  warn "Could not read engines.node from package.json; assuming >=${NODE_FLOOR}."
fi
# [^"+]* not [^"]*: corepack likes to rewrite packageManager as
# "pnpm@11.9.0+sha512.<integrity>", and keeping that suffix would make the
# equality test below never match — every contributor would see a permanent
# "pnpm 11.9.0, repo pins 11.9.0+sha512…" warning. The .ps1 twin strips it with
# '^pnpm@([^+]+)'; this is the same rule.
PNPM_PIN="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([^"+]*\).*/\1/p' "${ROOT_DIR}/package.json" | head -n 1)"
if [ -z "${PNPM_PIN}" ]; then
  PNPM_PIN="11.9.0"
  warn "Could not read packageManager from package.json; assuming pnpm@${PNPM_PIN}."
fi

REQUIRED_MISSING=0
OPTIONAL_MISSING=0
MISSING_NAMES=""  # one-line roll-up for the consolidated failure

# Remediation blocks, printed at the end of phase 1. They are kept in TWO lists
# on purpose: a first-time contributor reading one undifferentiated wall of
# "how to fix" cannot tell which command unblocks them and which is a nice to
# have, so "install Rust" ends up looking as urgent as "install Node".
FIXES_REQUIRED=""
FIXES_OPTIONAL=""

# add_fix / add_opt_fix <multi-line text> — queue a remediation block.
add_fix()     { FIXES_REQUIRED="${FIXES_REQUIRED}$1
"; }
add_opt_fix() { FIXES_OPTIONAL="${FIXES_OPTIONAL}$1
"; }

# A table row: name, status word, detail.
row() {
  local color
  case "$2" in
    OK)      color="${c_grn}" ;;
    WARN)    color="${c_yel}" ;;
    MISSING) color="${c_red}" ;;
    *)       color="${c_reset}" ;;
  esac
  printf "  %-14s ${color}%-8s${c_reset} %s\n" "$1" "$2" "$3"
}

printf "  ${c_bold}%-14s %-8s %s${c_reset}\n" "TOOL" "STATUS" "FOUND"
printf "  ${c_dim}-------------- -------- ---------------------------------------${c_reset}\n"

# --- Node --------------------------------------------------------------------
NODE_VERSION=""
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(probe node --version)"
  NODE_VERSION="${NODE_VERSION#v}"
fi
if [ -z "${NODE_VERSION}" ]; then
  row "Node.js" "MISSING" "not on PATH (need >= ${NODE_FLOOR})"
  REQUIRED_MISSING=$((REQUIRED_MISSING + 1))
  MISSING_NAMES="${MISSING_NAMES} Node.js"
  case "${OS_KIND}" in
    macos) add_fix "  * Node.js >= ${NODE_FLOOR} is not installed.
      brew install node@24
      brew link --overwrite --force node@24
    Node 24 LTS is what releases are built with." ;;
    linux) add_fix "  * Node.js >= ${NODE_FLOOR} is not installed.
    Distro package names differ, so use the distro-agnostic route:
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
      nvm install 24 && nvm use 24
    See docs/LOCAL_SETUP.md." ;;
    *)     add_fix "  * Node.js >= ${NODE_FLOOR} is not installed. See docs/LOCAL_SETUP.md." ;;
  esac
elif version_ge "${NODE_VERSION}" "${NODE_FLOOR}"; then
  row "Node.js" "OK" "v${NODE_VERSION}  (need >= ${NODE_FLOOR})"
else
  row "Node.js" "MISSING" "v${NODE_VERSION} is too old (need >= ${NODE_FLOOR})"
  REQUIRED_MISSING=$((REQUIRED_MISSING + 1))
  MISSING_NAMES="${MISSING_NAMES} Node.js"
  case "${OS_KIND}" in
    macos) add_fix "  * Node.js v${NODE_VERSION} is older than the ${NODE_FLOOR} floor in package.json.
      brew install node@24
      brew link --overwrite --force node@24" ;;
    linux) add_fix "  * Node.js v${NODE_VERSION} is older than the ${NODE_FLOOR} floor in package.json.
      nvm install 24 && nvm use 24        # https://github.com/nvm-sh/nvm
    See docs/LOCAL_SETUP.md for distro packages." ;;
    *)     add_fix "  * Node.js v${NODE_VERSION} is older than ${NODE_FLOOR}. See docs/LOCAL_SETUP.md." ;;
  esac
fi

# --- pnpm --------------------------------------------------------------------
# Missing entirely is fatal. A DIFFERENT version is only a warning: corepack
# reads packageManager from package.json and switches on demand, so a contributor
# with pnpm 10 on PATH still ends up running 11.9.0 inside this repo.
PNPM_VERSION=""
if command -v pnpm >/dev/null 2>&1; then
  PNPM_VERSION="$(probe pnpm --version)"
fi
PNPM_FIX="      corepack enable
      corepack prepare pnpm@${PNPM_PIN} --activate"
if [ -z "${PNPM_VERSION}" ]; then
  row "pnpm" "MISSING" "not on PATH (repo pins ${PNPM_PIN})"
  REQUIRED_MISSING=$((REQUIRED_MISSING + 1))
  MISSING_NAMES="${MISSING_NAMES} pnpm"
  add_fix "  * pnpm ${PNPM_PIN} is not installed. It ships with Node itself, via corepack:
${PNPM_FIX}"
elif [ "${PNPM_VERSION}" = "${PNPM_PIN}" ]; then
  row "pnpm" "OK" "${PNPM_VERSION}  (pinned by packageManager)"
else
  row "pnpm" "WARN" "${PNPM_VERSION}, repo pins ${PNPM_PIN}"
  OPTIONAL_MISSING=$((OPTIONAL_MISSING + 1))
  add_opt_fix "  * pnpm ${PNPM_VERSION} is on PATH but package.json pins ${PNPM_PIN}.
    corepack normally switches automatically inside this repo; to pin it yourself:
${PNPM_FIX}"
fi

# --- Python 3.12 -------------------------------------------------------------
# 3.12 SPECIFICALLY, not ">= 3.12". The repo bundles CPython 3.12.13
# (apps/desktop/src-tauri/resources/python/) and the engine-pack venvs are built
# against it; a venv from a newer interpreter is how v0.8.1 shipped macOS workers
# that only ran on macOS 26. So we look for a real 3.12 and, further down, hand
# it to setup-local-models.sh explicitly instead of letting `python3` decide.
PYTHON_RESOLVED=""
PYTHON_VERSION=""
PYTHON_FALLBACK_NOTE=""
# Set when the CALLER's PYTHON_PATH is present but is not a usable 3.12. The
# caller still wins in phase 4 (an explicit env var is a decision, and silently
# overriding it is its own kind of betrayal) — but it must not be able to do so
# invisibly. Before this, `PYTHON_PATH=/opt/homebrew/bin/python3 pnpm bootstrap`
# printed "Python 3.12  OK  3.12.13" because the loop fell through to
# python3.12 for the TABLE, while phase 4 handed 3.14 to setup-local-models.sh.
# That is precisely the v0.8.1 wrong-interpreter incident with a green tick on top.
PYTHON_PATH_MISMATCH=""
# What honouring that pin will actually DO, so the table can say so instead of
# promising that phase 4 "will still use" an interpreter that cannot even run.
PYTHON_PATH_CONSEQUENCE=""
for _cand in "${PYTHON_PATH:-}" python3.12 python3 python; do
  [ -n "${_cand}" ] || continue
  if ! command -v "${_cand}" >/dev/null 2>&1; then
    if [ -n "${PYTHON_PATH:-}" ] && [ "${_cand}" = "${PYTHON_PATH}" ]; then
      PYTHON_PATH_MISMATCH="cannot be run at all"
      PYTHON_PATH_CONSEQUENCE="phase 4 will fail on it"
    fi
    continue
  fi
  _ver="$(probe "${_cand}" --version)"
  _ver="${_ver#Python }"
  if [ -n "${PYTHON_PATH:-}" ] && [ "${_cand}" = "${PYTHON_PATH}" ]; then
    case "${_ver}" in
      3.12.*|3.12) : ;;
      "")          PYTHON_PATH_MISMATCH="reports no version"
                   PYTHON_PATH_CONSEQUENCE="phase 4 will fail on it" ;;
      *)           PYTHON_PATH_MISMATCH="is Python ${_ver}"
                   PYTHON_PATH_CONSEQUENCE="phase 4 will still use it" ;;
    esac
  fi
  case "${_ver}" in
    3.12.*|3.12)
      PYTHON_RESOLVED="$(command -v "${_cand}")"
      PYTHON_VERSION="${_ver}"
      break
      ;;
    *)
      # Remember the first non-3.12 interpreter so the error can say what IS here.
      if [ -z "${PYTHON_FALLBACK_NOTE}" ] && [ -n "${_ver}" ]; then
        PYTHON_FALLBACK_NOTE="${_cand} is Python ${_ver}"
      fi
      ;;
  esac
done
unset _cand _ver

if [ -n "${PYTHON_PATH_MISMATCH}" ] && [ -n "${PYTHON_RESOLVED}" ]; then
  # The caller pinned an interpreter that is not 3.12, but a real 3.12 IS on
  # this machine. Phase 4 honours the caller — so say, in the table, what will
  # actually build the venvs. (When there is no 3.12 at all we fall through to
  # the MISSING branch below and fail properly, as before.)
  row "Python 3.12" "WARN" "PYTHON_PATH ${PYTHON_PATH_MISMATCH} — ${PYTHON_PATH_CONSEQUENCE}"
  OPTIONAL_MISSING=$((OPTIONAL_MISSING + 1))
  add_opt_fix "  * PYTHON_PATH is set to ${PYTHON_PATH} — which ${PYTHON_PATH_MISMATCH}.
    An explicit PYTHON_PATH wins, so the worker venvs WILL be built from it. The
    repo bundles CPython 3.12.13 and the engine packs are built against 3.12; a
    venv from anything else is what shipped v0.8.1's unloadable macOS workers.
    A usable 3.12 is already on this machine: ${PYTHON_RESOLVED}
    To use it instead:
      unset PYTHON_PATH; pnpm bootstrap"
elif [ -n "${PYTHON_RESOLVED}" ]; then
  row "Python 3.12" "OK" "${PYTHON_VERSION}  (${PYTHON_RESOLVED})"
else
  if [ -n "${PYTHON_PATH_MISMATCH}" ]; then
    # Name the pin explicitly: "no python interpreter on PATH" is baffling when
    # you just told the script exactly which interpreter to use.
    row "Python 3.12" "MISSING" "PYTHON_PATH ${PYTHON_PATH_MISMATCH}, and no other 3.12 found"
  elif [ -n "${PYTHON_FALLBACK_NOTE}" ]; then
    row "Python 3.12" "MISSING" "no 3.12 found — ${PYTHON_FALLBACK_NOTE}"
  else
    row "Python 3.12" "MISSING" "no python interpreter on PATH"
  fi
  REQUIRED_MISSING=$((REQUIRED_MISSING + 1))
  MISSING_NAMES="${MISSING_NAMES} Python-3.12"
  case "${OS_KIND}" in
    macos) add_fix "  * Python 3.12.x is required — the app bundles CPython 3.12.13 and the
    worker venvs must match it. A 3.13+ venv produced macOS workers that only
    ran on macOS 26 (see scripts/package/build-workers.sh).
      brew install python@3.12
    Then re-run, or point this at it directly:
      PYTHON_PATH=${BREW_PREFIX}/opt/python@3.12/bin/python3.12 pnpm bootstrap" ;;
    linux) add_fix "  * Python 3.12.x is required — the app bundles CPython 3.12.13 and the
    worker venvs must match it.
    Distro package names differ; the distro-agnostic route is pyenv:
      pyenv install 3.12.13
    See docs/LOCAL_SETUP.md. Then:
      PYTHON_PATH=\$(pyenv prefix 3.12.13)/bin/python3.12 pnpm bootstrap" ;;
    *)     add_fix "  * Python 3.12.x is required. See docs/LOCAL_SETUP.md, then re-run with
      PYTHON_PATH=/path/to/python3.12 pnpm bootstrap" ;;
  esac
fi

# --- Rust / cargo (OPTIONAL: only `pnpm app` needs it) -----------------------
CARGO_VERSION=""
if command -v cargo >/dev/null 2>&1; then
  CARGO_VERSION="$(probe cargo --version)"
  CARGO_VERSION="$(printf '%s' "${CARGO_VERSION}" | cut -d' ' -f2)"
fi
if [ -n "${CARGO_VERSION}" ]; then
  row "Rust (cargo)" "OK" "${CARGO_VERSION}"
else
  row "Rust (cargo)" "WARN" "not on PATH — only needed for \`pnpm app\`"
  OPTIONAL_MISSING=$((OPTIONAL_MISSING + 1))
  case "${OS_KIND}" in
    macos|linux) add_opt_fix "  * Rust is not installed. It is OPTIONAL: \`pnpm dev\` (browser dev mode)
    works without it; only the native Tauri window (\`pnpm app\`) needs it.
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" ;;
    *)           add_opt_fix "  * Rust is not installed (optional; only \`pnpm app\` needs it).
    See https://rustup.rs" ;;
  esac
fi

# --- ffmpeg / ffprobe (OPTIONAL: the packaged app bundles its own) -----------
check_ff() {
  local bin="$1" envvar="$2" label="$3"
  local from_env="" ver=""
  eval "from_env=\${${envvar}:-}"
  if [ -n "${from_env}" ] && [ -x "${from_env}" ]; then
    ver="$(probe "${from_env}" -version)"
    row "${label}" "OK" "$(printf '%s' "${ver}" | cut -d' ' -f3)  (\$${envvar})"
    return 0
  fi
  if command -v "${bin}" >/dev/null 2>&1; then
    ver="$(probe "${bin}" -version)"
    row "${label}" "OK" "$(printf '%s' "${ver}" | cut -d' ' -f3)  ($(command -v "${bin}"))"
    return 0
  fi
  row "${label}" "WARN" "not on PATH (set ${envvar} or install ffmpeg)"
  return 1
}
FF_MISSING=0
if ! check_ff ffmpeg  FFMPEG_PATH  "ffmpeg"; then FF_MISSING=1; fi
if ! check_ff ffprobe FFPROBE_PATH "ffprobe"; then FF_MISSING=1; fi
if [ "${FF_MISSING}" -eq 1 ]; then
  OPTIONAL_MISSING=$((OPTIONAL_MISSING + 1))
  case "${OS_KIND}" in
    macos) add_opt_fix "  * ffmpeg/ffprobe are missing. OPTIONAL: the packaged app bundles its own,
    but the dev stack shells out to whatever is on PATH.
      brew install ffmpeg-full
    On this ${MAC_ARCH_LABEL} Mac, Homebrew puts them here — add to .env if they
    are not picked up from PATH:
      FFMPEG_PATH=${BREW_PREFIX}/bin/ffmpeg
      FFPROBE_PATH=${BREW_PREFIX}/bin/ffprobe" ;;
    linux) add_opt_fix "  * ffmpeg/ffprobe are missing. OPTIONAL: the packaged app bundles its own.
    Distro package names differ — see docs/LOCAL_SETUP.md. A distro-agnostic
    option is a static build from https://johnvansickle.com/ffmpeg/, then:
      FFMPEG_PATH=/path/to/ffmpeg
      FFPROBE_PATH=/path/to/ffprobe    # in .env" ;;
    *)     add_opt_fix "  * ffmpeg/ffprobe are missing (optional). See docs/LOCAL_SETUP.md." ;;
  esac
fi

# NOTE: the spec's fifth probe, "pwsh 7", is deliberately absent from this table.
# It is a WINDOWS requirement, and on Windows bootstrap.ps1 is already running
# inside it. Listing a permanently-inapplicable row here would only train people
# to ignore the table.

echo
if [ -n "${FIXES_REQUIRED}" ]; then
  printf "${c_bold}${c_red}  MUST FIX — nothing will run until these are installed:${c_reset}\n\n"
  printf '%s\n' "${FIXES_REQUIRED}"
fi
if [ -n "${FIXES_OPTIONAL}" ]; then
  printf "${c_bold}${c_yel}  Optional — bootstrap continues without these:${c_reset}\n\n"
  printf '%s\n' "${FIXES_OPTIONAL}"
fi

if [ "${REQUIRED_MISSING}" -gt 0 ]; then
  err "${REQUIRED_MISSING} required prerequisite(s) missing:${MISSING_NAMES}"
  err "Install them with the commands above, then re-run: pnpm bootstrap"
  exit 1
fi
if [ "${STRICT}" != "0" ] && [ "${OPTIONAL_MISSING}" -gt 0 ]; then
  err "--strict: ${OPTIONAL_MISSING} optional prerequisite(s) missing (see above)."
  exit 1
fi
ok "All required prerequisites are present."

# ---------------------------------------------------------------------------
# Phase bookkeeping for the final summary.
# ---------------------------------------------------------------------------
RAN=""
SKIPPED=""
WARNED=""
did()     { RAN="${RAN}  - $1
"; }
skipped() { SKIPPED="${SKIPPED}  - $1
"; }
warned()  { WARNED="${WARNED}  - $1
"; }

if [ "${OPTIONAL_MISSING}" -gt 0 ]; then
  warned "${OPTIONAL_MISSING} optional prerequisite(s) missing — see the table above"
fi

# ---------------------------------------------------------------------------
# PHASE 2 — WORKSPACE DEPENDENCIES
# ---------------------------------------------------------------------------
banner 2 "WORKSPACE DEPENDENCIES"

if [ "${SKIP_DEPS}" != "0" ]; then
  warn "--skip-deps — not running pnpm install."
  skipped "workspace dependencies (--skip-deps)"
else
  # Best effort: corepack is bundled with Node but a distro may have split it
  # out, and some setups make `corepack enable` a privileged write. A failure
  # here is not fatal — pnpm is already on PATH, we checked in phase 1.
  if command -v corepack >/dev/null 2>&1; then
    info "corepack enable (activates the pinned pnpm@${PNPM_PIN})"
    if ! corepack enable >/dev/null 2>&1; then
      warn "corepack enable failed (no write access to the Node bin dir?). Continuing"
      warn "with the pnpm already on PATH. To pin it yourself:"
      warn "    corepack prepare pnpm@${PNPM_PIN} --activate"
      warned "corepack enable failed; using the ambient pnpm"
    fi
  else
    warn "corepack is not on PATH; skipping the pnpm pin. Continuing."
    warned "corepack unavailable; using the ambient pnpm"
  fi

  # CI must install exactly what the lockfile says; a developer must be able to
  # bootstrap a branch that legitimately changed package.json.
  if [ -n "${CI:-}" ] && [ "${CI}" != "0" ] && [ "${CI}" != "false" ]; then
    info "CI is set — pnpm install --frozen-lockfile"
    if ! pnpm install --frozen-lockfile; then
      err "pnpm install --frozen-lockfile failed."
      err "In CI this usually means pnpm-lock.yaml is out of date with package.json."
      exit 2
    fi
  else
    info "pnpm install"
    if ! pnpm install; then
      err "pnpm install failed. Re-run with more detail:  pnpm install --reporter=default"
      exit 2
    fi
  fi
  ok "Workspace dependencies installed."
  did "pnpm install"
fi

# ---------------------------------------------------------------------------
# PHASE 3 — WORKSPACE LIBRARIES
# ---------------------------------------------------------------------------
banner 3 "BUILD THE WORKSPACE LIBRARIES"

if [ "${SKIP_BUILD}" != "0" ]; then
  warn "--skip-build — not running pnpm build."
  warn "Remember: @videodubber/shared and @videodubber/media-worker are imported"
  warn "from dist/, so \`pnpm dev\` will fail to resolve them until you build."
  skipped "workspace library build (--skip-build)"
else
  # This MUST happen before anything tries to run the app. The packages' exports
  # point at dist/, not src/, so on a fresh clone the dev server dies with
  # "Could not resolve @videodubber/shared" — which reads like a broken import,
  # not a missing build step.
  info "pnpm build  (packages/* and workers/media-worker -> dist/)"
  if ! pnpm build; then
    err "pnpm build failed. The dev server cannot resolve @videodubber/shared"
    err "until this succeeds. Try:  pnpm -r --filter \"./packages/**\" build"
    exit 2
  fi
  ok "Workspace libraries built."
  did "pnpm build"
fi

# ---------------------------------------------------------------------------
# PHASE 4 — PYTHON WORKERS + MODELS
# ---------------------------------------------------------------------------
banner 4 "PYTHON WORKERS + MODELS"

SETUP_SCRIPT="${SCRIPT_DIR}/setup-local-models.sh"
if [ "${SKIP_PYTHON}" != "0" ]; then
  warn "--skip-python — no venvs, no model downloads."
  warn "The UI and orchestrator will start; transcription/translation/TTS will not."
  skipped "Python venvs + models (--skip-python)"
elif [ ! -f "${SETUP_SCRIPT}" ]; then
  err "Missing ${SETUP_SCRIPT} — cannot set up the Python workers."
  exit 2
else
  # Everything in this phase is delegated. setup-local-models.sh owns venv
  # creation, pip, the whisper pre-cache, the Argos pair and the Piper voice; it
  # is skip-flag-aware and never fails hard when offline. Reimplementing any of
  # it here would give us two versions of the model-cache directory layout to
  # keep in sync, and that mismatch has already cost a release once.
  info "Delegating to scripts/setup-local-models.sh"

  # Hand over the 3.12 we resolved in phase 1 unless the caller pinned one.
  # Without this the child picks whatever `python3` is — on this maintainer's
  # Mac, 3.14 — and builds venvs against the wrong runtime.
  if [ -z "${PYTHON_PATH:-}" ] && [ -n "${PYTHON_RESOLVED}" ]; then
    export PYTHON_PATH="${PYTHON_RESOLVED}"
    info "PYTHON_PATH=${PYTHON_PATH}  (resolved in phase 1; overrides ambient python3)"
  fi

  # Pass-throughs. These are already exported if the caller set them, but naming
  # them explicitly documents the contract and keeps the PowerShell twin — whose
  # shell variables are NOT environment variables — honest.
  for _v in PYTHON_PATH FASTER_WHISPER_MODEL ARGOS_FROM ARGOS_TO PIPER_VOICE VIDEODUBBER_DEV_HOME; do
    eval "_val=\${${_v}:-}"
    if [ -n "${_val}" ]; then
      export "${_v}"
      info "  passing through ${_v}=${_val}"
    fi
  done
  unset _v _val

  if [ "${SKIP_MODELS}" != "0" ]; then
    export SKIP_MODELS=1
    warn "--skip-models — creating venvs, but downloading no models."
    warn "The first dub will then download the whisper model on demand."
  else
    info "This is the slow phase. Expect roughly:"
    info "    ~1.2 GB of Python wheels (three venvs under workers/*/.venv)"
    info "    ~0.7 GB of models (faster-whisper 'small', an Argos pair, a Piper voice)"
    info "  On a slow link this can take 15-30 minutes. Re-running is cheap:"
    info "  existing venvs are reused and downloaded files are not re-fetched."
  fi

  # setup-local-models.sh exits 1 only when python is entirely absent, which
  # phase 1 already ruled out; every other failure is a warning inside it. Treat
  # a non-zero exit as a real phase failure anyway rather than quietly going on.
  if ! bash "${SETUP_SCRIPT}"; then
    err "scripts/setup-local-models.sh failed."
    err "Re-run just that step once the problem is fixed:"
    err "    bash scripts/setup-local-models.sh"
    exit 2
  fi
  ok "Python workers set up."
  if [ "${SKIP_MODELS}" != "0" ]; then
    did "Python venvs (models skipped)"
    skipped "model downloads (--skip-models)"
  else
    did "Python venvs + models"
  fi
fi

# ---------------------------------------------------------------------------
# PHASE 5 — VERIFY
# ---------------------------------------------------------------------------
banner 5 "VERIFY"

# The doctor already exists and is cross-platform (scripts/verify-environment.ts).
# It is deliberately NOT re-implemented in shell: it probes running services over
# HTTP, reads the Argos language list out of the translation worker, and knows
# which checks are core vs optional.
#
# Its non-zero exit is a WARNING here, never a bootstrap failure: it also reports
# things a contributor may have skipped on purpose (--skip-python), and it flags
# the dev servers as down — which they are, because nothing has started them yet.
if [ ! -d "${ROOT_DIR}/node_modules" ]; then
  warn "node_modules/ is absent (--skip-deps), so the doctor cannot run — it needs tsx."
  warn "Run it later with:  pnpm doctor"
  warned "verification skipped (no node_modules)"
else
  info "pnpm verify  (scripts/verify-environment.ts)"
  echo
  if ! pnpm verify; then
    echo
    warn "The doctor reported problems (see its table above)."
    warn "That is not fatal: it also checks optional engines and the dev servers,"
    warn "which are not running yet. Re-check any time with:  pnpm doctor"
    warned "the doctor reported problems — see its table above"
  else
    echo
    ok "Environment verified."
  fi
  did "pnpm verify"
fi

# ---------------------------------------------------------------------------
# SUMMARY
# ---------------------------------------------------------------------------
printf "\n${c_bold}=== Bootstrap complete ===${c_reset}\n\n"

if [ -n "${RAN}" ]; then
  printf "${c_grn}${c_bold}Ran:${c_reset}\n%s" "${RAN}"
fi
if [ -n "${SKIPPED}" ]; then
  printf "${c_dim}${c_bold}Skipped:${c_reset}\n%s" "${SKIPPED}"
fi
if [ -n "${WARNED}" ]; then
  printf "${c_yel}${c_bold}Still missing / needs attention:${c_reset}\n%s" "${WARNED}"
else
  printf "${c_grn}${c_bold}Nothing outstanding.${c_reset}\n"
fi

cat <<'NEXT'

Next steps:
  pnpm dev     -> browser dev mode at http://localhost:1420 (no Rust needed)
  pnpm app     -> native desktop window (needs Rust)
  pnpm doctor  -> re-check the environment

  docs/LOCAL_SETUP.md and CONTRIBUTING.md for detail.
NEXT

exit 0
