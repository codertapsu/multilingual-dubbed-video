# NOTICE

VideoDubber is licensed under the MIT License (see [`LICENSE`](./LICENSE)).

## Reference material

The project [`jianchang512/stt`](https://github.com/jianchang512/stt) — which is
distributed under the **GPL-3.0** license — was studied as a **reference only**
while designing VideoDubber's local speech-to-text and dubbing pipeline.

**No GPL-licensed source code from that project (or any other GPL project) was
copied, adapted, or otherwise incorporated into VideoDubber.** All code in this
repository is original work written for VideoDubber, or uses third-party
dependencies under their own permissive licenses (e.g. faster-whisper, Argos
Translate, Piper, FFmpeg as an external binary invoked via subprocess).

Because VideoDubber contains no GPL code, the MIT license applies to the entire
VideoDubber codebase. External tools such as FFmpeg are invoked as separate
processes and are not linked into or redistributed as part of this project; they
remain under their respective upstream licenses.

## Third-party components (invoked, not bundled)

- **FFmpeg / ffprobe** — invoked as external binaries; not redistributed here.
- **faster-whisper** — speech-to-text models/runtime (see upstream license).
- **Argos Translate** — offline translation (see upstream license).
- **Piper** — neural text-to-speech (see upstream license).

If you redistribute VideoDubber together with any of the above, review and
comply with each component's own license terms.
