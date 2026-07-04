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
#                 UPLOAD=1   to upload the .dmg + updater artifacts to the draft
#                            release for the current version and merge the
#                            darwin-aarch64 entry into its latest.json;
#                 RELEASE_TAG to override the tag (default v<tauri.conf version>).
#
# The auto-update artifacts (.app.tar.gz + .sig) are ALWAYS regenerated from the
# REPAIRED + notarized .app (the ones `tauri build` emits are from the pre-repair
# app and must not ship — this was a by-hand step for v0.2.0, now scripted).
# Needs TAURI_SIGNING_PRIVATE_KEY (or ~/.tauri/videodubber.key) for the .sig.
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

# --- auto-update artifacts: regenerate from the REPAIRED, notarized app --------
VERSION="$(node -e "console.log(require('./apps/desktop/src-tauri/tauri.conf.json').version)")"
TAG="${RELEASE_TAG:-v${VERSION}}"
APP="$(find apps/desktop/src-tauri/target -path '*/release/bundle/macos/VideoDubber.app' | head -1)"
[ -n "$APP" ] || { echo "::error::repaired VideoDubber.app not found"; exit 1; }
TARBALL_DIR="$(dirname "$APP")"
TARBALL="${TARBALL_DIR}/VideoDubber_${VERSION}_aarch64.app.tar.gz"
echo "==> regenerate updater archive from the repaired app: $(basename "$TARBALL")"
xcrun stapler staple "$APP" >/dev/null 2>&1 || true   # idempotent; ensures the ticket rides along
(cd "$TARBALL_DIR" && COPYFILE_DISABLE=1 tar --no-xattrs -czf "$(basename "$TARBALL")" VideoDubber.app)
SIGN_KEY_ARGS=(-f "${HOME}/.tauri/videodubber.key")
[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && SIGN_KEY_ARGS=(--private-key "${TAURI_SIGNING_PRIVATE_KEY}")
pnpm --filter videodubber-desktop exec tauri signer sign "${SIGN_KEY_ARGS[@]}" \
  -p "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" "$TARBALL"
[ -f "${TARBALL}.sig" ] || { echo "::error::updater signature not produced (${TARBALL}.sig)"; exit 1; }

if [ "${UPLOAD:-}" = "1" ]; then
  echo "==> upload the notarized .dmg + updater artifacts to the ${TAG} draft"
  dmg="$(find apps/desktop/src-tauri/target -path '*/bundle/dmg/VideoDubber_*_aarch64.dmg' | head -1)"
  [ -n "$dmg" ] || { echo "::error::no notarized .dmg found to upload"; exit 1; }
  RELEASE_TAG="$TAG" bash scripts/package/release-upload.sh upload "$dmg" "$TARBALL" "${TARBALL}.sig"
  echo "==> merge the darwin-aarch64 entry into latest.json (preserves the windows entry)"
  node scripts/package/merge-latest-json.mjs --tag "$TAG" --platform darwin-aarch64 \
    --artifact "$TARBALL" --fix-tag
fi

echo "macOS release complete."
