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

### Taking turns on the card (Settings → Performance, `concurrency.shareGpu`, on by default)

The lane stays single: one heavy engine is loaded at a time. What changes is
who waits where. On 2026-11-27, six dubs waited 2.5 h in the queue while a
series' analysis detected speakers on the processor and the card sat idle
(`docs/plans/gpu-sharing-2026-11-28.md`).

- **Dubs wait for the card inside their runs.** The orchestrator tells the
  engine manager which owners wait (`setLaneWaiting`: its runs). A dub that
  finds the lane busy queues in `EngineManager.waitForLane` instead of getting
  `ENGINE_BUSY` and running the step on the CPU build of the same model. A
  27B model on the CPU is many times slower. The step shows "Waiting for the
  graphics card: “Tập 7” is using it" (`step-detail.gpu-wait-*`). A pause
  (the run's signal, passed to `withEngineOwner`) takes it out of the line,
  starts nothing else, and writes no engine off. Editor actions and previews
  are still refused, and fall back, as before.
- **The order.** The dub that started first goes first. That is the
  queue's order, so a series' parts go in their order. Owners without a rank
  go by when they began to wait. A waiter whose pack and model are still
  loaded may go ahead, so no 27B model is unloaded and loaded again between
  two dubs at the same step. It may pass the same waiter at most
  `MAX_LANE_SKIPS` (2) times. All waiters of the granted owner go together.
  A lane whose holder is gone is looked for every 5 s while anyone waits.
- **Admission.** With sharing on, heavy runs are admitted side by side
  (`decideAdmissions` `shareGpu`), at most `SHARED_GPU_RUNS` (2) of them,
  within the points budget. One uses the card while the other does its
  processor work; a third would mostly wait for the card. Its processor work
  would also slow the one on the card: TranslateGemma 27B runs part of its
  layers on the processor on an 8 GB card. The budget allowed four on the PC
  that dubs the series. A third waits as `gpu-turns`. A run that has handed
  the card on for good no longer counts. Another app's hold keeps new heavy
  runs queued, and a second one waits as `pressure` while the computer is
  short of memory.
- **Lending.** The runner tells the orchestrator where a run stops using the
  card (`RunnerDeps.gpuBreak`, `GpuBreak`): before every step, and inside
  speech-to-text once the transcript and the checks that decode it again are
  done. `Orchestrator.gpuBreak` decides:
  - When no later step of the run uses the card, it hands the card on for
    good. `needsHeavyEngine` drops, the lane is released and the queue is
    pumped. This happens with sharing on or off: a series' analysis lets go
    before speaker detection, and a dub lets go before the mix.
  - With sharing on, it lends the lane for a step that does not use the card,
    and for speaker detection. It keeps the lane into a step that uses the
    card: consecutive GPU steps swap no model out and back in. It never lends
    for a few seconds of checks.
  - The run takes its turn again at its next GPU step.
- `heavySteps` (`scheduler/workload.ts`) is what "uses the card" means. It
  counts refine whenever the context engine is heavy: its retry pass for
  failing lines uses the chat model.
- **The out-of-memory retry keeps its turn.** `ensureRunningFirstUsable` lets
  go of a lane it took only once a pack has failed for good. Released by the
  failed first try, the lane went to the dub waiting behind.
- Off, one heavy dub runs at a time as before, and a dub still hands the card
  on once no step left uses it.

### Another app's hold on the graphics card

Voice Mask (a separate app: live voice changing, translated speech, captions)
keeps its models on the card during a live session, on a PC that dubs for days.
It asks VideoDubber to leave the card alone with a **hold**
(`scheduler/gpuHolds.ts`):

- While a hold is live, no **new** heavy-lane work starts: a queued dub that
  needs the lane waits with the reason `gpu-hold` ("Waiting: Voice Mask is using
  the graphics card"), and an editor action or a voice preview that would take
  a free lane gets `ENGINE_BUSY`, so it uses the next installed runtime (usually
  the CPU build) exactly as when a dub holds the card.
- A hold never kills, pauses or slows what already runs: a dub admitted on the
  lane before the hold keeps the lane for all its steps (the engine manager's
  lane gate lets an admitted heavy run through). Taking turns on the card,
  "on the lane" means: it has used the card in this run (`hasHeldLane`). A
  dub admitted beside others that has not used the card yet is new GPU work,
  and waits in its run until the hold ends ("Waiting for the graphics card:
  Voice Mask is using it"). A hold coming or going looks again at the waiters
  (`retryLane`).
- Holds live in memory only. The holder renews every 10 s within a TTL of
  5–120 s (30 by default); one not renewed expires by itself and the queue is
  looked at again, so a crashed holder blocks dubbing for one TTL at most. A
  restart drops every hold.
- `GET /queue` lists them (`holds`); `laneOwner` keeps meaning the project (or
  editor action, preview) holding the lane in the engine manager.

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
- Cancel (or Pause) on a queued project just removes it and restores its previous status.
- Pausing a running dub frees its slot at once; the next queued dub starts. While the
  app is closing, no queued dub starts in its place: they all wait for the next start.
- **On restart** (`reconcileQueue()`): `queued` projects re-enter in order; a
  project left `running` by a crash is demoted to `paused`, deliberately NOT
  auto-resumed — see "Known gap" below.

## API

| Endpoint | Purpose |
|---|---|
| `GET /system` | now includes `capacity` (the recommendation + reasons) |
| `GET /queue` | running + queued entries (a `gpu-hold` entry carries `heldBy`), limit, points, paused, `laneOwner`, `holds: [{ holdId, holder, name, lanes, reason, createdAt, expiresAt }]` |
| `POST /projects/:id/run` | returns `{ started, queued, position? }` |
| `POST /projects/:id/run-next` | move a queued project to the head |
| `POST /scheduler/holds` | `{ holder, lanes: ["gpu"], reason, ttlSec }` → 201 `{ holdId, expiresAt, ttlSec }`; holder `[a-z0-9-]{1,40}`, ttl clamped to 5–120 s, reason ≤ 200 characters (logged only); 400 on a bad body, 429 past 4 live holds |
| `PUT /scheduler/holds/:id` | renew → 200 `{ holdId, expiresAt }`; 404 when unknown or expired (take a new one) |
| `DELETE /scheduler/holds/:id` | release → 204, also when already gone |
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

## Hardening (from the adversarial review of 4a3f5a3)

A 39-agent review confirmed 25 findings against the first cut. The substantive
ones, and what changed:

| Defect | Fix |
|---|---|
| **`pump()` could loop forever and permanently wedge the queue** — an admitted candidate that was skipped (already running / no longer queued) stayed in `queue[]`, so the pass repeated identically while `pumping` stayed `true`, silently disabling every future dispatch | the skip path now `forget()`s the entry, and loop termination is driven by **progress** (`pumpOnce()` returns whether it dispatched) instead of `queue.length` |
| **Boot reconcile could mark every queued project `failed`** — `reconcileQueue()` runs milliseconds after launch, while the bundled Python workers are still binding their ports, so the dispatch-time readiness check failed them all | a **transient** failure (`worker-loading`) keeps the project queued and schedules a short retry; only a real problem fails it |
| **`retryStep` had no `queued` guard** — retrying a queued project double-enqueued it and poisoned `previousStatus` to `'queued'`, so cancelling could never restore a real status | it now `dequeue()`s a stale entry before re-scheduling |
| **`scheduleRun` awaited between the guard and registration** — two concurrent `/run` calls could start the same project twice | re-checks `running`/`queued` after the awaits, and persists the queue entry **before** registering it in memory |
| **A fresh run could jump the queue** — admission was decided against a single-candidate list, bypassing FIFO and the head reservation | a non-empty queue always wins: the request is enqueued and the pump dispatches in order |
| **`pumpAgain` was dropped on both `break` paths** — raising the limit or un-pausing during a pass was silently lost | the loop re-runs whenever the pass progressed **or** a wakeup arrived |
| **The scheduler was blind to an editor-held lane** — it would dispatch a heavy dub straight into `ENGINE_BUSY` while "Regenerate"/"Tighten to fit" held the engine | `externalHeavyOwner` is passed into admission, and the queued reason names the edit |
| **The editor lane was not reference-counted** — two concurrent editor actions share one owner id, and the first to finish freed the lane under the second | claims are ref-counted; the **last** action out releases (and re-pumps) |
| **A failed engine start kept the lane** — one missing pack locked out every later heavy run | a start that never produced a usable engine hands the lane back |
| **`ensureRunning` had no in-flight dedup** — two same-owner concurrent calls spawned two servers and orphaned one | concurrent starts for a pack share one promise |
| **`classifyWorkload` ignored `retryFromStep`** — a retry-from-render occupied the heavy lane for engines it would never touch | classification is step-aware, and only claims the lane for separation/alignment when those engines are actually wired |
| **NaN/zero hardware readings propagated** through the capacity formula | non-finite specs collapse to the safe minimum (1) |
| **Tauri preference saves were broken** (pre-existing) — the invoke sent `preferences` but the Rust command's parameter is `prefs`, so *auto-update* and the new limit could not be saved in the packaged app | arg name corrected |

## Known gap / follow-ups

- **After a backend crash** that the shell restarted it for, the dubs it
  interrupted continue by themselves, in the order they started
  (`reconcileQueue({ resumeInterrupted })`, the user's call on 2026-11-21).
  That is sound because every artifact is written atomically
  (`writeAtomically`, `writeJsonAtomic`). After a plain quit they wait, paused,
  for Continue.
- **An app update over a busy queue** pauses the queue and every running dub in
  one step: the dubs go back to the head of the queue and go on once the app is
  back (`docs/AUTOUPDATE.md`, "With dubs running or waiting").
- Taking turns on the card is not yet measured on the RTX 3050 / i5-13400F
  PC. Still to measure: speaker detection chunk times beside a second dub's
  GPU work, the model loads it saves or adds, and RAM with two heavy dubs
  alive. Turn it off in Settings if a machine does worse with it.
- `GET /queue` is polled (3–4 s) rather than pushed; a global SSE channel
  modelled on `setup/setupBus.ts` is the follow-up if more app-level state
  appears.
- A running dub's time left comes from that run's own pace
  (`activity/dubRuns.ts` `etaOf`, `etaSec` on `GET /queue`). Queued dubs show
  their place in line ("#2 in the queue"), not a time: inventing one without
  this machine's history would be worse than the honest ordinal.
