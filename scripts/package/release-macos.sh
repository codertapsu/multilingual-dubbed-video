#!/usr/bin/env bash
#
# release-macos.sh — one-command local macOS release: build, deep-sign +
# notarize, and (optionally) upload the .dmg to the GitHub draft.
#
# WHY THIS EXISTS: `tauri build` will try to NOTARIZE the app itself if the
# notary creds (APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID) are in the
# environment — and Tauri's signing does NOT reach the bundled PyInstaller
# worker .so files, so that in-build notarization FAILS ("not signed with a
# valid Developer ID certificate"). We therefore run `tauri build` with the
# notary creds withheld (Tauri just signs the app shell), then deep-sign EVERY
# Mach-O + notarize ourselves via macos-sign-notarize.sh. This wrapper makes the
# env handling impossible to get wrong.
#
# Env (required): APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID.
# Env (optional): SIDECARS=1 to (re)build the bundled sidecars first;
#                 UPLOAD=1   to upload the notarized .dmg to the v0.1.0 draft.
set -euo pipefail

: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY (Developer ID Application: …)}"
: "${APPLE_ID:?set APPLE_ID}"
: "${APPLE_PASSWORD:?set APPLE_PASSWORD (app-specific password)}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"

cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

if [ "${SIDECARS:-}" = "1" ]; then
  echo "==> build sidecars (orchestrator + workers + piper + uv + static ffmpeg)"
  pnpm package:sidecars
fi

echo "==> build the app — notary creds withheld so tauri build does NOT notarize"
env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID pnpm app:build

echo "==> deep-sign every Mach-O + notarize + staple"
bash scripts/package/macos-sign-notarize.sh

if [ "${UPLOAD:-}" = "1" ]; then
  echo "==> upload the notarized .dmg to the draft release"
  dmg="$(find apps/desktop/src-tauri/target -path '*/bundle/dmg/VideoDubber_*_aarch64.dmg' | head -1)"
  [ -n "$dmg" ] || { echo "::error::no notarized .dmg found to upload"; exit 1; }
  bash scripts/package/release-upload.sh upload "$dmg"
fi

echo "macOS release complete."
