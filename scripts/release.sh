#!/usr/bin/env bash
#
# scripts/release.sh — the macOS front door to cutting a release.
#
# WHY THIS EXISTS: the machinery to release has been complete for a long time
# (scripts/package/release-macos.sh does build -> deep-sign -> notarize -> staple
# -> regenerate the updater archive -> upload -> merge latest.json), but nothing
# pointed AT it. docs/RELEASING.md spells the incantation out across six sections,
# and the maintainer re-derived it from the doc every time — including which env
# vars must be exported before the first line runs. Two of those (the notary
# credentials and the updater key) are only discovered to be missing AFTER a
# ~20-minute build, because that is where release-macos.sh checks them.
#
# So this wrapper adds exactly two things and reimplements NOTHING:
#
#   1. one memorable entry point          pnpm release
#   2. a preflight that fails in seconds  pnpm release --check
#
# `--check` answers "could I cut a release right now?" WITHOUT building anything.
# That matters more on macOS than anywhere else: the real path deep-signs every
# Mach-O in the bundle and then ships it to Apple's notary service, which is a
# network round trip measured in minutes and is metered by Apple's patience, not
# ours. Finding out afterwards that APPLE_TEAM_ID was never exported is the
# expensive way to learn it.
#
# Usage:
#   bash scripts/release.sh --check              # preflight only; builds nothing
#   bash scripts/release.sh                      # build + sign + notarize
#   bash scripts/release.sh --sidecars --upload  # ...rebuild sidecars, then publish
#   bash scripts/release.sh --tag v0.9.1         # override the tag
#
# Everything else — the artifact layout, the notarization dance, the latest.json
# merge — lives in scripts/package/release-macos.sh and is deliberately NOT
# duplicated here. If releasing changes, it changes there.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
cd "${ROOT_DIR}"

# --- Pretty logging (same shape as dev.sh / stop.sh) -------------------------
c_reset="\033[0m"; c_red="\033[31m"; c_grn="\033[32m"; c_yel="\033[33m"; c_blu="\033[34m"; c_dim="\033[2m"
info() { printf "${c_blu}[release]${c_reset} %s\n" "$*"; }
ok()   { printf "${c_grn}[release]${c_reset} %s\n" "$*"; }
warn() { printf "${c_yel}[release][warn]${c_reset} %s\n" "$*" >&2; }
err()  { printf "${c_red}[release][error]${c_reset} %s\n" "$*" >&2; }

usage() {
  cat <<'EOF'
scripts/release.sh — cut a macOS release (or check whether you could).

  pnpm release --check          preflight only: builds NOTHING, ~5 seconds
  pnpm release                     build, deep-sign, notarize, staple
  pnpm release --sidecars       ...rebuilding the bundled sidecars first
  pnpm release --upload         ...and upload to the draft + merge latest.json
  pnpm release --tag v0.9.1     override the tag (default: v<tauri.conf version>)

Options:
  -c, --check       Run the preflight gates and report readiness. No build.
  -s, --sidecars    Rebuild the sidecars (orchestrator SEA, frozen Python
                    workers, vd-piper, static ffmpeg, uv + CPython) first.
                    Forwarded to release-macos.sh as SIDECARS=1.
  -u, --upload      Upload the .dmg + updater artifacts to the vX.Y.Z draft and
                    merge the darwin-aarch64 entry into latest.json.
                    Forwarded to release-macos.sh as UPLOAD=1.
  -t, --tag TAG     Release tag. Forwarded as RELEASE_TAG.
  -h, --help        This text.

The PowerShell spellings (-Check, -Sidecars, -Upload, -Tag) work here too, so
`pnpm release:check` can pass one flag that both twins understand.

Required in the environment for a real build (all four are checked by --check):
  APPLE_SIGNING_IDENTITY   "Developer ID Application: … (TEAMID)"
  APPLE_ID                 your Apple ID
  APPLE_PASSWORD           the app-specific password — a SECRET, never stored here
  APPLE_TEAM_ID            your Team ID
Plus the updater private key: TAURI_SIGNING_PRIVATE_KEY, or ~/.tauri/videodubber.key.

Windows releases are cut on the Windows desktop: pwsh scripts\release.ps1
See docs/RELEASING.md for the full runbook.
EOF
}

