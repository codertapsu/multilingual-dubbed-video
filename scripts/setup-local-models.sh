#!/usr/bin/env bash
#
# scripts/setup-local-models.sh — One-time local/offline setup for VideoDubber.
#
# Usage:
#   ./scripts/setup-local-models.sh                 # full setup (venvs + models)
#   SKIP_VENVS=1     ./scripts/setup-local-models.sh # don't (re)create venvs or pip install
#   SKIP_MODELS=1    ./scripts/setup-local-models.sh # don't download/cache any models
#   SKIP_WHISPER=1   ./scripts/setup-local-models.sh # skip faster-whisper model pre-cache
#   SKIP_ARGOS=1     ./scripts/setup-local-models.sh # skip Argos language package install
#   SKIP_PIPER=1     ./scripts/setup-local-models.sh # skip Piper voice download
#
# Tunables (env):
#   PYTHON_PATH               python interpreter to build venvs with (default: python3)
#   FASTER_WHISPER_MODEL      whisper model to pre-cache (default: small)
#   ARGOS_FROM / ARGOS_TO     language pair to install (default: en -> vi)
#   PIPER_VOICE               Piper voice id to download (default: vi_VN-vais1000-medium)
#   MODELS_DIR                where Piper voices land (default: ~/VideoDubber/models/piper)
#
# This script:
#   1. Creates a .venv per worker and pip installs its requirements.txt.
#   2. Pre-caches a faster-whisper model so the first run is fast/offline.
#   3. Installs an Argos Translate language package (e.g. en -> vi).
#   4. Downloads a Piper voice (.onnx + .json) and prints PIPER_* env values.
#
# Network/destructive steps are clearly logged and individually skippable.
# It NEVER fails hard if you're offline — it prints manual instructions instead.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
cd "${ROOT_DIR}"

PYTHON_BIN="${PYTHON_PATH:-python3}"
FASTER_WHISPER_MODEL="${FASTER_WHISPER_MODEL:-small}"
ARGOS_FROM="${ARGOS_FROM:-en}"
ARGOS_TO="${ARGOS_TO:-vi}"
PIPER_VOICE="${PIPER_VOICE:-vi_VN-vais1000-medium}"
MODELS_DIR="${MODELS_DIR:-${HOME}/VideoDubber/models/piper}"

c_reset="\033[0m"; c_red="\033[31m"; c_grn="\033[32m"; c_yel="\033[33m"; c_blu="\033[34m"; c_bold="\033[1m"
info()  { printf "${c_blu}[setup]${c_reset} %s\n" "$*"; }
ok()    { printf "${c_grn}[setup]${c_reset} %s\n" "$*"; }
warn()  { printf "${c_yel}[setup][warn]${c_reset} %s\n" "$*" >&2; }
err()   { printf "${c_red}[setup][error]${c_reset} %s\n" "$*" >&2; }
step()  { printf "\n${c_bold}==> %s${c_reset}\n" "$*"; }

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  err "Python ('${PYTHON_BIN}') not found. Install Python 3.10+ or set PYTHON_PATH."
  err "See docs/LOCAL_SETUP.md. Aborting — venvs cannot be created without python."
  exit 1
fi
ok "Using python: $(command -v "${PYTHON_BIN}") ($("${PYTHON_BIN}" --version 2>&1))"

WORKERS=("stt-worker" "translation-worker" "tts-worker")

# ----------------------------------------------------------------------------
# 1. Create venvs and install requirements per worker.
# ----------------------------------------------------------------------------
create_venv() {
  local dir="$1"
  local wdir="${ROOT_DIR}/workers/${dir}"
  local venv="${wdir}/.venv"

  if [[ ! -d "${wdir}" ]]; then
    warn "${dir}: worker directory missing (${wdir}); skipping venv."
    return
  fi

  if [[ -d "${venv}" ]]; then
    info "${dir}: .venv already exists — reusing it."
  else
    info "${dir}: creating .venv (this writes to ${venv})"
    if ! "${PYTHON_BIN}" -m venv "${venv}"; then
      warn "${dir}: failed to create venv. Skipping. (Is the 'venv' module available?)"
      return
    fi
  fi

  local vpy="${venv}/bin/python"
  if [[ ! -x "${vpy}" ]]; then
    warn "${dir}: venv python not found at ${vpy}; skipping pip install."
    return
  fi

  info "${dir}: upgrading pip (network)"
  "${vpy}" -m pip install --upgrade pip >/dev/null 2>&1 \
    || warn "${dir}: pip upgrade failed (offline?). Continuing."

  if [[ -f "${wdir}/requirements.txt" ]]; then
    info "${dir}: pip install -r requirements.txt (network)"
    if "${vpy}" -m pip install -r "${wdir}/requirements.txt"; then
      ok "${dir}: dependencies installed."
    else
      warn "${dir}: pip install failed (offline / missing build tools?)."
      warn "${dir}: install manually later with:"
      warn "    ${vpy} -m pip install -r ${wdir}/requirements.txt"
    fi
  else
    warn "${dir}: no requirements.txt found at ${wdir}/requirements.txt; skipping deps."
  fi
}

