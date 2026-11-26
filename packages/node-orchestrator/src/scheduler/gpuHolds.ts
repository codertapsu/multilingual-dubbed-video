/**
 * GPU holds: another app on this computer asks the scheduler to leave the
 * graphics card alone for a while (POST /scheduler/holds).
 *
 * Voice Mask (D:\development\projects\voice-mask) runs live sessions (a voice
 * changer, translated speech, live captions) that keep their models on the
 * card, on a PC that dubs for days at a time. Its plan of record (docs/PLAN.md
 * §7, §13, Appendix D) asked for this, and the user approved it (2026-11-25):
 *   - while a hold is live, no NEW heavy-lane work starts: queued dubs that
 *     need the lane wait ("Waiting: Voice Mask is using the graphics card"),
 *     and an editor action or a voice preview that would take a free lane is
 *     refused, so it uses the next installed runtime (usually the CPU build)
 *     as when a dub holds the card;
 *   - a hold never kills, pauses or slows what is already running: a dub
 *     admitted on the lane before the hold keeps the lane for all its steps;
 *   - holds live in memory only and expire: a holder renews every 10 s within
 *     a 5-120 s TTL, so a crashed holder blocks dubbing for one TTL at most,
 *     and a restart of VideoDubber drops every hold.
 * Pure apart from the clock and the expiry timer, both injectable.
 */
import { randomBytes } from 'node:crypto';

/** The lanes a hold can name: VideoDubber has one exclusive heavy-engine lane, the graphics card's. */
export const HOLD_LANES = ['gpu'] as const;
export type HoldLane = (typeof HOLD_LANES)[number];

export const HOLD_TTL_MIN_SEC = 5;
export const HOLD_TTL_MAX_SEC = 120;
/** Live holds at once, at most: a holder that leaks them gets 429, never an unbounded list. */
export const MAX_LIVE_HOLDS = 4;
export const HOLD_REASON_MAX = 200;
const HOLDER_RE = /^[a-z0-9-]{1,40}$/;

/** What a holder asks for (POST /scheduler/holds), checked. */
export interface HoldRequest {
  holder: string;
  lanes: HoldLane[];
  /** For the log only; the screens say who holds the card in their own words. */
  reason: string;
  ttlSec: number;
}

/** A live hold. */
export interface GpuHold extends HoldRequest {
  holdId: string;
  createdAt: string;
  expiresAt: string;
  expiresAtMs: number;
}

/** A hold as GET /queue shows it. */
export interface GpuHoldView {
  holdId: string;
  holder: string;
  /** The holder by the name the screens use ("Voice Mask"). */
  name: string;
  lanes: HoldLane[];
  reason: string;
  createdAt: string;
  expiresAt: string;
}

/** The apps that hold the card, by the name the screens use. Any other holder is named by its id. */
const HOLDER_NAMES: Readonly<Record<string, string>> = { 'voice-mask': 'Voice Mask' };

/** The name a holder goes by on the screens ("Voice Mask"). Pure. */
export function holderName(holder: string): string {
  return HOLDER_NAMES[holder] ?? holder;
}

/** The owner label admission uses for a hold (scheduler/admit.ts: externalHeavyOwner). */
export const HOLD_OWNER_PREFIX = 'hold:';

/** A hold request, checked: the request or why it is refused (400). Pure. */
export function parseHoldRequest(body: unknown): { ok: true; value: HoldRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'The body must be a JSON object.' };
  const b = body as Record<string, unknown>;
  if (typeof b['holder'] !== 'string' || !HOLDER_RE.test(b['holder'])) {
    return { ok: false, error: 'holder must be 1-40 characters of a-z, 0-9 and "-" (e.g. "voice-mask").' };
  }
  const lanes = b['lanes'];
  if (!Array.isArray(lanes) || lanes.length === 0 || !lanes.every((l) => (HOLD_LANES as readonly unknown[]).includes(l))) {
    return { ok: false, error: `lanes must be a non-empty list of: ${HOLD_LANES.join(', ')}.` };
  }
  const reason = b['reason'] === undefined ? '' : b['reason'];
  if (typeof reason !== 'string' || reason.length > HOLD_REASON_MAX) {
    return { ok: false, error: `reason must be text of at most ${HOLD_REASON_MAX} characters.` };
  }
  const ttl = b['ttlSec'] === undefined ? 30 : b['ttlSec'];
  if (typeof ttl !== 'number' || !Number.isFinite(ttl)) return { ok: false, error: 'ttlSec must be a number of seconds.' };
  return {
    ok: true,
    value: {
      holder: b['holder'],
      lanes: [...new Set(lanes as HoldLane[])],
      reason,
      ttlSec: Math.round(Math.min(HOLD_TTL_MAX_SEC, Math.max(HOLD_TTL_MIN_SEC, ttl))),
    },
  };
}