# --- Refuse to run on the wrong OS -------------------------------------------
# There is no cross-compilation here: the macOS bundle must be signed by a
# Developer ID keychain identity and notarized by Apple from a Mac, and the
# Windows installer is built by NSIS/WiX on the Windows box (D:\ drive). Saying
# which script to run where is cheaper than letting `codesign: command not found`
# explain it.
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
if [ "${UNAME_S}" != "Darwin" ]; then
  err "This is the macOS release script; this machine is '${UNAME_S}'."
  case "${UNAME_S}" in
    MINGW*|MSYS*|CYGWIN*)
      err "On Windows run:   pnpm release -Check      (or: pwsh scripts\\release.ps1)" ;;
    *)
      err "Releases are cut on two machines only:"
      err "  macOS   -> bash scripts/release.sh   (this script, on the Mac)"
      err "  Windows -> pwsh scripts\\release.ps1 (on the Windows desktop)"
      err "There is no Linux release target — see docs/RELEASING.md." ;;
  esac
  exit 1
fi

# --- Parse flags -------------------------------------------------------------
DO_CHECK=0
DO_SIDECARS=0
DO_UPLOAD=0
TAG_OVERRIDE="${RELEASE_TAG:-}"

# The PowerShell spellings (-Check / -Sidecars / -Upload / -Tag) are accepted
# alongside the POSIX ones. `pnpm release:check` is ONE package.json entry, and
# scripts/run.mjs forwards its argv VERBATIM to whichever twin the host OS has —
# so the flag it passes has to be a spelling BOTH halves understand.
# release.ps1 cannot be the one to bend: PowerShell binds `-Name`, never
# `--name`, so `--check` is a parameter-binding error there. Four extra case
# labels here keep the documented command identical on the two release machines,
# which is the entire point of having a front door.
while [ "$#" -gt 0 ]; do
  case "$1" in
    -c|--check|-[Cc]heck)          DO_CHECK=1 ;;
    -s|--sidecars|-[Ss]idecars)    DO_SIDECARS=1 ;;
    -u|--upload|-[Uu]pload)        DO_UPLOAD=1 ;;
    -t|--tag|-[Tt]ag)
      shift
      [ "$#" -gt 0 ] || { err "--tag needs a value (e.g. --tag v0.9.1)"; exit 2; }
      TAG_OVERRIDE="$1" ;;
    --tag=*)       TAG_OVERRIDE="${1#--tag=}" ;;
    -h|--help)     usage; exit 0 ;;
    *)
      err "unknown option: $1"
      echo "" >&2
      usage >&2
      exit 2 ;;
  esac
  shift
done

# --- Version / tag -----------------------------------------------------------
CONF="${ROOT_DIR}/apps/desktop/src-tauri/tauri.conf.json"
VERSION="$(node -p "require('${CONF}').version" 2>/dev/null || true)"
if [ -z "${VERSION}" ]; then
  err "could not read the version from ${CONF} (is Node on PATH?)"
  exit 1
fi
TAG="${TAG_OVERRIDE:-v${VERSION}}"

# --- Check accounting --------------------------------------------------------
# bash 3.2 is the floor (macOS ships 3.2.57 and always will — zsh is the login
# shell and Apple will not ship a GPLv3 bash), so: no associative arrays, no
# `mapfile`, no `${var^^}`. Two plain counters and a printf do the job.
checks_failed=0
checks_warned=0

# report STATUS NAME DETAIL [HINT]
# STATUS is OK / WARN / MISSING, matching scripts/verify-environment.ts so the
# two readouts look like one tool rather than two.
report() {
  local status="$1" name="$2" detail="$3" hint="${4:-}"
  local badge
  case "${status}" in
    OK)      badge="${c_grn}OK     ${c_reset}" ;;
    WARN)    badge="${c_yel}WARN   ${c_reset}"; checks_warned=$((checks_warned + 1)) ;;
    MISSING) badge="${c_red}MISSING${c_reset}"; checks_failed=$((checks_failed + 1)) ;;
    *)       badge="${status}" ;;
  esac
  printf "  ${badge}  %-26s %s\n" "${name}" "${detail}"
  # 11 spaces = 2 indent + 7-char badge + 2, so the hint lines up under `detail`.
  [ -n "${hint}" ] && printf "           %-26s ${c_dim}-> %s${c_reset}\n" "" "${hint}"
  return 0
}

