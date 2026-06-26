# Engine packs — hosting & pinning the download URLs

Engine packs are the optional, downloaded-on-demand engines that capable
machines can add from **Settings → Engines** (accelerated whisper.cpp, local-LLM
translation, neural TTS, vocal separation, forced alignment). The base app never
needs them — they're purely additive. This doc is for **maintainers**: where the
URLs live, what you must host yourself, and how to pin checksums.

> TL;DR — edit one file: **`packages/node-orchestrator/src/engines/enginePackCatalog.ts`**.
> The `llama-cpp-*` packs already point at real upstream binaries. The macOS
> `whisper-cpp-metal` binary has no upstream build, so you build it once and host
> it on your own GitHub Release. The Python packs need no URLs at all.

---

## 1. Where the URLs live

All download URLs are in the `ENGINE_PACKS` array in
[`enginePackCatalog.ts`](../packages/node-orchestrator/src/engines/enginePackCatalog.ts).
At the top of that file are the only knobs you normally touch:

```ts
const LLAMA_CPP   = 'b9592';     // ggml-org/llama.cpp release tag
const WHISPER_CPP = 'v1.8.6';    // ggml-org/whisper.cpp release tag
const SELF_HOSTED_BASE = 'https://github.com/codertapsu/multilingual-dubbed-video/releases/download/engine-packs-v1';
```

Each pack lists one or more `artifacts`, each with a `url`, an optional `sha256`,
and `archive: true` (extract the archive into the pack dir). To change a pack:
bump the version constant, or edit the artifact `url`/`sha256` directly.

`SELF_HOSTED_BASE` can also be overridden at runtime with the
`VIDEODUBBER_ENGINE_BASE` environment variable (handy for testing a mirror).

---

## 2. What's upstream vs. what you must host

| Pack | Platform | Source | Action needed |
|---|---|---|---|
| `llama-cpp-metal` | macOS arm64 | **upstream** ggml-org/llama.cpp | none — works today |
| `llama-cpp-cuda` | Windows x64 | **upstream** (binary + cudart) | none |
| `llama-cpp-vulkan` | Windows x64 | **upstream** | none |
| `llama-cpp-linux` | Linux x64 | **upstream** | none |
| `whisper-cpp-cuda` | Windows x64 | **upstream** ggml-org/whisper.cpp (cuBLAS) | none |
| `whisper-cpp-metal` | macOS arm64 | **self-host** (no upstream build) | **build + upload + set codertapsu/multilingual-dubbed-video** |
| `tts-neural` | all | PyPI via bundled `uv` | none (no URL) |
| `tts-omnivoice` | **macOS arm64** | PyPI (`mlx-audio`) via bundled `uv` | none (no URL) |
| `separation-audio` | all | PyPI via bundled `uv` | none |
| `alignment-whisperx` | all | PyPI via bundled `uv` | none |

So out of the box, **everything works except the macOS Metal whisper.cpp pack**,
which needs a one-time build because ggml-org only ships whisper.cpp binaries for
Windows. (On macOS the bundled faster-whisper still does STT on CPU; this pack is
the optional Metal speed-up.)

---

## 3. Self-hosting the macOS Metal whisper.cpp binary

You need a `whisper-server` built with Metal, packaged as
`whisper-cpp-v1.8.6-macos-arm64.tar.gz`, hosted at `SELF_HOSTED_BASE`.

### 3a. Build it (on an Apple Silicon Mac)

Follow the upstream build docs: <https://github.com/ggml-org/whisper.cpp> →
"Quick start" / `cmake`. Metal is on by default on macOS.

```bash
git clone --depth 1 --branch v1.8.6 https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DGGML_METAL=ON -DWHISPER_BUILD_SERVER=ON
cmake --build build --config Release -j

# Collect the runtime files the app spawns + Metal needs at runtime.
mkdir -p dist
cp build/bin/whisper-server dist/
cp build/bin/*.metal dist/ 2>/dev/null || true   # ggml-metal shader, if emitted
cp build/ggml/src/ggml-metal/*.metallib dist/ 2>/dev/null || true

# Package with the exact filename the catalog expects.
tar -C dist -czf whisper-cpp-v1.8.6-macos-arm64.tar.gz .
shasum -a 256 whisper-cpp-v1.8.6-macos-arm64.tar.gz   # copy this hash
```

