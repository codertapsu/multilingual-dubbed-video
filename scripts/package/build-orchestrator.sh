#!/usr/bin/env bash
#
# scripts/package/build-orchestrator.sh — Freeze the Node orchestrator into a
# single self-contained executable sidecar: `videodubber-orchestrator`.
#
# Output:
#     apps/desktop/src-tauri/binaries/videodubber-orchestrator-<target-triple>[.exe]
#
# Approach: Node SEA (Single Executable Application — official, no extra runtime
# deps). We:
#   1. `pnpm --filter @videodubber/node-orchestrator build` (tsc -> dist).
#   2. esbuild-bundle dist/server.js (+ its workspace deps @videodubber/shared and
#      @videodubber/media-worker, which are pure JS) into ONE CommonJS file.
#   3. `node --experimental-sea-config scripts/package/sea-config.json` -> a V8
#      blob, then copy the `node` binary and inject the blob with postject.
#
# Why SEA over @yao-pkg/pkg? SEA is built into Node 20+, needs no external tool,
# and tracks the exact Node version the repo already requires. (`@yao-pkg/pkg`
# is a fine alternative; if you prefer it, replace steps 2-3 with
# `pkg dist/server.js --targets node20-<os>-<arch> --output ...`.)
#
# Prerequisites: node >=20.11 (SEA + the bundled blob API), pnpm, and `npx`
# access to `esbuild` + `postject` (installed on demand here).
#
# Env knobs
# ---------
#   TARGET_TRIPLE   Override the auto-detected Rust host triple.
#   NODE_BIN        Path to the node binary to base the SEA on (default: `node`).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)"
BIN_DIR="${REPO_ROOT}/apps/desktop/src-tauri/binaries"
SEA_DIR="${BIN_DIR}/.sea"
ORCH_DIR="${REPO_ROOT}/packages/node-orchestrator"

resolve_triple() {
  if [[ -n "${TARGET_TRIPLE:-}" ]]; then echo "${TARGET_TRIPLE}"; return; fi
  if command -v rustc >/dev/null 2>&1; then rustc -Vv | sed -n 's/^host: //p'; return; fi
  echo "ERROR: rustc not found and TARGET_TRIPLE not set." >&2; exit 1
}

TRIPLE="$(resolve_triple)"
EXE_SUFFIX=""
case "${TRIPLE}" in *windows*) EXE_SUFFIX=".exe" ;; esac

NODE_BIN="${NODE_BIN:-$(command -v node)}"
if [[ -z "${NODE_BIN}" ]]; then echo "ERROR: node not found." >&2; exit 1; fi

echo "==> Building orchestrator sidecar (Node SEA)"
echo "    node:    ${NODE_BIN} ($(${NODE_BIN} --version))"
echo "    triple:  ${TRIPLE}"
mkdir -p "${SEA_DIR}"

# 1. Compile the orchestrator + its workspace deps to dist/.
echo "==> [1/4] pnpm build (orchestrator + deps)"
( cd "${REPO_ROOT}" && pnpm --filter @videodubber/node-orchestrator... build )

# 2. Bundle dist/server.js into a single CJS file with esbuild.
#    --platform=node keeps Node built-ins external; we bundle the JS workspace
#    deps in. fastify/@fastify/cors are pure JS and bundle cleanly.
echo "==> [2/4] esbuild bundle -> orchestrator.cjs"
BUNDLE="${SEA_DIR}/orchestrator.cjs"
( cd "${REPO_ROOT}" && "${REPO_ROOT}/node_modules/.bin/esbuild" "${SCRIPT_DIR}/orchestrator-entry.mjs" \
    --bundle \
    --platform=node \
    --format=cjs \
    --target=node20 \
    --outfile="${BUNDLE}" \
    --banner:js="// VideoDubber orchestrator — bundled for Node SEA. Do not edit." )

# 3. Generate the SEA blob from the bundle.
echo "==> [3/4] node --experimental-sea-config -> orchestrator.blob"
( cd "${REPO_ROOT}" && "${NODE_BIN}" --experimental-sea-config "${SCRIPT_DIR}/sea-config.json" )

# 4. Copy the node binary and inject the blob with postject.
echo "==> [4/4] inject blob into node copy (postject)"
OUT="${BIN_DIR}/videodubber-orchestrator-${TRIPLE}${EXE_SUFFIX}"
cp -f "${NODE_BIN}" "${OUT}"

# macOS: remove the existing signature before injecting; re-sign ad-hoc after.
case "${TRIPLE}" in
  *apple-darwin*)
    codesign --remove-signature "${OUT}" || true
    ;;
esac

"${REPO_ROOT}/node_modules/.bin/postject" "${OUT}" NODE_SEA_BLOB "${SEA_DIR}/orchestrator.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  $( [[ "${TRIPLE}" == *apple-darwin* ]] && echo "--macho-segment-name NODE_SEA" )

case "${TRIPLE}" in
  *apple-darwin*)
    # Ad-hoc re-sign so the binary runs locally; CI re-signs with the real
    # Developer ID via tauri-action's bundling/notarization step.
    codesign --sign - "${OUT}" || true
    ;;
esac

chmod +x "${OUT}" || true
echo ""
echo "==> Orchestrator sidecar built:"
echo "    -> ${OUT}"
