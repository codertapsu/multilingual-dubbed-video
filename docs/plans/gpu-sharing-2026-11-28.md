# Sharing the graphics card between dubs: a proposal (2026-11-28)

Status: proposed, not built. The user asked for a design before anything changes.

## What happened

On 2026-11-27, six dubs waited about 2.5 hours as `heavy-busy` ("Needs the machine to itself —
waiting for 'Phong Thủy Thiên Sư' to finish"). Meanwhile that series' analysis ran speaker
detection on the CPU, 102 chunks of 10 minutes, and the graphics card sat idle (get_queue: "GPU
lane: free").

The cause is admission. `scheduler/admit.ts` holds every run that needs a heavy engine while any
other such run is running (`running.find((r) => r.needsHeavyEngine)`). It holds the run for the
whole run, whatever the running one is doing. `needsHeavyEngine` is decided once, at enqueue
(`scheduler/workload.ts`). The engine manager's own lane (`heavyOwner`) is finer: it is taken
when a heavy engine is acquired. But a run that is waiting to be admitted never gets that far.

## Phase 1: let go when no graphics-card work is left (small, low risk)

A run stops blocking others once it has no graphics-card work left.

- **Series parent.** Its only GPU work is transcription. After that come the speech checks,
  speaker detection (CPU, hours on a long video) and planning.
- **A dub.** After TTS (and after alignment's auto-fit, when that uses the chat model), only the
  mix and the render are left, both ffmpeg.

How:
1. The runner reports `gpuDone` for its run: at the end of its last heavy step, or inside STT
   once the transcription is done (before the checks and speaker detection), when no later
   step is heavy. `workload.heavySteps` already lists the heavy steps.
2. On that report, the orchestrator sets the run's admission flag `needsHeavyEngine` to false,
   frees the engine manager's lane if this run holds it, and pumps the queue.
3. The queue then shows the waiting dubs starting. The activity entry of the run that let go
   says so: "Graphics card handed on: the rest is speaker detection on the processor".

What it changes:
- The next dub's GPU steps (whisper.cpp CUDA, llama.cpp CUDA, the GPU voice) run alongside the
  CPU work of the first one.
- That CPU work slows somewhat. The GPU engines use a few CPU threads, and the performance cores
  are shared. To measure on the RTX 3050 / i5-13400F PC: speaker detection chunk times with and
  without a second dub's STT.
- RAM: a partly offloaded 27B model takes about 10 GB of RAM, and speaker detection 1–2 GB. The
  scheduler already refuses new runs under memory pressure (`pressure`).

Tests: admission with a running run whose flag dropped. Runner reports in the right place: a
series parent after transcription, a dub after TTS, and a dub after alignment when auto-fit
uses the chat model.

## Phase 2: share the card inside a run (bigger, later)

A run in a CPU phase in the middle of its work lends the card, and takes it back when it next
needs it. For example, a dub in speaker detection has translation and TTS still to come.

- Admission admits heavy runs as the CPU and RAM budget allows. The GPU lane becomes per step:
  a run reaching a GPU step waits inside the run, shown as "Waiting for the graphics card", and
  the queue orders the waiters.
- A run keeps the lane through consecutive GPU steps, so models are not swapped back and forth.
  It lends the lane only for a long CPU phase (speaker detection, subtitle reading).
- Each handover unloads one model and loads another (llama.cpp 27B: about 30–60 s), which is
  the cost to weigh against the idle time.
- Risks: fairness (a long dub starving a short one), the context engine's resident model, more
  runs alive at once (RAM), and harder progress estimates.

## Setting

Settings → Dubbing queue: **"Let another dub use the graphics card when this one no longer
needs it"**. It is on by default for Phase 1 (nothing is lost but idle time), with a one-line
explanation: the other dub's work on the card can make this one's processor work a little
slower. Phase 2 would be a second option, off by default until measured.

## Recommendation

Build Phase 1 in the next release. Measure it on the PC with a series analysis and a queue of
parts. Decide on Phase 2 from those numbers.
