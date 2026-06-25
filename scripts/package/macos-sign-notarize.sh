#!/usr/bin/env bash
#
# macos-sign-notarize.sh — post-build macOS Developer ID signing + notarization
# for the VideoDubber .app, run AFTER tauri-action.
#
# Why this exists:
#   * The externalBin sidecars in Contents/MacOS (videodubber-orchestrator,
#     ffmpeg, ffprobe, vd-uv, vd-piper) are only ADHOC-signed by the linker on a
#     local `tauri build` — CI's tauri-action Developer-ID-signs them, a local
#     build does NOT — so notarization rejects them ("not signed with a valid
#     Developer ID certificate" / "does not have hardened runtime"), and
#   * the Mach-O under bundle.resources (standalone CPython + PyInstaller workers)
#     aren't deep-signed by Tauri either, and Tauri's resource copy DEREFERENCES
#     symlinks, flattening PyInstaller's `Python.framework` into a malformed
#     bundle whose binaries notarization rejects.
# So we sign EVERYTHING ourselves: REPAIR each framework's symlinks + re-sign it
# as a bundle, Developer-ID-sign every loose Mach-O across the app (Contents/MacOS
# + Contents/Resources) with the hardened runtime + entitlements, re-seal the
# .app, build a fresh .dmg, then notarytool + stapler. Works for local AND CI
# builds (re-signing already-signed binaries is a no-op). When run in CI,
# tauri-action's own notarization is disabled by withholding the notary vars.
#
# Env: APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID (required);
#      ENTITLEMENTS (default apps/desktop/src-tauri/entitlements.plist);
#      GH_TOKEN + GH_REPO + RELEASE_ID (optional — replace the release's .dmg).
set -euo pipefail

ID="${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY required}"
ENT="${ENTITLEMENTS:-apps/desktop/src-tauri/entitlements.plist}"
TARGET_DIR="apps/desktop/src-tauri/target"
[ -f "$ENT" ] || { echo "::error::entitlements not found at $ENT"; exit 1; }

APP="$(find "$TARGET_DIR" -path '*/release/bundle/macos/VideoDubber.app' | head -1)"
[ -n "$APP" ] || { echo "::error::VideoDubber.app not found under $TARGET_DIR"; exit 1; }
echo "App:  $APP"

sign() { codesign --force --options runtime --timestamp --sign "$ID" "$@"; }

echo "==> 1/5 repair + sign frameworks (Tauri dereferenced their symlinks)"
while IFS= read -r -d '' fw; do
  ver="$(ls "$fw/Versions" 2>/dev/null | grep -vix current | head -1)"
  if [ -n "$ver" ]; then
    # Rebuild the Versions/Current symlink + the top-level symlinks (Python,
    # Resources, Headers, …) that point into Versions/Current.
    rm -rf "$fw/Versions/Current"; ln -s "$ver" "$fw/Versions/Current"
    for entry in "$fw/Versions/$ver"/*; do
      [ -e "$entry" ] || continue
      top="$(basename "$entry")"
      if [ -e "$fw/$top" ] && [ ! -L "$fw/$top" ]; then
        rm -rf "$fw/$top"; ln -s "Versions/Current/$top" "$fw/$top"
      fi
    done
    # Repoint the sibling copy (e.g. _internal/Python that PyInstaller symlinks
    # next to _internal/Python.framework) back into the framework.
    binname="$(basename "$fw" .framework)"
    sibling="$(dirname "$fw")/$binname"
    if [ -e "$sibling" ] && [ ! -L "$sibling" ] && [ -e "$fw/Versions/Current/$binname" ]; then
      rm -rf "$sibling"; ln -s "$(basename "$fw")/Versions/Current/$binname" "$sibling"
    fi
  fi
  sign "$fw"
  codesign --verify --strict "$fw"
  echo "    framework: ${fw#"$APP"/}"
done < <(find "$APP/Contents" -type d -name '*.framework' -print0 | sort -zr)

echo "==> 2/5 sign every loose Mach-O across the app (MacOS externalBin are adhoc"
echo "       from the linker; executables get the hardened-runtime entitlements)"
n=0
while IFS= read -r -d '' f; do
  case "$f" in */*.framework/*) continue ;; esac
  case "$(file -b "$f")" in
    *Mach-O*executable*) sign --entitlements "$ENT" "$f" ;;
    *Mach-O*) sign "$f" ;;
    *) continue ;;
  esac
  n=$((n + 1))
done < <(find "$APP/Contents" -type f -print0)
echo "    signed $n loose Mach-O"

echo "==> 3/5 re-seal the app (its CodeResources is stale after editing Resources)"
sign --entitlements "$ENT" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "==> 4/5 build a fresh .dmg from the repaired app"
VER="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"
ARCH="$([ "$(uname -m)" = "arm64" ] && echo aarch64 || echo x64)"
DMGDIR="$(cd "$(dirname "$APP")/.." && pwd)/dmg"
mkdir -p "$DMGDIR"
DMG="$DMGDIR/VideoDubber_${VER}_${ARCH}.dmg"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "VideoDubber" -srcfolder "$STAGE" -fs HFS+ -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
codesign --force --timestamp --sign "$ID" "$DMG"   # sign the .dmg container too
echo "    DMG:  $DMG"

echo "==> 5/5 notarize + staple"
submit_json="$(xcrun notarytool submit "$DMG" \
  --apple-id "${APPLE_ID:?}" --password "${APPLE_PASSWORD:?}" --team-id "${APPLE_TEAM_ID:?}" \
  --wait --output-format json)"
echo "$submit_json"
sub_id="$(printf '%s' "$submit_json" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)"
sub_status="$(printf '%s' "$submit_json" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)"
if [ "$sub_status" != "Accepted" ]; then
  # Self-diagnose: print Apple's per-file reasons instead of failing opaquely at
  # the staple step (a rejected submission has no ticket -> "Record not found").
  echo "::error::Notarization status: ${sub_status:-unknown}. Per-file reasons from the notary log:"
  [ -n "$sub_id" ] && xcrun notarytool log "$sub_id" \
    --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" || true
  exit 1
fi
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl -a -t open -vv --context context:primary-signature "$DMG" || true

# Replace the release's .dmg asset with this notarized one (CI only).
if [ -n "${GH_TOKEN:-}" ] && [ -n "${GH_REPO:-}" ] && [ -n "${RELEASE_ID:-}" ]; then
  base="$(basename "$DMG")"
  aid="$(curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
      "https://api.github.com/repos/$GH_REPO/releases/$RELEASE_ID/assets?per_page=100" 2>/dev/null \
      | python3 -c "import sys,json
try:
  print(next(a['id'] for a in json.load(sys.stdin) if a['name']=='$base'))
except Exception:
  pass" 2>/dev/null || true)"
  [ -n "$aid" ] && curl -fsSL -X DELETE -H "Authorization: Bearer $GH_TOKEN" \
    "https://api.github.com/repos/$GH_REPO/releases/assets/$aid" >/dev/null 2>&1 || true
  curl -fsSL -X POST -H "Authorization: Bearer $GH_TOKEN" \
    -H "Content-Type: application/x-apple-diskimage" --data-binary @"$DMG" \
    "https://uploads.github.com/repos/$GH_REPO/releases/$RELEASE_ID/assets?name=$base" >/dev/null
  echo "Uploaded notarized $base to the release."
fi
echo "macOS signing + notarization complete: $DMG"
