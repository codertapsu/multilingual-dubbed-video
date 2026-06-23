#!/usr/bin/env python3
"""Resolve the per-OS CI build matrix for .github/workflows/release.yml.

Every target OS can be built two ways: LOCALLY (scripts/package/*, see
docs/RELEASING.md) or in CI. These per-OS flags pick *CI* per OS; a manual
`workflow_dispatch` run forces all of them on. Disabled OSes are omitted from
the emitted matrix, so the `build` job provisions NO runner for them (the
10x-billed macOS minutes stay unspent).

Prints two GitHub Actions step outputs to stdout (append to $GITHUB_OUTPUT):
  matrix=<json {"include":[...]}>   - the build matrix
  any=<true|false>                  - whether anything is selected

Env:
  MANUAL      "true" when the run is a workflow_dispatch (build everything)
  CI_MACOS    repo var RELEASE_CI_MACOS    (default: off -> macOS built locally)
  CI_WINDOWS  repo var RELEASE_CI_WINDOWS  (default: off -> Windows built locally)
  CI_LINUX    repo var RELEASE_CI_LINUX    (default: off)
An unset/empty flag uses the default; "true" forces on, anything else forces off.
"""
import json
import os

# The build-matrix entries per OS (mirrors what release.yml's build job needs:
# os / label / rust-target / tauri-args).
OSES = {
    "macos": [
        {"os": "macos-14", "label": "macos-arm64", "rust-target": "aarch64-apple-darwin", "tauri-args": "--target aarch64-apple-darwin"},
        {"os": "macos-13", "label": "macos-x64", "rust-target": "x86_64-apple-darwin", "tauri-args": "--target x86_64-apple-darwin"},
    ],
    "windows": [
        {"os": "windows-latest", "label": "windows-x64", "rust-target": "x86_64-pc-windows-msvc", "tauri-args": ""},
    ],
    "linux": [
        {"os": "ubuntu-22.04", "label": "linux-x64", "rust-target": "x86_64-unknown-linux-gnu", "tauri-args": ""},
    ],
}

# Default when a repo variable is unset: every OS builds LOCALLY. CI is opt-in
# per OS (the safe, cost-free default — no surprise 10x macOS minutes). Set
# RELEASE_CI_<OS>=true to opt that OS into a CI build.
DEFAULTS = {"macos": False, "windows": False, "linux": False}


def enabled(key: str) -> bool:
    if os.environ.get("MANUAL", "").strip().lower() == "true":
        return True
    raw = os.environ.get("CI_" + key.upper(), "").strip().lower()
    return DEFAULTS[key] if raw == "" else raw == "true"


def main() -> None:
    include = []
    for key in ("macos", "windows", "linux"):
        if enabled(key):
            include.extend(OSES[key])
    print("matrix=" + json.dumps({"include": include}))
    print("any=" + ("true" if include else "false"))


if __name__ == "__main__":
    main()