# --- Individual gates --------------------------------------------------------

# 1. The four manifests + Cargo.lock must agree. A half-done bump is invisible
#    once the artifacts exist, and the updater compares against tauri.conf.json
#    alone — so the repo lies about itself and the next version bug is
#    mis-diagnosed. check-versions.mjs is the existing checker; don't re-derive it.
check_versions() {
  local out
  if out="$(node "${ROOT_DIR}/scripts/check-versions.mjs" 2>&1)"; then
    report OK "version consistency" "all manifests at ${VERSION}"
  else
    report MISSING "version consistency" "manifests disagree" \
      "node scripts/check-versions.mjs --set ${VERSION}"
    printf "%s\n" "${out}" | sed 's/^/            /'
  fi
}

# 2. The Python suites. REQUIRE_ALL=1 IS THE POINT: without it test-workers.sh
#    reports "skipped" and exits 0 on a machine with no worker venvs — i.e. the
#    release gate passes having run nothing at all, which is strictly worse than
#    no gate because it reads green. A release box must be able to run them.
check_worker_suites() {
  local out
  if out="$(REQUIRE_ALL=1 bash "${ROOT_DIR}/scripts/test-workers.sh" 2>&1)"; then
    report OK "python worker suites" "$(printf '%s' "${out}" | tail -1)"
  else
    report MISSING "python worker suites" "suite failed or could not run" \
      "bash scripts/setup-local-models.sh   # creates the per-worker venvs"
    printf "%s\n" "${out}" | sed 's/^/            /'
  fi
}

# 3. A dirty tree means the artifacts you are about to sign do not correspond to
#    any commit, so "which build is this?" has no answer afterwards — and the
#    version bump in step 1 of the runbook is exactly the change people forget to
#    commit before building. ALLOW_DIRTY=1 is the escape hatch for a deliberate
#    local-only experiment; it is a warning then, not a pass.
check_git_clean() {
  local dirty
  dirty="$(git -C "${ROOT_DIR}" status --porcelain 2>/dev/null || true)"
  if [ -z "${dirty}" ]; then
    report OK "git tree" "clean at $(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || echo '?')"
  elif [ "${ALLOW_DIRTY:-0}" = "1" ]; then
    report WARN "git tree" "$(printf '%s\n' "${dirty}" | wc -l | tr -d ' ') uncommitted change(s), ALLOW_DIRTY=1" \
      "the build will not correspond to any commit"
  else
    report MISSING "git tree" "$(printf '%s\n' "${dirty}" | wc -l | tr -d ' ') uncommitted change(s)" \
      "commit or stash them, or re-run with ALLOW_DIRTY=1"
    printf "%s\n" "${dirty}" | head -10 | sed 's/^/            /'
  fi
}

# 4. The updater private key. Without it `tauri build` stops at "A public key has
#    been found, but no private key", and even if it did not, there would be no
#    .sig — which means the auto-updater can never install this build and every
#    existing user is stranded on the version they have.
check_updater_key() {
  if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    report OK "updater signing key" "TAURI_SIGNING_PRIVATE_KEY is set"
  elif [ -f "${HOME}/.tauri/videodubber.key" ]; then
    report OK "updater signing key" "~/.tauri/videodubber.key"
  else
    report MISSING "updater signing key" "no key in env or ~/.tauri/videodubber.key" \
      "export TAURI_SIGNING_PRIVATE_KEY=\"\$(cat /path/to/videodubber.key)\""
  fi
}

# 5. A GitHub token, the same way release-upload.sh finds one: $GH_TOKEN, else
#    the OAuth token `git credential` already holds (no `gh` CLI on this machine).
#    Only --upload needs it, so it is a warning otherwise — but it is still worth
#    reporting, because discovering it at upload time is discovering it after the
#    notarization round trip.
check_github_token() {
  local token=""
  if [ -n "${GH_TOKEN:-}" ]; then
    report OK "github token" "GH_TOKEN is set"
    return 0
  fi
  # GIT_TERMINAL_PROMPT=0 so a machine with no credential helper fails fast
  # instead of blocking a "preflight" on a username prompt.
  token="$(printf 'protocol=https\nhost=github.com\n\n' \
    | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null \
    | sed -n 's/^password=//p' || true)"
  if [ -n "${token}" ]; then
    report OK "github token" "from git credential (github.com)"
  elif [ "${DO_UPLOAD}" = "1" ]; then
    report MISSING "github token" "none available, and --upload was requested" \
      "export GH_TOKEN=…, or log in so 'git credential' has one"
  else
    report WARN "github token" "none available (only needed for --upload)" \
      "export GH_TOKEN=…, or log in so 'git credential' has one"
  fi
}

