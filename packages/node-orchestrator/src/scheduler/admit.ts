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
 * Starvation: the first entry that cannot be admitted RESERVES its points, so
 * cheap cloud runs behind it may backfill the remainder but can never keep the
 * blocked head waiting forever. That is an invariant, not a timer — no clock,
 * no flaky tests.
 */
import type { QueueReason } from '@videodubber/shared';

/** One queued candidate, in queue order. */
export interface AdmissionCandidate {
  projectId: string;
  /** Admission cost (see classifyWorkload). */
  points: number;
  /** Needs the exclusive heavy-engine lane. */
  needsHeavyEngine: boolean;
}

/** A run already executing. */
export interface RunningRun {
  projectId: string;
  points: number;
  /** Holds the exclusive heavy-engine lane. */
  needsHeavyEngine: boolean;
}

/** Why an entry was held back, with the copy the UI shows. */
export interface HeldBack {
  reason: QueueReason;
  message: string;
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

  let usedPoints = running.reduce((sum, r) => sum + r.points, 0);
  let heavyHolder: string | undefined = running.find((r) => r.needsHeavyEngine)?.projectId;
  /** Points reserved for the first entry we could not admit (anti-starvation). */
  let reserved = 0;

  const nameFor = (projectId: string | undefined): string => {
    if (!projectId) return 'another dub';
    return ctx.nameOf?.(projectId) ?? 'another dub';
  };

  for (const c of candidates) {
    if (c.needsHeavyEngine && heavyHolder !== undefined) {
      const message = `Needs the machine to itself — waiting for “${nameFor(heavyHolder)}” to finish.`;
      held.set(c.projectId, { reason: 'heavy-busy', message });
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
