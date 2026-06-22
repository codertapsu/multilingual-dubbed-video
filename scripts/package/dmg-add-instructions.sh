#!/usr/bin/env bash
#
# dmg-add-instructions.sh — drop the macOS "Open Me First" unlock steps INTO a
# built .dmg, so the first-launch instructions travel with the download (release
# notes are easy to miss). The app is unsigned/un-notarized today, so a
# non-technical user otherwise hits Gatekeeper with no guidance.
#
# Best-effort by design: ANY failure logs a warning and exits 0, so it can never
# break a release (the GitHub release body + README also carry the steps).
#
# Usage:
#   bash scripts/package/dmg-add-instructions.sh <path-to.dmg> [more.dmg ...]
#
# Optional: if GH_TOKEN, GH_REPO (owner/repo) and RELEASE_ID are all set, the
# modified .dmg replaces the matching asset on that draft release — and if the
# re-upload fails, the ORIGINAL is restored (so the release is never left without
# its installer). Used by the macOS release CI step.
set -uo pipefail

TXT="${DMG_INSTRUCTIONS_FILE:-apps/desktop/src-tauri/dmg/Open Me First.txt}"
NAME="Open Me First.txt"

warn() { echo "dmg-add-instructions: WARN: $*" >&2; }
info() { echo "dmg-add-instructions: $*"; }

if [[ "$(uname -s)" != "Darwin" ]]; then warn "not macOS; skipping."; exit 0; fi
if [[ ! -f "$TXT" ]]; then warn "instructions file not found at '$TXT'; skipping."; exit 0; fi
if [[ $# -eq 0 ]]; then warn "no .dmg paths given; skipping."; exit 0; fi

# Upload `$2` (a .dmg) as the release asset named after `$1`, replacing any
# existing asset of that name. Returns non-zero on failure.
upload_asset() {
  local name="$1" file="$2"
  local api="https://api.github.com/repos/${GH_REPO}"
  local existing
  existing="$(curl -fsSL -H "Authorization: Bearer ${GH_TOKEN}" \
    "${api}/releases/${RELEASE_ID}/assets?per_page=100" 2>/dev/null \
    | python3 -c "import sys,json
try:
  print(next(a['id'] for a in json.load(sys.stdin) if a['name']=='${name}'))
except Exception:
  pass" 2>/dev/null)"
  if [[ -n "${existing}" ]]; then
    curl -fsSL -X DELETE -H "Authorization: Bearer ${GH_TOKEN}" \
      "${api}/releases/assets/${existing}" >/dev/null 2>&1 || true
  fi
  curl -fsSL -X POST \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Content-Type: application/x-apple-diskimage" \
    --data-binary @"${file}" \
    "https://uploads.github.com/repos/${GH_REPO}/releases/${RELEASE_ID}/assets?name=${name}" \
    >/dev/null 2>&1
}

inject() {
  local dmg="$1"
  [[ -f "${dmg}" ]] || { warn "no such dmg: ${dmg}"; return 0; }
  local base; base="$(basename "${dmg}")"
  local work backup mnt out
  work="$(mktemp -u /tmp/vd-dmg-XXXXXX).dmg"
  backup="$(mktemp -u /tmp/vd-dmg-bak-XXXXXX).dmg"
  out="$(mktemp -u /tmp/vd-dmg-out-XXXXXX).dmg"
  mnt="$(mktemp -d /tmp/vd-dmg-mnt-XXXXXX)"

  cp "${dmg}" "${backup}" 2>/dev/null || { warn "backup failed for ${base}"; return 0; }

  # Compressed RO dmg -> editable RW image -> mount -> add the file -> RO again.
  if ! hdiutil convert "${dmg}" -format UDRW -o "${work}" >/dev/null 2>&1; then
    warn "convert(RW) failed for ${base}"; rm -f "${work}" "${backup}"; rmdir "${mnt}" 2>/dev/null; return 0
  fi
  if ! hdiutil attach "${work}" -mountpoint "${mnt}" -nobrowse -noverify -noautoopen >/dev/null 2>&1; then
    warn "attach failed for ${base}"; rm -f "${work}" "${backup}"; rmdir "${mnt}" 2>/dev/null; return 0
  fi
  cp "${TXT}" "${mnt}/${NAME}" 2>/dev/null || warn "copy into ${base} failed"
  hdiutil detach "${mnt}" >/dev/null 2>&1 || hdiutil detach "${mnt}" -force >/dev/null 2>&1
  if ! hdiutil convert "${work}" -format UDZO -o "${out}" >/dev/null 2>&1; then
    warn "convert(RO) failed for ${base}; leaving original unchanged"
    rm -f "${work}" "${out}" "${backup}"; rmdir "${mnt}" 2>/dev/null; return 0
  fi
  mv -f "${out}" "${dmg}" && info "added '${NAME}' to ${base}"
  rm -f "${work}" 2>/dev/null; rmdir "${mnt}" 2>/dev/null || true

  # Replace the asset on the draft release if CI passed the release coordinates.
  if [[ -n "${GH_TOKEN:-}" && -n "${GH_REPO:-}" && -n "${RELEASE_ID:-}" ]]; then
    if upload_asset "${base}" "${dmg}"; then
      info "replaced release asset ${base}"
    else
      warn "re-upload failed for ${base}; restoring the original installer"
      upload_asset "${base}" "${backup}" || warn "RESTORE FAILED for ${base} — check the release!"
    fi
  fi
  rm -f "${backup}" 2>/dev/null || true
}

for dmg in "$@"; do inject "${dmg}"; done
exit 0
