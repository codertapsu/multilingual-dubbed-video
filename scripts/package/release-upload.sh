#!/usr/bin/env bash
#
# release-upload.sh — local-first release helper (macOS / Linux).
#
# Ensures the DRAFT GitHub release for the tag exists and uploads locally-built
# installer artifacts to it, WITHOUT running CI — so cutting a release doesn't
# burn (10x-billed) macOS Actions minutes. Pairs with a local build:
#   pnpm install --frozen-lockfile
#   pnpm package:sidecars
#   pnpm app:build
#   bash scripts/package/macos-sign-notarize.sh      # sign + notarize the .dmg
#   bash scripts/package/release-upload.sh upload <built .dmg>
#
# Auth: the GitHub OAuth token from `git credential` (no `gh` CLI needed), or
# GH_TOKEN if exported. Repo/tag default to this project; override with
# GH_REPO / RELEASE_TAG.
#
# Usage:
#   bash scripts/package/release-upload.sh ensure                  # print RELEASE_ID
#   bash scripts/package/release-upload.sh upload <file> [file...] # ensure + upload (replacing)
set -euo pipefail

TAG="${RELEASE_TAG:-v0.1.0}"
REPO="${GH_REPO:-codertapsu/multilingual-dubbed-video}"
RELEASE_NAME="VideoDubber ${TAG}"

TOKEN="${GH_TOKEN:-$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')}"
[ -n "$TOKEN" ] || { echo "error: no GitHub token (set GH_TOKEN or log in so 'git credential' has one)" >&2; exit 1; }

# api METHOD PATH [extra curl args...]
api() {
  local method="$1" path="$2"; shift 2
  curl -fsSL -X "$method" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json" \
    "https://api.github.com${path}" "$@"
}

ensure_release() {
  local id
  id="$(api GET "/repos/$REPO/releases?per_page=100" | python3 -c "import sys,json,os
print(next((str(r['id']) for r in json.load(sys.stdin) if r['tag_name']==os.environ['TAG']), ''))")"
  if [ -z "$id" ]; then
    local body
    body="$(python3 -c "import json,os;print(json.dumps({'tag_name':os.environ['TAG'],'name':os.environ['RELEASE_NAME'],'draft':True,'prerelease':False}))")"
    id="$(api POST "/repos/$REPO/releases" -d "$body" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")"
    echo "created draft release $TAG (id $id)" >&2
  fi
  printf '%s' "$id"
}

upload_one() {  # upload_one RELEASE_ID FILE
  local rid="$1" file="$2" base aid
  base="$(basename "$file")"
  aid="$(api GET "/repos/$REPO/releases/$rid/assets?per_page=100" | BASE="$base" python3 -c "import sys,json,os
print(next((str(a['id']) for a in json.load(sys.stdin) if a['name']==os.environ['BASE']), ''))")"
  if [ -n "$aid" ]; then api DELETE "/repos/$REPO/releases/assets/$aid" >/dev/null; fi
  # Stream the file with `-T` (curl reads it from disk) instead of
  # `--data-binary @file`, which buffers the ENTIRE file in memory and OOMs on
  # multi-GB installers (the app bundles the offline models now).
  curl -fsSL -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/octet-stream" \
    -T "$file" \
    "https://uploads.github.com/repos/$REPO/releases/$rid/assets?name=$base" >/dev/null
  echo "  uploaded $base ($(du -h "$file" | cut -f1))"
}

export TAG REPO RELEASE_NAME
cmd="${1:-}"; shift || true
case "$cmd" in
  ensure)
    ensure_release; echo >&2
    ;;
  upload)
    [ "$#" -gt 0 ] || { echo "usage: release-upload.sh upload <file> [file...]" >&2; exit 1; }
    rid="$(ensure_release)"
    echo "release $TAG -> id $rid"
    for f in "$@"; do
      if [ -f "$f" ]; then upload_one "$rid" "$f"; else echo "  skip (missing): $f" >&2; fi
    done
    echo "done. Review/publish the draft: https://github.com/$REPO/releases"
    ;;
  *)
    echo "usage: release-upload.sh {ensure | upload <file> [file...]}" >&2; exit 1
    ;;
esac