if [[ "${SKIP_VENVS:-0}" != "1" ]]; then
  step "Step 1/4: Python virtual environments + dependencies"
  for w in "${WORKERS[@]}"; do
    create_venv "${w}"
  done
else
  warn "SKIP_VENVS=1 — skipping venv creation and pip installs."
fi

# Resolve venv python for a given worker (used by model steps below).
worker_py() {
  local dir="$1"
  local vpy="${ROOT_DIR}/workers/${dir}/.venv/bin/python"
  if [[ -x "${vpy}" ]]; then echo "${vpy}"; else echo "${PYTHON_BIN}"; fi
}

# ----------------------------------------------------------------------------
# 2. Pre-cache a faster-whisper model.
# ----------------------------------------------------------------------------
if [[ "${SKIP_MODELS:-0}" != "1" && "${SKIP_WHISPER:-0}" != "1" ]]; then
  step "Step 2/4: Pre-cache faster-whisper model '${FASTER_WHISPER_MODEL}' (network)"
  STT_PY="$(worker_py stt-worker)"
  info "Downloading model into the faster-whisper / HuggingFace cache..."
  # WhisperModel(...) downloads and caches the model on first construction.
  if "${STT_PY}" - "${FASTER_WHISPER_MODEL}" <<'PYEOF'
import sys
model = sys.argv[1]
try:
    from faster_whisper import WhisperModel
    # int8 on CPU mirrors what the STT worker uses at runtime.
    WhisperModel(model, device="cpu", compute_type="int8")
    print(f"[setup] faster-whisper model '{model}' cached successfully.")
except ModuleNotFoundError:
    print("[setup][warn] faster-whisper not installed in this venv.")
    print("[setup][warn] Install deps first (re-run without SKIP_VENVS), then retry.")
    sys.exit(0)
except Exception as exc:  # network / disk errors — never fail the whole setup
    print(f"[setup][warn] Could not pre-cache model (offline?): {exc}")
    print("[setup][warn] It will be downloaded on first transcription instead.")
    sys.exit(0)
PYEOF
  then
    ok "faster-whisper step done. (Set FASTER_WHISPER_MODEL to change the model: tiny|base|small|medium|large-v3)"
  else
    warn "faster-whisper pre-cache step encountered an issue; the model will download on first use."
  fi
else
  warn "Skipping faster-whisper model pre-cache."
fi

# ----------------------------------------------------------------------------
# 3. Install an Argos Translate language package (e.g. en -> vi).
# ----------------------------------------------------------------------------
if [[ "${SKIP_MODELS:-0}" != "1" && "${SKIP_ARGOS:-0}" != "1" ]]; then
  step "Step 3/4: Install Argos Translate package ${ARGOS_FROM} -> ${ARGOS_TO} (network)"
  TR_PY="$(worker_py translation-worker)"
  if "${TR_PY}" - "${ARGOS_FROM}" "${ARGOS_TO}" <<'PYEOF'
import sys
from_code, to_code = sys.argv[1], sys.argv[2]
try:
    import argostranslate.package as pkg
    import argostranslate.translate as translate
except ModuleNotFoundError:
    print("[setup][warn] argostranslate not installed in this venv.")
    print("[setup][warn] Install deps first (re-run without SKIP_VENVS), then retry.")
    print("[setup][warn] Manual alternative (CLI): argospm install translate-%s_%s" % (from_code, to_code))
    sys.exit(0)

# Already installed?
installed = translate.get_installed_languages()
have = any(
    l.code == from_code and any(t.to_lang.code == to_code for t in l.translations_from)
    for l in installed
)
if have:
    print(f"[setup] Argos package {from_code} -> {to_code} already installed.")
    sys.exit(0)

try:
    print("[setup] Updating Argos package index...")
    pkg.update_package_index()
    available = pkg.get_available_packages()
    match = next(
        (p for p in available if p.from_code == from_code and p.to_code == to_code),
        None,
    )
    if match is None:
        print(f"[setup][warn] No Argos package published for {from_code} -> {to_code}.")
        print("[setup][warn] Browse available pairs at https://www.argosopentech.com/argospm/index/")
        sys.exit(0)
    print(f"[setup] Downloading and installing {from_code} -> {to_code}...")
    path = match.download()
    pkg.install_from_path(path)
    print(f"[setup] Installed Argos package {from_code} -> {to_code}.")
except Exception as exc:  # offline / index errors — never fail the whole setup
    print(f"[setup][warn] Could not install Argos package (offline?): {exc}")
    print(f"[setup][warn] Manual: argospm install translate-{from_code}_{to_code}")
    print("[setup][warn] Or in Python:")
    print("[setup][warn]   import argostranslate.package as p; p.update_package_index();")
    print("[setup][warn]   pkg=next(x for x in p.get_available_packages()")
    print(f"[setup][warn]        if x.from_code=='{from_code}' and x.to_code=='{to_code}');")
    print("[setup][warn]   p.install_from_path(pkg.download())")
    sys.exit(0)
