# Simultaneous dubs: capacity, the heavy lane, and the queue

Dubbing is not a background task. A single run drives ffmpeg (x264 render),
faster-whisper, and possibly a local LLM — each of which saturates every core it
is given. Running N projects at once does not finish them N× sooner; it makes
all of them slower and the machine unusable. Worse, some local engines *evict
each other*, so uncontrolled concurrency was a correctness bug, not just a
performance one.

## The two rules

### 1. Slots — how many dubs at once (hardware-derived)

`packages/node-orchestrator/src/system/capacity.ts` (pure, unit-tested):

```
cpuSlots    = floor((cpuCores - 2) / 3)            # 2 cores reserved for OS+app
ramSlots    = floor((totalRamGb - 4) / perRunGb)   # perRunGb = 4 on Apple Silicon, else 3
maxProjects = clamp(min(cpuSlots, ramSlots), 1, 4) # hard cap 4
budgetPoints = maxProjects * 2
```

| Machine | cpuSlots | ramSlots | Limit |
|---|---|---|---|
| 4 cores / 8 GB | 0 | 1 | **1** |
| 8 cores / 16 GB | 2 | 4 | **2** |
| 10-core M-series / 32 GB | 2 | 7 | **2** |
| 16 cores / 64 GB | 4 | 20 | **4** |
| 32 cores / 128 GB | 10 | 41 | **4** (hard-capped) |

The **hard cap of 4** exists because the bundled Python workers (STT :5101, MT
:5102, TTS :5103) are single shared processes — past 4 they serialize the work
anyway, so more parallelism adds contention without throughput.

A run costs **2 points** if it does any local work, **1** if every phase is a
cloud API (network-bound, barely touches this machine until render). So a
2-slot machine runs 2 local dubs, or 4 cloud-only ones.

**Deliberately NOT inputs** (do not "fix" these later):
- `freeRamMb` — `getSystemProfile()` re-reads `os.freemem()` per call, so a
  limit derived from it would visibly change between two visits to Settings;
  macOS also understates it.
- GPUs — a GPU accelerates one run's engine; it does not make a second
  concurrent render cheap.

### 2. The heavy lane — always exactly one, on every machine

`EngineManager.ensureRunning(..., { exclusive: true })` calls
`unloadHeavyExcept()`: starting a heavy engine **stops the other heavy
engines** to free RAM/VRAM. That is right for one run (its phases are
sequential) and catastrophic across concurrent work — the second run would stop
the engine the first is mid-request against.

So a run that needs a heavy engine takes an exclusive lane, and
`heavyLanes` is **always 1**, is not derived from hardware, and **cannot be
raised by any user setting**. Heavy families (from `ENGINE_LAUNCH_SPECS`):
`local-llm`, `whisper-cpp`, `libretranslate`, `omnivoice`, `audio-separator`,
`whisperx`. Note VieNeu (`neural-tts`) is *not* heavy, so the common
faster-whisper + Argos + VieNeu project still runs N-up.

`scheduler/workload.ts` classifies a run from its settings alone (provider
`requiresEnginePack` families + `originalAudioMode: 'replace-vocals'` +
`forcedAlignment`/`diarize`), reading the same table the launcher uses so the
two can never drift.

### Enforcement is at the chokepoint, not by convention

A scheduler that only governs *runs* would be decorative: the editor's
per-segment TTS and "tighten to fit" call heavy providers directly. So
ownership is enforced inside `ensureRunning` itself, with the owner carried
implicitly through `AsyncLocalStorage` (`engines/engineOwner.ts`) — no provider
signature changed. Work belonging to another owner gets **`ENGINE_BUSY`**
instead of silently stealing the engine. **This fixed a live bug that existed
with a single project**: regenerating a segment in the editor while a dub ran
could kill that dub's engine.

## The queue

`decideAdmissions()` (`scheduler/admit.ts`, pure) returns both what to start
*and the reason* for everything it held back — the UI renders only those
reasons, so it is structurally impossible for the screen to say "waiting for a
free slot" when the truth was "that engine is busy".

- Order: FIFO by `project.queue.queuedAt`, persisted on `project.json` (already
  written atomically) — no second source of truth to reconcile. "Start this one
  next" rewrites `queuedAt` rather than storing a position.
- **Anti-starvation**: the first entry that cannot be admitted *reserves* its
  points, so cheap cloud runs behind it can backfill but can never keep it
  waiting forever. An invariant, not a timer.
- Readiness is checked **twice**: at enqueue (so the user gets the actionable
  error while standing there) and again at dispatch (a failing project is
  marked failed and the queue moves on — it never stalls on one bad entry).
- Settings are frozen while queued (the workload classification was made at
  enqueue; letting it change would make ordering decisions silently wrong).
- Cancel on a queued project just removes it and restores its previous status.
- **On restart** (`reconcileQueue()`): `queued` projects re-enter in order; a
  project left `running` by a crash is demoted to `paused`, deliberately NOT
  auto-resumed — see "Known gap" below.

## API

| Endpoint | Purpose |
|---|---|
| `GET /system` | now includes `capacity` (the recommendation + reasons) |
| `GET /queue` | running + queued entries, limit, points, paused |
| `POST /projects/:id/run` | returns `{ started, queued, position? }` |
| `POST /projects/:id/run-next` | move a queued project to the head |
| `GET/PUT /preferences` | `concurrency: { mode: 'auto' \| 'manual', maxProjects?, paused? }` |

The preference stores the **intent** (`auto`), not a computed number, so a RAM
upgrade or an improved heuristic raises the limit instead of stranding the user
on a stale 2. A manual pin is clamped to 1..8.

## UI

Progressive disclosure — invisible until it costs the user something:
- **Wizard/Processing**: starting a second dub navigates to Processing as
  usual, which shows a waiting panel with the position, the reason, "Start this
  one next", and "Remove from queue".
- **Home**: a "Now dubbing" / "Up next" summary appears only when something is
  running or queued, with "N of M slots in use — change limit" linking to
  Settings (the only discovery path for the limit, met at the moment it
  matters).
- **Settings → This computer**: "Dubbing at the same time" (Recommended / 1–8),
  "Pause the queue", and a "Why this limit?" expander generated from the same
  `capacity.reasons` the scheduler used.

## Known gap / follow-ups

- **Auto-resume after a crash is deliberately NOT enabled.** The runner's
  artifact writes are plain `fsp.writeFile` while resumability only tests
  `outputsExist()`, so a crash mid-write leaves a truncated artifact that a
  resume would treat as complete. Make those writes atomic (reuse
  `writeJsonAtomic`'s tmp+rename from `projectStore.ts`) *before* switching
  `reconcileQueue()` to auto-resume with a crash-loop guard.
- The heavy lane is held for the whole run; a heavy project's x264 render tail
  blocks the next heavy project. Moving the claim into `PipelineRunner` (first
  heavy step → last) is a contained follow-up; the
  `acquire/release` shape already supports it.
- `GET /queue` is polled (3–4 s) rather than pushed; a global SSE channel
  modelled on `setup/setupBus.ts` is the follow-up if more app-level state
  appears.
- No ETA is shown. Deliberate: inventing a time before there is per-machine
  history is worse than an honest ordinal ("#2 in the queue").