# 6. The Developer ID identity must exist IN THE KEYCHAIN, not merely be named in
#    the environment: a correct-looking APPLE_SIGNING_IDENTITY pointing at a
#    certificate this login keychain does not hold fails at the deep-sign step,
#    after the whole app has been built.
check_signing_identity() {
  if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
    report MISSING "Developer ID identity" "APPLE_SIGNING_IDENTITY is not set" \
      "export APPLE_SIGNING_IDENTITY='Developer ID Application: … (TEAMID)'"
    return 0
  fi
  local found=""
  found="$(security find-identity -v -p codesigning 2>/dev/null | grep -F "${APPLE_SIGNING_IDENTITY}" || true)"
  if [ -n "${found}" ]; then
    report OK "Developer ID identity" "in the keychain"
  else
    report MISSING "Developer ID identity" "not found in this login keychain" \
      "security find-identity -v -p codesigning   # and pick one of those"
  fi
}

# 7. The notary credentials. release-macos.sh WITHHOLDS them from `tauri build`
#    on purpose (Tauri's own notarization fails because its signing never reaches
#    the bundled PyInstaller .so files) and uses them in macos-sign-notarize.sh
#    instead — but they must still be exported before any of it starts.
check_notary_creds() {
  local missing=""
  [ -n "${APPLE_ID:-}" ]       || missing="${missing} APPLE_ID"
  [ -n "${APPLE_PASSWORD:-}" ] || missing="${missing} APPLE_PASSWORD"
  [ -n "${APPLE_TEAM_ID:-}" ]  || missing="${missing} APPLE_TEAM_ID"
  if [ -z "${missing}" ]; then
    report OK "notarization creds" "APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID set"
  else
    report MISSING "notarization creds" "unset:${missing}" \
      "APPLE_PASSWORD is an app-specific password from appleid.apple.com — a SECRET"
  fi
}

# 8. The toolchain the build actually shells out to. Cheap to look for, and each
#    one's absence surfaces deep inside a build log as something else's error.
check_tool() {  # check_tool NAME BINARY HINT
  local name="$1" bin="$2" hint="$3" path
  if path="$(command -v "${bin}" 2>/dev/null)"; then
    report OK "${name}" "${path}"
  else
    report MISSING "${name}" "not on PATH" "${hint}"
  fi
}

# --- Preflight ---------------------------------------------------------------
preflight() {
  echo ""
  printf "  ${c_blu}VideoDubber — release preflight${c_reset}  ${c_dim}(macOS, %s -> %s)${c_reset}\n" "${VERSION}" "${TAG}"
  printf "  ${c_dim}%s${c_reset}\n" "----------------------------------------------------------------------"
  check_tool  "node"              node    "install Node 24: brew install node@24"
  check_tool  "pnpm"              pnpm    "corepack enable && corepack prepare pnpm@latest --activate"
  check_tool  "cargo"             cargo   "install Rust: https://rustup.rs"
  check_tool  "xcrun"             xcrun   "xcode-select --install"
  check_versions
  check_worker_suites
  check_git_clean
  check_updater_key
  check_signing_identity
  check_notary_creds
  check_github_token
  printf "  ${c_dim}%s${c_reset}\n" "----------------------------------------------------------------------"
  printf "  Summary: ${c_yel}%d warning(s)${c_reset}, ${c_red}%d blocking${c_reset}\n" \
    "${checks_warned}" "${checks_failed}"
  echo ""
}