PYEOF
  then
    ok "Argos step done. (Set ARGOS_FROM / ARGOS_TO to install other pairs.)"
  else
    warn "Argos package install encountered an issue. See manual instructions above."
  fi
else
  warn "Skipping Argos language package install."
fi

# ----------------------------------------------------------------------------
# 4. Download a Piper voice (.onnx + .json).
# ----------------------------------------------------------------------------
if [[ "${SKIP_MODELS:-0}" != "1" && "${SKIP_PIPER:-0}" != "1" ]]; then
  step "Step 4/4: Download Piper voice '${PIPER_VOICE}' (network)"
  mkdir -p "${MODELS_DIR}"

  # Piper voices are hosted on HuggingFace under rhasspy/piper-voices.
  # Layout: <lang>/<locale>/<dataset>/<quality>/<voice>.onnx(.json)
  # e.g. vi_VN-vais1000-medium ->
  #   vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx
  parse_voice() {
    # echoes "<lang> <locale> <dataset> <quality>"
    local voice="$1"
    local locale="${voice%%-*}"          # vi_VN
    local rest="${voice#*-}"             # vais1000-medium
    local dataset="${rest%%-*}"          # vais1000
    local quality="${rest#*-}"           # medium
    local lang="${locale%%_*}"           # vi
    echo "${lang} ${locale} ${dataset} ${quality}"
  }

  read -r V_LANG V_LOCALE V_DATASET V_QUALITY <<<"$(parse_voice "${PIPER_VOICE}")"
  BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/${V_LANG}/${V_LOCALE}/${V_DATASET}/${V_QUALITY}"
  ONNX_URL="${BASE_URL}/${PIPER_VOICE}.onnx"
  JSON_URL="${BASE_URL}/${PIPER_VOICE}.onnx.json"
  ONNX_OUT="${MODELS_DIR}/${PIPER_VOICE}.onnx"
  JSON_OUT="${MODELS_DIR}/${PIPER_VOICE}.onnx.json"

  download() {
    local url="$1" out="$2"
    if [[ -f "${out}" && -s "${out}" ]]; then
      info "Already present: ${out}"
      return 0
    fi
    if command -v curl >/dev/null 2>&1; then
      curl -fL --retry 2 -o "${out}" "${url}"
    elif command -v wget >/dev/null 2>&1; then
      wget -O "${out}" "${url}"
    else
      warn "Neither curl nor wget is available; cannot download ${url}."
      return 1
    fi
  }

  PIPER_OK=1
  if ! download "${ONNX_URL}" "${ONNX_OUT}"; then PIPER_OK=0; fi
  if ! download "${JSON_URL}" "${JSON_OUT}"; then PIPER_OK=0; fi

  if [[ "${PIPER_OK}" -eq 1 && -s "${ONNX_OUT}" && -s "${JSON_OUT}" ]]; then
    ok "Piper voice downloaded to ${MODELS_DIR}"
    echo
    info "To use this voice, set these env vars (add to your shell profile or .env):"
    printf "  ${c_bold}export PIPER_VOICE_MODEL_PATH=%q${c_reset}\n" "${ONNX_OUT}"
    info "And point PIPER_BINARY_PATH at your piper executable, e.g.:"
    printf "  ${c_bold}export PIPER_BINARY_PATH=/path/to/piper${c_reset}\n"
    info "Download the Piper binary from: https://github.com/rhasspy/piper/releases"
    info "(If PIPER_BINARY_PATH is unset, the TTS worker falls back to system TTS or a silent/sine dev WAV.)"
  else
    warn "Could not download the Piper voice (offline / wrong voice id?)."
    warn "Manual steps:"
    warn "  1. Browse voices:    https://huggingface.co/rhasspy/piper-voices"
    warn "  2. Download '${PIPER_VOICE}.onnx' and '${PIPER_VOICE}.onnx.json' into:"
    warn "       ${MODELS_DIR}"
    warn "  3. export PIPER_VOICE_MODEL_PATH=${ONNX_OUT}"
    warn "  4. Download the piper binary: https://github.com/rhasspy/piper/releases"
    warn "  5. export PIPER_BINARY_PATH=/path/to/piper"
    rm -f "${ONNX_OUT}.part" "${JSON_OUT}.part" 2>/dev/null || true
  fi
else
  warn "Skipping Piper voice download."
fi

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
step "Setup complete"
ok "Next steps:"
echo "  - Verify your environment:   pnpm verify   (or: tsx scripts/verify-environment.ts)"
echo "  - Start the dev stack:       ./scripts/dev.sh"
echo "  - Troubleshooting / details: docs/LOCAL_SETUP.md and docs/MODEL_SETUP.md"
