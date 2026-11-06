# Native technology strategy

> Written 2026-11-05, when the studio editor landed. The question it answers:
> *should VideoDubber move to native stacks per OS — Swift/SwiftUI on macOS,
> C++/WinUI on Windows — even as two separate apps?* Every number below was
> measured in this repository on an M4 Pro (8 performance + 4 efficiency cores,
> 24 GB) unless stated otherwise. Re-measure before relying on it for a
> different decision.

## Short answer

**Keep one product — Tauri 2 + the Angular UI on the system webview — and go
native per OS exactly where native pays: in the engines, in OS integration, and
(if a measured gate below is ever hit) in specific media components.** A full
rewrite into two native apps would roughly double the cost of every future
feature while leaving the slow part of the product — the ML pipeline — exactly
as fast as it is today, because that part already runs in native code.

## Where the time actually goes

| Stage | What runs it | Native? | Measured |
|---|---|---|---|
| Speech-to-text | faster-whisper → **CTranslate2 (C++)**, int8 | yes | large-v3-turbo: 42 s of speech in 7.0 s (RTF 0.17) on 8 P-cores |
| Translation | Argos → **CTranslate2 (C++)**; LLM tiers → **llama.cpp (C++, Metal / CUDA / Vulkan)** | yes | 270M model: 219 tok/s on Metal |
| Text-to-speech | Piper → **ONNX Runtime (C++)** | yes | 67 ms per line with the voice kept loaded |
| Fit / mix / render | **ffmpeg (C)**, VideoToolbox / NVENC encode | yes | 42 s render in 0.6 s (stream copy) |
| Orchestration | Node (TypeScript) | no | milliseconds per step; a 2,000-line timeline edit round-trips in 28 ms |
| UI | Angular in WKWebView (macOS) / WebView2 (Windows) | renders natively | 2 h / 2,000-line timeline: 60 fps scroll + playback, first render 0.3–0.5 s |

Every heavy stage is already C/C++ with GPU acceleration where the hardware has
it. The Python and Node layers are glue measured in milliseconds. **Rewriting the
UI in Swift or C++ changes none of the numbers in the right-hand column.**

The two biggest speed-ups found while writing this were both about using
the hardware properly, not about the language:

- STT ran on a flat **4 threads** on every machine (CTranslate2's default).
  Using the performance cores made large-v3-turbo **31% faster**; using *all*
  cores (P + E) made it **67% slower**, because OpenMP barriers wait for the
  efficiency cores. Now encoded per OS in `workers/stt-worker/app/cpu.py`
  (Apple `hw.perflevel0`, Windows `EfficiencyClass`, Linux sysfs + affinity).
- TTS spawned **one Piper process per line**, paying ~0.7 s of start-up and
  model load each time (4.0 lines/s). A persistent process per voice does
  16.3 lines/s; *more* processes are slower (ONNX Runtime already uses every
  core). Through the real worker: **2.3× faster** dubbing synthesis.

## Options considered

### A. Two native apps (SwiftUI + AVFoundation; WinUI 3 + Media Foundation)

- **For:** best platform feel; AVFoundation / AVAudioEngine and Media
  Foundation / XAudio2 give sample-accurate, pitch-preserving preview natively;
  Metal / Direct2D for custom timeline drawing; first-class accessibility and
  OS services.
- **Against:** two UI codebases for every screen — onboarding, settings,
  wizard, downloader, help, the studio — and both locales, kept in lock-step
  forever; feature drift between platforms; double QA; for a one-maintainer
  project, roughly half the feature velocity. It also does nothing for the
  pipeline (above), which is what users wait on.
- **Verdict:** not justified today. Revisit only through the gates below.

### B. One native cross-platform toolkit (Qt/QML, Flutter, Avalonia, Slint, Compose)

- One codebase compiled to native widgets or a GPU canvas. Qt in particular has
  excellent media and timeline capabilities.
- Still a full UI rewrite, plus new licensing (Qt: LGPL obligations or a
  commercial license), larger bundles, and a smaller pool of contributors than
  web tech. Gains over the system webview for *this* UI are marginal — see the
  frame times above.

### C. Electron

- Ships its own Chromium (~150 MB per platform) for the same web UI. Strictly
  worse than Tauri here.

### D. Tauri 2 + system webview + per-OS native modules — **chosen**

- The webview IS the OS's engine: WebKit on macOS (media decode through
  AVFoundation / VideoToolbox), Chromium in WebView2 on Windows (Media
  Foundation / DXVA). The Rust shell calls OS APIs directly — no bridge layer
  to maintain — and Tauri's plugin model allows per-OS native code (Swift or
  Objective-C via `objc2` on macOS, `windows-rs` / C++ on Windows) without
  forking the app.

## What "native where it pays" means in this change

| Area | macOS | Windows |
|---|---|---|
| Don't idle-sleep during a dub (`src-tauri/src/activity.rs`) | IOKit `PreventUserIdleSystemSleep` assertion | `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` on a dedicated thread |
| Progress outside the window | Dock tile progress | Taskbar button progress |
| Thread topology for CPU inference | P-cluster (`hw.perflevel0.physicalcpu`) | P-cores via `GetLogicalProcessorInformationEx` `EfficiencyClass` |
| Preview media | byte-range streaming (WKWebView refuses media without it) | same server; Chromium seeks without re-downloading |
| LLM runtime | llama.cpp v0.9.0 Metal build | llama.cpp v0.9.0 CUDA 12.4 / Vulkan builds; whisper.cpp v1.9.5 CUDA |

## Gates that would justify going further

These are measurable, not matters of taste. If one is hit, do the cheapest fix
in its row first.

1. **A source codec the webview cannot preview** (e.g. HEVC on Windows without
   the Store extension, ProRes RAW). First: a hardware-encoded H.264 *proxy*
   (ffmpeg, VideoToolbox / NVENC) used only for the preview — what every
   professional NLE does. Only then: a native video surface (AVPlayerLayer /
   MediaPlayerElement) composited under a transparent webview through a Tauri
   plugin.
2. **Timeline below 60 fps** on a real project (currently 60 fps at 2,000 lines
   over 2 hours). First: draw cues and clips on one canvas / WebGL layer, as the
   waveform and filmstrip already are. Native rendering after that.
3. **Preview needs live pitch-preserving speed changes** (today sped-up clips
   are pre-fitted server-side with the exact atempo chain the final mix uses).
   First: an AudioWorklet WSOLA. Then: AVAudioEngine / XAudio2 via a plugin.
4. **macOS speech-to-text speed.** CTranslate2 has no Metal backend, so macOS
   STT is CPU-only. **This is the largest native win still on the table:** a
   whisper.cpp build with Metal + a Core ML encoder (Apple Neural Engine). It
   needs a macOS binary built and hosted by the project (upstream publishes
   none), a signed artifact, and the existing `whisper-cpp` provider enabled on
   darwin — recommended as the next native project.
5. **Windows GPU TTS.** ONNX Runtime's DirectML execution provider could move
   Piper/VieNeu onto any DirectX 12 GPU; measure CPU-vs-GPU first, since
   persistent Piper already runs at ~15 lines/s.

## Recommendation, in order

1. Keep the single Tauri + Angular product (this change).
2. Build the macOS whisper.cpp Metal / Core ML pack (gate 4).
3. Add a preview proxy only if gate 1 shows up in real projects.
4. Re-run this evaluation if the maintainer team grows enough to own two UI
   codebases, or if any gate cannot be met within the webview.
