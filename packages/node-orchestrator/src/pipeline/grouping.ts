/**
 * Synthesis grouping: merge consecutive subtitle cues into one TTS utterance.
 *
 * Whisper cues are TIMING units, not prosodic units — a sentence often spans
 * two or three cues, and every independent TTS call samples a fresh intonation
 * trajectory (VITS models literally re-draw prosody noise per call). Synthesizing
 * cue-by-cue therefore produces the "subtitle robot" effect: a sentence-final
 * pitch fall at every cue boundary and uncorrelated pace/energy between lines.
 *
 * The fix (validated by multi-sentence TTS research, arXiv 2206.14643): merge
 * consecutive same-speaker cues separated by less than a beat of silence into
 * one utterance, synthesize it in a single TTS call, and place the whole clip at
 * the group's start. Intonation then only resets at real pauses/speaker changes.
 *
 * A group's id is its FIRST member's segment id, so the synthesized WAV lands on
 * that member's canonical `segment_XXXX.wav` path and every downstream consumer
 * (alignment probing, timeline placement, the editor) keeps working unchanged.
 * Non-first members simply have no WAV of their own while grouped; editing one
 * in the editor degroups it (see orchestrator.synthesizeSingleSegment).
 *
 * This module is PURE (no I/O) so it is trivially unit-testable.
 */

/** Minimal per-segment input the planner needs. */
export interface GroupableSegmentInput {
  id: string;
  startMs: number;
  endMs: number;
  /** Text that will be synthesized (translated text, falling back upstream). */
  text: string;
  /** Diarization speaker id, when present. Segments never group across speakers. */
  speakerId?: string;
}

/** One planned synthesis utterance covering one or more consecutive segments. */
export interface SynthesisGroup {
  /** Group id == FIRST member's segment id (drives the output WAV path). */
  id: string;
  /** Member segment ids, in order. */
  segmentIds: string[];
  /** The joined text synthesized as one utterance. */
  text: string;
  /** Placement start = first member's startMs. */
  startMs: number;
  /** Window end = last member's endMs. */
  endMs: number;
  /** Diarization speaker (all members share it — groups never span speakers). */
  speakerId?: string;
}

/** Tunables for {@link planSynthesisGroups}. */
export interface GroupingOptions {
  /** Merge only when the silence between cues is below this (default 750 ms). */
  maxGapMs?: number;
  /** Max cues per utterance (default 4). */
  maxSegments?: number;
  /** Max joined-text length per utterance (default 320 chars). */
  maxChars?: number;
  /** Max total window (first start -> last end) per utterance (default 20 s). */
  maxWindowMs?: number;
  /** Master switch: false = one group per segment (legacy behavior). */
  enabled?: boolean;
}

const DEFAULTS: Required<Omit<GroupingOptions, 'enabled'>> = {
  maxGapMs: 750,
  maxSegments: 4,
  // <= 240: VieNeu v3's SDK chunks text above ~256 chars and samples each chunk
  // independently — the voice could change mid-utterance. Staying under keeps
  // every group a single continuous generation on all engines.
  maxChars: 240,
  // Long windows accumulate voice-vs-subtitle drift (the group is read as one
  // continuous utterance from the group start, so a translation whose pace
  // deviates from the original cue spacing desyncs mid-group). 12s bounds the
  // worst case; the post-synthesis drift check (runner) handles the rest.
  maxWindowMs: 12_000,
};

/** Env-overridable default (VD_TTS_GROUP_GAP_MS etc.) with a sane fallback. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve effective options (explicit > env > defaults). Exported for tests. */
export function resolveGroupingOptions(opts?: GroupingOptions): Required<Omit<GroupingOptions, 'enabled'>> {
  return {
    maxGapMs: opts?.maxGapMs ?? envInt('VD_TTS_GROUP_GAP_MS', DEFAULTS.maxGapMs),
    maxSegments: opts?.maxSegments ?? envInt('VD_TTS_GROUP_MAX_SEGMENTS', DEFAULTS.maxSegments),
    maxChars: opts?.maxChars ?? envInt('VD_TTS_GROUP_MAX_CHARS', DEFAULTS.maxChars),
    maxWindowMs: opts?.maxWindowMs ?? envInt('VD_TTS_GROUP_MAX_WINDOW_MS', DEFAULTS.maxWindowMs),
  };
}

/**
 * Plan synthesis groups over consecutive segments. Pure.
 *
 * Two adjacent segments join the same group only when ALL hold:
 *   - grouping is enabled,
 *   - both have non-empty text (empty/silent cues stay singletons),
 *   - same speakerId (or both unset),
 *   - the gap between them is 0..maxGapMs (overlapping cues do NOT merge:
 *     overlap usually means cross-talk, which one voice can't render),
 *   - the joined text stays within maxChars,
 *   - the merged window stays within maxWindowMs,
 *   - the group stays within maxSegments.
 */
