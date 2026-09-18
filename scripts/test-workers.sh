#!/usr/bin/env bash
#
# scripts/test-workers.sh — run the Python test suites that `pnpm -r test` cannot
# reach.
#
# WHY: pnpm-workspace.yaml deliberately excludes the Python workers ("The Python
# workers ... are NOT pnpm packages"), so the root `test` script never touches
# them, and .github/workflows/ has no pytest step at all. That left ~109 passing
# tests running nowhere automatically — while build-workers.{sh,ps1} will happily
# freeze and package a worker whose suite is red. They take under a second in
# total, so there is no reason for them to be optional.
#
# Usage:
#   bash scripts/test-workers.sh            # every suite that has a runnable venv
#   ONLY=stt-worker bash scripts/test-workers.sh
#   REQUIRE_ALL=1 bash scripts/test-workers.sh   # fail if a suite can't be run
#
# Exit code: non-zero if any suite fails (or, with REQUIRE_ALL=1, if any suite
# could not be run at all).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

# The three shipped workers, plus the two engine packs (which have suites but
# often no venv on a fresh checkout — they are downloaded, not built).
SUITES=(
  "workers/stt-worker"
  "workers/translation-worker"
  "workers/tts-worker"
  "workers/tts-engine-neural"
  "workers/tts-engine-omnivoice"
)

ONLY="${ONLY:-}"
failed=()
skipped=()
ran=0

for rel in "${SUITES[@]}"; do
  dir="${REPO_ROOT}/${rel}"
  name="$(basename "${rel}")"
  if [[ -n "${ONLY}" && ",${ONLY}," != *",${name},"* ]]; then continue; fi
  if [[ ! -d "${dir}/tests" ]]; then continue; fi

  # Prefer the suite's own venv; fall back to any pytest on PATH.
  py=""
  for cand in "${dir}/.venv/bin/python" "${dir}/.venv/bin/python3" "${dir}/.venv/Scripts/python.exe"; do
    [[ -x "${cand}" ]] && { py="${cand}"; break; }
  done
  if [[ -z "${py}" ]] && command -v python3 >/dev/null 2>&1; then py="$(command -v python3)"; fi
  if [[ -z "${py}" ]] || ! "${py}" -c "import pytest" >/dev/null 2>&1; then
    skipped+=("${rel} (no venv with pytest — run scripts/setup-local-models.sh)")
    continue
  fi

  echo "==> pytest ${rel}"
  if ( cd "${dir}" && "${py}" -m pytest -q ); then
    ran=$((ran + 1))
  else
    failed+=("${rel}")
  fi
done

echo ""
if [[ ${#skipped[@]} -gt 0 ]]; then
  echo "skipped:"
  printf '  - %s\n' "${skipped[@]}"
fi
if [[ ${#failed[@]} -gt 0 ]]; then
  echo "FAILED suites:" >&2
  printf '  - %s\n' "${failed[@]}" >&2
  exit 1
fi
if [[ "${REQUIRE_ALL:-0}" == "1" && ${#skipped[@]} -gt 0 ]]; then
  echo "ERROR: REQUIRE_ALL=1 and ${#skipped[@]} suite(s) could not be run (see above)." >&2
  exit 1
fi
echo "OK — ${ran} Python suite(s) passed."