> The EngineManager finds the server by recursively looking for a file named
> `whisper-server` inside the pack dir, so the internal layout is flexible — just
> make sure `whisper-server` and any `.metal`/`.metallib` it needs are in there.

### 3b. Upload it to a GitHub Release

Follow GitHub's docs:
<https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository>.
Create a release on **your** repo (e.g. tag `engine-packs-v1`) and attach the
`.tar.gz` as a release asset, or with the `gh` CLI:

```bash
gh release create engine-packs-v1 --title "Engine packs v1" --notes "whisper.cpp Metal server"
gh release upload engine-packs-v1 whisper-cpp-v1.8.6-macos-arm64.tar.gz
```

The asset's public URL is then:
`https://github.com/codertapsu/multilingual-dubbed-video/releases/download/engine-packs-v1/whisper-cpp-v1.8.6-macos-arm64.tar.gz`

### 3c. Point the catalog at it

In `enginePackCatalog.ts`, set `codertapsu/multilingual-dubbed-video` (and the tag, if you changed it):

```ts
const SELF_HOSTED_BASE = 'https://github.com/codertapsu/multilingual-dubbed-video/releases/download/engine-packs-v1';
```

…and paste the hash from 3a into the `whisper-cpp-metal` artifact's `sha256`.

> **Linux Metal/Vulkan whisper.cpp** is also not published upstream. If you want
> a Linux whisper.cpp pack, build it the same way (`-DGGML_VULKAN=ON`), upload
> `whisper-cpp-v1.8.6-linux-x64.tar.gz`, and add a pack entry mirroring
> `whisper-cpp-cuda` with `platforms: ['linux']` and the self-hosted URL.

---

## 4. Pinning checksums (recommended)

The installer downloads and then **runs** these binaries, so verify them:

- When an artifact's `sha256` is set, the installer aborts on a mismatch and
  discards the download.
- When it's empty, the installer still installs but logs
  `No checksum pinned for <id>; installed unverified`.

Compute a hash with `shasum -a 256 <file>` (macOS/Linux) or
`Get-FileHash <file> -Algorithm SHA256` (PowerShell) and paste it into the
artifact's `sha256`. For upstream ggml-org assets, download the asset once,
hash it, and pin it (GitHub release assets are immutable per tag).

---

## 5. The Python packs need no URLs

`tts-neural`, `separation-audio`, and `alignment-whisperx` use `uv-env://…`
markers, not downloads. The bundled **`uv`** builds a self-contained Python
environment from a locked, per-platform requirement set (in
[`uvRequirements.ts`](../packages/node-orchestrator/src/engines/uvRequirements.ts))
and `uv` fetches its own CPython — so there is nothing to host. To change what
these install, edit the requirement sets there. The model weights (voices,
separation/alignment checkpoints) download from their hubs on first use, like the
Whisper models. `tts-neural` is VieNeu‑TTS v3‑Turbo via the `vieneu` PyPI package
(torch‑free ONNX); end‑user setup is in
[`VIENEU_TTS_SETUP.md`](VIENEU_TTS_SETUP.md). uv docs: <https://docs.astral.sh/uv/>.

---

## 6. Verify a pack end to end

```bash
# Run the orchestrator (dev) or use the installed app, then:
curl -s localhost:5100/engines | python3 -m json.tool            # available + installed
curl -s localhost:5100/engines/prerequisites | python3 -m json.tool  # uv / ollama status
curl -s -XPOST localhost:5100/engines/install -d '{"packId":"llama-cpp-metal"}' \
  -H content-type:application/json
# watch progress:
curl -s localhost:5100/engines/events
```

Then open **Settings → Engines** — an installed pack flips to "installed", and a
project that selects its provider (e.g. translation = `llama-cpp`) will start the
engine on demand.

---

## 7. Upstream references

- llama.cpp releases (prebuilt binaries): <https://github.com/ggml-org/llama.cpp/releases>
- whisper.cpp (build + Windows binaries): <https://github.com/ggml-org/whisper.cpp>
- GitHub Releases (hosting assets): <https://docs.github.com/en/repositories/releasing-projects-on-github>
- uv (Python env manager): <https://docs.astral.sh/uv/>
- Engine selection rationale + per-tier matrix: [`TECH_STACK_RESEARCH.md`](TECH_STACK_RESEARCH.md)
- Provider/engine architecture: [`PROVIDERS.md`](PROVIDERS.md#engine-packs)