export function planSynthesisGroups(
  segments: readonly GroupableSegmentInput[],
  opts?: GroupingOptions,
): SynthesisGroup[] {
  const enabled = opts?.enabled !== false;
  const o = resolveGroupingOptions(opts);
  const groups: SynthesisGroup[] = [];
  /** The previous segment appended (tail of the last group), for gap/speaker checks. */
  let prev: GroupableSegmentInput | undefined;

  for (const seg of segments) {
    const text = seg.text.trim();
    const last = groups[groups.length - 1];

    const canJoin =
      enabled &&
      last !== undefined &&
      prev !== undefined &&
      text.length > 0 &&
      last.text.length > 0 &&
      // Speaker continuity: never merge across (known) speaker changes.
      prev.speakerId === seg.speakerId &&
      // Gap in [0, maxGapMs]; a negative gap (overlap) breaks the group.
      seg.startMs - prev.endMs >= 0 &&
      seg.startMs - prev.endMs <= o.maxGapMs &&
      last.segmentIds.length < o.maxSegments &&
      last.text.length + 1 + text.length <= o.maxChars &&
      seg.endMs - last.startMs <= o.maxWindowMs;

    if (canJoin && last) {
      last.segmentIds.push(seg.id);
      // Space-join: whisper splits sentences across cues WITHOUT punctuation, so
      // a plain space lets the TTS engine read the group as one flowing sentence
      // (adding punctuation here would reintroduce the very pause we're removing).
      last.text = `${last.text} ${text}`;
      last.endMs = seg.endMs;
    } else {
      groups.push({
        id: seg.id,
        segmentIds: [seg.id],
        text,
        startMs: seg.startMs,
        endMs: seg.endMs,
        ...(seg.speakerId ? { speakerId: seg.speakerId } : {}),
      });
    }
    prev = seg;
  }

  return groups;
}

/** A subtitle cue retimed to when the dub voice actually speaks it. */
export interface RetimedCue {
  id: string;
  startMs: number;
  endMs: number;
}

/** Preferred minimum on-screen duration for a retimed cue (yielded when the
 * next cue leaves less room — no cue is ever extended INTO its neighbour). */
const MIN_RETIMED_CUE_MS = 400;

/**
 * Re-time subtitle cues inside multi-cue groups to the dub voice.
 *
 * A group is spoken as one continuous utterance from its placement start, so
 * member k's words occupy the proportional span of the placed clip (same
 * token/char weights as {@link estimateGroupDriftMs}). The original cue times
 * follow the SOURCE speech instead; re-timing the SUBTITLE sidecars to the
 * voice makes each line appear exactly when it is spoken.
 *
 * Multi-cue members get their proportional voice START; every cue's END is then
 * clamped in a single timeline-ordered pass so NO cue overlaps the next — this
 * closes both overlap gaps: (a) the intra-group minimum-duration clamp used to
 * push a short cue's end past the following member's start, and (b) a group's
 * last cue used to overrun the next group's first cue when alignment accepted
 * overflow (placedDuration > gap-aware slot). Cues stay contiguous and strictly
 * start-ordered (required by SRT/VTT). Pure; the returned map holds EVERY cue
 * whose timing changed (a neighbour clamped down to avoid an overlap is
 * included, not just the members that moved).
 */