/** The view of a hold for GET /queue. Pure. */
export function holdView(h: GpuHold): GpuHoldView {
  return {
    holdId: h.holdId,
    holder: h.holder,
    name: holderName(h.holder),
    lanes: [...h.lanes],
    reason: h.reason,
    createdAt: h.createdAt,
    expiresAt: h.expiresAt,
  };
}

export interface GpuHoldsDeps {
  now?: () => number;
  /** Runs `fn` after `ms` (unref'd in production); returns a cancel. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** A hold came, went or expired: admission looks at the queue again. */
  onChange?: () => void;
  /** One line per hold taken, released or expired (the reason is logged here only). */
  log?: (message: string) => void;
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export class GpuHolds {
  private readonly holds = new Map<string, GpuHold>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private cancelTimer: (() => void) | undefined;
  private onChange: (() => void) | undefined;

  constructor(private readonly deps: GpuHoldsDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? defaultTimer;
    this.onChange = deps.onChange;
  }

  /** Who is told when a hold comes, goes or expires (the orchestrator, once it exists). */
  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  /** The live holds, oldest first (expired ones are dropped, and said, on the way). */
  live(): GpuHold[] {
    this.prune();
    return [...this.holds.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** The oldest live hold on `lane`, if any. */
  holding(lane: HoldLane): GpuHold | undefined {
    return this.live().find((h) => h.lanes.includes(lane));
  }

  /** A new hold, or 'full' past {@link MAX_LIVE_HOLDS}. */
  create(req: HoldRequest): GpuHold | 'full' {
    if (this.live().length >= MAX_LIVE_HOLDS) return 'full';
    const now = this.now();
    const expiresAtMs = now + req.ttlSec * 1000;
    const hold: GpuHold = {
      ...req,
      lanes: [...req.lanes],
      holdId: `hold_${randomBytes(6).toString('hex')}`,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
    };
    this.holds.set(hold.holdId, hold);
    this.deps.log?.(
      `${holderName(hold.holder)} holds the graphics card (${hold.holdId}, ${hold.ttlSec} s, renewed by its app)${hold.reason ? `: ${hold.reason}` : ''}. New dubs that need it wait.`,
    );
    this.changed();
    return hold;
  }

  /** Renew a live hold for another TTL; undefined when it is unknown or has expired. */
  renew(holdId: string): GpuHold | undefined {
    this.prune();
    const hold = this.holds.get(holdId);
    if (!hold) return undefined;
    hold.expiresAtMs = this.now() + hold.ttlSec * 1000;
    hold.expiresAt = new Date(hold.expiresAtMs).toISOString();
    this.arm();
    return hold;
  }

  /** Release a hold; false when it was already gone. */
  release(holdId: string): boolean {
    this.prune();
    const hold = this.holds.get(holdId);
    if (!hold) return false;
    this.holds.delete(holdId);
    this.deps.log?.(`${holderName(hold.holder)} released the graphics card (${holdId}).`);
    this.changed();
    return true;
  }

  private prune(): void {
    const now = this.now();
    let dropped = false;
    for (const [id, hold] of this.holds) {
      if (hold.expiresAtMs > now) continue;
      this.holds.delete(id);
      dropped = true;
      this.deps.log?.(`${holderName(hold.holder)}'s hold on the graphics card expired (${id}: not renewed in ${hold.ttlSec} s).`);
    }
    if (dropped) this.changed();
  }

  /** Tell the scheduler, and wake up at the next expiry so a lapsed hold frees the queue by itself. */
  private changed(): void {
    this.arm();
    this.onChange?.();
  }

  private arm(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    const next = Math.min(...[...this.holds.values()].map((h) => h.expiresAtMs));
    if (!Number.isFinite(next)) return;
    this.cancelTimer = this.setTimer(() => this.prune(), Math.max(0, next - this.now()) + 5);
  }
}