# --- What the real run will do, said out loud --------------------------------
describe_build() {
  info "macOS release ${VERSION} -> tag ${TAG}"
  info "This build will DEEP-SIGN every Mach-O in the bundle and NOTARIZE it with Apple."
  info "  Notarization is a network round trip to Apple and takes minutes, so a failed"
  info "  preflight is much cheaper to discover now: bash scripts/release.sh --check"
  [ "${DO_SIDECARS}" = "1" ] && info "  sidecars: WILL be rebuilt (SIDECARS=1)" || info "  sidecars: reusing whatever is already staged (pass --sidecars to rebuild)"
  [ "${DO_UPLOAD}" = "1" ]   && info "  upload:   WILL upload to the ${TAG} draft and merge latest.json (UPLOAD=1)" || info "  upload:   no (pass --upload to publish to the draft)"
}

# --- Main --------------------------------------------------------------------
if [ "${DO_CHECK}" = "1" ]; then
  preflight
  if [ "${checks_failed}" -gt 0 ]; then
    err "NOT ready to release: ${checks_failed} blocking item(s) above."
    err "Nothing was built. Fix those, then re-run: bash scripts/release.sh --check"
    exit 1
  fi
  ok "Ready to release ${TAG}."
  echo ""
  info "Next:  bash scripts/release.sh --sidecars --upload"
  info "       (or: pnpm release --sidecars --upload)"
  info "Then finish the runbook in docs/RELEASING.md — the draft still needs the"
  info "Windows half uploaded and the release published by hand."
  exit 0
fi

# Real build. Run only the gates release-macos.sh does NOT already run — it owns
# the version check and the worker suites itself, and running pytest twice for
# the same release buys nothing. REQUIRE_ALL=1 is EXPORTED instead, so its own
# `bash scripts/test-workers.sh` call inherits the strict behaviour: the skip-and
# -pass hole is closed without this wrapper duplicating the gate.
export REQUIRE_ALL=1

echo ""
printf "  ${c_blu}VideoDubber — release preflight (environment only)${c_reset}\n"
printf "  ${c_dim}%s${c_reset}\n" "----------------------------------------------------------------------"
check_git_clean
check_updater_key
check_signing_identity
check_notary_creds
check_github_token
printf "  ${c_dim}%s${c_reset}\n" "----------------------------------------------------------------------"
# The Windows twin prints this line in BOTH modes (one Invoke-Preflight serves
# -Check and the pre-build gate), so print it here too: the two readouts are
# meant to be the same tool, and "0 warning(s), 0 blocking" immediately before a
# 20-minute notarized build is worth the line.
printf "  Summary: ${c_yel}%d warning(s)${c_reset}, ${c_red}%d blocking${c_reset}\n" \
  "${checks_warned}" "${checks_failed}"
echo ""

if [ "${checks_failed}" -gt 0 ]; then
  err "${checks_failed} blocking item(s) above — stopping BEFORE the build."
  err "Full preflight (adds the version + pytest gates): bash scripts/release.sh --check"
  exit 1
fi

describe_build
echo ""

# Hand off. Everything below this line is release-macos.sh's job; this script
# deliberately knows nothing about artifact paths, stapling or latest.json.
# NB the trailing `|| true`: under `set -e` a bare `[ … ] && assignment` whose
# test is false returns 1 and kills the script. This idiom bites once per repo.
RELEASE_ENV=""
[ "${DO_SIDECARS}" = "1" ] && RELEASE_ENV="${RELEASE_ENV} SIDECARS=1" || true
[ "${DO_UPLOAD}" = "1" ]   && RELEASE_ENV="${RELEASE_ENV} UPLOAD=1" || true
info "==> scripts/package/release-macos.sh${RELEASE_ENV:+ (with${RELEASE_ENV})}"

SIDECARS="$([ "${DO_SIDECARS}" = "1" ] && echo 1 || echo "")" \
UPLOAD="$([ "${DO_UPLOAD}" = "1" ] && echo 1 || echo "")" \
RELEASE_TAG="${TAG}" \
  bash "${ROOT_DIR}/scripts/package/release-macos.sh"

echo ""
ok "macOS release ${TAG} built$([ "${DO_UPLOAD}" = "1" ] && echo " and uploaded to the draft" || echo "")."
info "Remaining runbook steps (docs/RELEASING.md): build + upload the Windows half"
info "on the Windows desktop, confirm latest.json carries BOTH platforms, then"
info "publish the ${TAG} draft on GitHub."