export function retimeCuesToVoice(
  groups: readonly SynthesisGroup[],
  placedById: ReadonlyMap<string, { startMs: number; placedDurationMs: number }>,
  members: readonly { id: string; startMs: number; endMs: number; text: string }[],
): Map<string, RetimedCue> {
  const byId = new Map(members.map((m) => [m.id, m]));

  // 1. Desired voice-proportional START for each multi-cue member.
  const retimedStart = new Map<string, number>();
  for (const g of groups) {
    if (g.segmentIds.length < 2) continue;
    const placed = placedById.get(g.id);
    if (!placed || placed.placedDurationMs <= 0) continue;
    const weights = g.segmentIds.map((id) => {
      const text = (byId.get(id)?.text ?? '').trim();
      const tokens = text.split(/\s+/).filter((t) => t.length > 0).length;
      return Math.max(1, tokens > 1 ? tokens : text.length);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let before = 0;
    for (const [k, id] of g.segmentIds.entries()) {
      if (byId.has(id)) {
        retimedStart.set(id, Math.round(placed.startMs + (before / total) * placed.placedDurationMs));
      }
      before += weights[k]!;
    }
  }
  if (retimedStart.size === 0) return new Map();

  // 2. Full timeline: retimed members take their voice start, others keep
  //    canonical. Sort by start (SRT/VTT require start-ordered cues).
  const ordered = members
    .map((m) => ({ id: m.id, startMs: retimedStart.get(m.id) ?? m.startMs, endMs: m.endMs }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  // 3. Forward pass: keep starts non-decreasing, and clamp each end so it never
  //    reaches the next cue's start (contiguous, non-overlapping).
  for (let i = 0; i < ordered.length; i++) {
    const cur = ordered[i]!;
    if (i > 0) cur.startMs = Math.max(cur.startMs, ordered[i - 1]!.startMs);
    const nextStart = i + 1 < ordered.length ? ordered[i + 1]!.startMs : Number.POSITIVE_INFINITY;
    // Aim for the canonical/target end or a readable minimum, but never spill
    // into the next cue.
    const desiredEnd = Math.max(cur.endMs, cur.startMs + MIN_RETIMED_CUE_MS);
    cur.endMs = Math.max(cur.startMs, Math.min(desiredEnd, nextStart));
  }

  // 4. Emit every cue whose timing actually changed.
  const out = new Map<string, RetimedCue>();
  for (const c of ordered) {
    const m = byId.get(c.id)!;
    if (m.startMs !== c.startMs || m.endMs !== c.endMs) {
      out.set(c.id, { id: c.id, startMs: c.startMs, endMs: c.endMs });
    }
  }
  return out;
}

/** Persisted shape of the synthesis-groups artifact (audio/synthesis_groups.json). */
export interface SynthesisGroupsArtifact {
  groups: SynthesisGroup[];
}

/** The settings subset {@link voiceForGroup} reads. */
export interface VoiceSettings {
  ttsVoiceId?: string;
  speakerVoices?: { speakerId: string; voiceId: string }[];
}

/**
 * Resolve the TTS voice for a synthesis unit: a diarized speaker with an
 * assigned voice (settings.speakerVoices) speaks with it; everything else uses
 * the project-wide voice. Pure.
 */
export function voiceForGroup(group: SynthesisGroup, settings: VoiceSettings): string | undefined {
  if (group.speakerId) {
    const assigned = settings.speakerVoices?.find((v) => v.speakerId === group.speakerId)?.voiceId;
    if (assigned) return assigned;
  }
  return settings.ttsVoiceId;
}

/** Default worst tolerated voice-vs-subtitle drift inside a group (ms). */
export const DEFAULT_MAX_GROUP_DRIFT_MS = 700;

/** Env-overridable drift cap (VD_TTS_GROUP_MAX_DRIFT_MS). */
export function maxGroupDriftMs(): number {
  return envInt('VD_TTS_GROUP_MAX_DRIFT_MS', DEFAULT_MAX_GROUP_DRIFT_MS);
}

/**
 * Estimate the worst voice-vs-subtitle drift (ms) inside a multi-cue group.
 *
 * The group is spoken as ONE continuous utterance placed at `group.startMs`,
 * so member k's words start at roughly (text before k / total text) into the
 * clip — while its subtitle appears at the member's original `startMs`. The
 * mismatch grows when the translated pace deviates from the original cue
 * spacing (a 5s Chinese cue rendered as 2s of Vietnamese pulls every later
 * member's words several seconds ahead of its subtitle).
 *
 * `placedDurationMs` is the clip's duration as it will sit on the timeline
 * (measured natural duration, capped by the slot when alignment will compress
 * it). Member weight = whitespace token count (≈ syllables in Vietnamese),
 * char count as fallback for unsegmented scripts. Pure; returns 0 for
 * singletons.
 */
export function estimateGroupDriftMs(
  group: SynthesisGroup,
  members: readonly { id: string; startMs: number; text: string }[],
  placedDurationMs: number,
): number {
  if (group.segmentIds.length < 2 || placedDurationMs <= 0) return 0;
  const byId = new Map(members.map((m) => [m.id, m]));
  const weights = group.segmentIds.map((id) => {
    const text = (byId.get(id)?.text ?? '').trim();
    const tokens = text.split(/\s+/).filter((t) => t.length > 0).length;
    return Math.max(1, tokens > 1 ? tokens : text.length);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let worst = 0;
  let before = 0;
  for (const [k, id] of group.segmentIds.entries()) {
    const member = byId.get(id);
    if (member) {
      const estVoiceStartMs = group.startMs + (before / total) * placedDurationMs;
      worst = Math.max(worst, Math.abs(estVoiceStartMs - member.startMs));
    }
    before += weights[k]!;
  }
  return Math.round(worst);
}

/** Turn segments into one-singleton-per-segment groups (legacy / fallback shape). */
export function singletonGroups(segments: readonly GroupableSegmentInput[]): SynthesisGroup[] {
  return planSynthesisGroups(segments, { enabled: false });
}
