/**
 * The admission rule: which queued runs may start right now.
 *
 * PURE + unit-tested, and — importantly — it returns the REASON for every
 * entry it did not admit. The UI renders only those reasons, so it is
 * structurally impossible for the screen to say "waiting for a free slot" when
 * the truth was "that engine is busy".
 *
 * Three rules, in order:
 *  1. Paused — the user stopped the queue; nothing starts.
 *  2. Heavy lane — a run needing an exclusive local engine waits until no other
 *     running job holds the lane. This is a CORRECTNESS rule (those engines
 *     unload each other), so it is checked before, and independently of, the
 *     points budget and can never be overridden.
 *  3. Points budget — local runs cost 2, cloud-only runs 1, against
 *     `maxProjects * 2`.
 *
 * The light lane: a run that only mixes and renders (ffmpeg, no engine) is
 * admitted on a small slot count of its own, outside the points budget and
 * any reservation, so it never waits behind a GPU dub's turn. A render after
 * edits on a finished part sat ~2 h at the back of the queue during a series
 * (field report B5, 2026-11-21).
 *
 * Starvation: the first entry that cannot be admitted RESERVES its points, so
 * cheap cloud runs behind it may backfill the remainder but can never keep the
 * blocked head waiting forever. That is an invariant, not a timer — no clock,
 * no flaky tests.
 */
import type { QueueReason } from '@videodubber/shared';
import { HOLD_OWNER_PREFIX, holderName } from './gpuHolds.js';

/** One queued candidate, in queue order. */
export interface AdmissionCandidate {
  projectId: string;
  /** Admission cost (see classifyWorkload). */
  points: number;
  /** Needs the exclusive heavy-engine lane. */
  needsHeavyEngine: boolean;
  /** Only mixes and renders: admitted on the light lane (RunWorkload.lightOnly). */
  lightOnly?: boolean;
}

/** A run already executing. */
export interface RunningRun {
  projectId: string;
  points: number;
  /** Holds the exclusive heavy-engine lane. */
  needsHeavyEngine: boolean;
  /** Admitted on the light lane: counts against its slots, not the points budget. */
  lightOnly?: boolean;
}

/** Light-lane runs (mix and render only) that may run at once, besides the budget. */
export const LIGHT_LANE_SLOTS = 1;

/** Why an entry was held back, with the copy the UI shows. */
export interface HeldBack {
  reason: QueueReason;
  message: string;
  /** For `gpu-hold`: the app holding the graphics card ("Voice Mask"). */
  heldBy?: string;
}

/** Result of one admission pass. */
export interface AdmissionDecision {
  /** Project ids to start now, in queue order. */
  start: string[];
  /** Reason per project id that stays queued. */
  held: Map<string, HeldBack>;
}

/** Inputs that are not per-entry. */
export interface AdmissionContext {
  budgetPoints: number;
  paused: boolean;
  /** Resolve a project id to a display name for the messages. */
  nameOf?: (projectId: string) => string | undefined;
  /**
   * The heavy-engine lane is held by something that is NOT a pipeline run —
   * an editor action ("editor:<projectId>"), or another app's hold on the
   * graphics card ("hold:<holder>", scheduler/gpuHolds.ts). Without this the
   * scheduler would dispatch a heavy run straight into an ENGINE_BUSY failure
   * instead of waiting for the lane.
   */
  externalHeavyOwner?: string;
  /** Light-lane slots (default {@link LIGHT_LANE_SLOTS}). */
  lightSlots?: number;
  /**
   * The computer is under pressure now (diagnostics/health.ts: under 15 %
   * free memory, or the app stalling): a render then waits for the full dub
   * running beside it. A render beside part 16's dub took the 8 % of memory
   * TranslateGemma 27B needed, which slowed to 0.4-0.8 tokens/s and failed
   * (claude-dubber, 2026-11-24).
   */
  pressure?: boolean;
}

/**
 * Decide which candidates start. `candidates` MUST be in queue order (oldest
 * `queuedAt` first); `running` is the current live set.
 */
export function decideAdmissions(
  candidates: readonly AdmissionCandidate[],
  running: readonly RunningRun[],
  ctx: AdmissionContext,
): AdmissionDecision {
  const start: string[] = [];
  const held = new Map<string, HeldBack>();

  if (ctx.paused) {
    for (const c of candidates) {
      held.set(c.projectId, {
        reason: 'paused',
        message: 'The queue is paused — resume it in Settings to start this dub.',
      });
    }
    return { start, held };
  }

  let usedPoints = running.filter((r) => !r.lightOnly).reduce((sum, r) => sum + r.points, 0);
  let lightRunning = running.filter((r) => r.lightOnly).length;
  let heavyHolder: string | undefined =
    running.find((r) => r.needsHeavyEngine)?.projectId ?? ctx.externalHeavyOwner;
  /** Points reserved for the first entry we could not admit (anti-starvation). */
  let reserved = 0;

  const nameFor = (projectId: string | undefined): string => {
    if (!projectId) return 'another dub';
    // An editor action holds the lane under "editor:<projectId>".
    if (projectId.startsWith('editor:')) {
      const name = ctx.nameOf?.(projectId.slice('editor:'.length));
      return name ? `an edit in ${name}` : 'an edit in the editor';
    }
    if (projectId.startsWith('preview:')) return 'a voice preview';
    if (projectId === 'anonymous') return 'other work outside a dub';
    return ctx.nameOf?.(projectId) ?? 'another dub';
  };

  for (const c of candidates) {
    // Mix and render only: its own lane, never behind the budget's reservation.
    if (c.lightOnly && !c.needsHeavyEngine) {
      if (ctx.pressure === true && running.some((r) => !r.lightOnly)) {
        held.set(c.projectId, {
          reason: 'pressure',
          message: 'Waiting: the computer is short of memory while a dub runs. The render starts when that dub finishes.',
        });
      } else if (lightRunning < (ctx.lightSlots ?? LIGHT_LANE_SLOTS)) {
        start.push(c.projectId);
        lightRunning += 1;
      } else {
        held.set(c.projectId, {
          reason: 'no-slot',
          message: 'Waiting for the render before it to finish.',
        });
      }
      continue;
    }
    if (c.needsHeavyEngine && heavyHolder !== undefined) {
      if (heavyHolder.startsWith(HOLD_OWNER_PREFIX)) {
        // Another app holds the card (scheduler/gpuHolds.ts): Voice Mask's live session.
        const app = holderName(heavyHolder.slice(HOLD_OWNER_PREFIX.length));
        held.set(c.projectId, { reason: 'gpu-hold', message: `Waiting: ${app} is using the graphics card.`, heldBy: app });
      } else {
        const holder = nameFor(heavyHolder);
        const message = holder.startsWith('an edit')
          ? `Needs the machine to itself — waiting for ${holder} to finish.`
          : `Needs the machine to itself — waiting for “${holder}” to finish.`;
        held.set(c.projectId, { reason: 'heavy-busy', message });
      }
      // A blocked heavy run reserves its points too: otherwise a stream of
      // cloud runs could consume the budget it will need the moment the lane
      // frees.
      if (reserved === 0) reserved = c.points;
      continue;
    }
    if (usedPoints + c.points > ctx.budgetPoints - reserved) {
      held.set(c.projectId, {
        reason: 'no-slot',
        message: 'Waiting for a free slot — starts when a running dub finishes.',
      });
      if (reserved === 0) reserved = c.points;
      continue;
    }

    start.push(c.projectId);
    usedPoints += c.points;
    if (c.needsHeavyEngine) heavyHolder = c.projectId;
  }

  return { start, held };
}
