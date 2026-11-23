/**
 * How the jobs on a project's lines and speakers read in the tools
 * (retranscribe_range, detect_speakers, get_speakers, get_project): the
 * re-transcription's loop check and carried speakers, a long range's job
 * window by window, and what works on a project outside its dub. The app's
 * routes: POST/GET /projects/:id/lines/retranscribe[/:jobId],
 * GET /projects/:id/speakers, GET /projects/:id/jobs.
 */
import { clock } from './format.js';

/** A line as retranscribe_range heard it. */
export interface RetranscribedLine {
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
  speakerLowConfidence?: true;
  loopSuspect?: true;
}

export interface LoopCountsLite {
  removed: number;
  kept: number;
  left: number;
}

export interface RetranscribeWindowLite {
  fromMs: number;
  toMs: number;
  lines: number;
  loops: LoopCountsLite;
  speakers: { carried: number; unassigned: number };
  replaced?: number;
  summary: string;
}

export interface RetranscribeJobLite {
  id: string;
  state: 'running' | 'done' | 'failed';
  fromMs: number;
  toMs: number;
  apply: boolean;
  windows: number;
  done: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  results: RetranscribeWindowLite[];
  result?: { lines: number; replaced: number; loops: LoopCountsLite; speakers: { carried: number; unassigned: number } };
  lines?: RetranscribedLine[];
}

/** POST /projects/:id/lines/retranscribe: the result (up to 15 minutes), or a job. */
export interface RetranscribeAnswer {
  fromMs?: number;
  toMs?: number;
  lines?: RetranscribedLine[];
  loops?: { status: string }[];
  speakers?: { carried: number; unassigned: number };
  applied?: { replaced: number; lines: { id: string }[] };
  job?: RetranscribeJobLite;
}

/** A speaker detection job (GET /projects/:id/speakers `job`). */
export interface SpeakerJobLite {
  state: 'running' | 'done' | 'failed' | 'interrupted';
  done?: number;
  total?: number;
  error?: string;
  speakers?: number;
  lowConfidence?: number;
  range?: { fromMs: number; toMs: number };
  relabelled?: number;
  added?: number;
  detectedParts?: number;
}

/** One job of GET /projects/:id/jobs. */
export interface ProjectJobLite {
  id: string;
  kind: string;
  title: string;
  state: string;
  percent: number | null;
  message?: string;
  startedAt: string;
  endedAt?: string;
  etaSec?: number;
  result?: string;
  error?: string;
  initiator?: { kind: string; client?: string };
}

const span = (r: { fromMs: number; toMs: number }): string => `${clock(r.fromMs)}-${clock(r.toMs)}`;

/** How a range's lines without a speaker get one. */
const speakersHint = (r: { fromMs: number; toMs: number }): string =>
  `detect_speakers with fromMs=${Math.round(r.fromMs)} and toMs=${Math.round(r.toMs)} gives them speakers (linked to the project's speakers), or set them with adjust_lines.`;

function renderHeardLine(l: RetranscribedLine): string {
  const who = l.speakerId ? ` [${l.speakerId}${l.speakerLowConfidence ? '?' : ''}]` : '';
  return `- ${span({ fromMs: l.startMs, toMs: l.endMs })}${who} ${l.loopSuspect ? 'LOOP? ' : ''}${l.text}`;
}

function loopSentence(c: LoopCountsLite): string | undefined {
  if (!c.removed && !c.kept && !c.left) return undefined;
  const parts = [
    c.removed ? `${c.removed} loop(s) or credit line(s) removed (decoded again without context, or nothing was said)` : '',
    c.kept ? `${c.kept} repetition(s) kept: a fresh decode heard them again, so they were really said` : '',
    c.left ? `${c.left} loop(s) could not be checked and are marked LOOP?: compare them with the audio, fix them with replace_lines` : '',
  ].filter(Boolean);
  return `Loop check: ${parts.join('; ')}.`;
}

function countLoops(loops: readonly { status: string }[] | undefined): LoopCountsLite {
  const n = (s: string): number => (loops ?? []).filter((r) => r.status === s).length;
  return { removed: n('replaced') + n('removed'), kept: n('kept'), left: n('left') };
}

/** retranscribe_range's answer for a range of up to 15 minutes. */
export function renderRetranscribed(res: RetranscribeAnswer, asked: { fromMs: number; toMs: number; noContext: boolean }): string {
  const heard = res.lines ?? [];
  const range = { fromMs: res.fromMs ?? asked.fromMs, toMs: res.toMs ?? asked.toMs };
  const widened = range.fromMs !== asked.fromMs || range.toMs !== asked.toMs;
  const out = [
    `Heard ${heard.length} line(s) in ${span(asked)}${asked.noContext ? ' (no context)' : ''}${widened ? `, widened to the whole lines across its edges: ${span(range)}` : ''}:`,
    ...heard.map(renderHeardLine),
  ];
  const loops = loopSentence(countLoops(res.loops));
  if (loops) out.push(loops);
  const sp = res.speakers;
  if (sp && (sp.carried || sp.unassigned)) {
    out.push(
      `Speakers: ${sp.carried} line(s) keep the speaker of the old line under them (the same words)` +
        (sp.unassigned ? `; ${sp.unassigned} line(s) have none${res.applied ? `: ${speakersHint(range)}` : ' (with apply they would be left without one).'}` : '.'),
    );
  }
  out.push(
    res.applied
      ? `Applied: replaced ${res.applied.replaced} line(s) with ${res.applied.lines.length} (${res.applied.lines.map((l) => l.id).join(', ')}). Ids after this range moved too: read them again with get_transcript.`
      : 'Not applied: pass apply=true, or send your own version with replace_lines.',
  );
  return out.join('\n');
}

/** A re-transcription job (a range over 15 minutes), window by window. */
export function renderRetranscribeJob(job: RetranscribeJobLite, maxLines = 50): string {
  const what = `Re-transcription job ${job.id} (${span(job)}${job.apply ? ', applying each window as it is heard' : ', not applied'})`;
  const head =
    job.state === 'running'
      ? `${what}: running, ${job.done} of ${job.windows} window(s) done (${Math.round((job.done / Math.max(1, job.windows)) * 100)}%).`
      : job.state === 'failed'
        ? `${what}: stopped after ${job.done} of ${job.windows} window(s): ${job.error ?? 'unknown error'}.${job.apply && job.done > 0 ? ' The windows done are applied (each is in the edit history).' : ''}`
        : `${what}: done, ${job.windows} window(s).`;
  const out = [head, ...job.results.map((r) => `- ${r.summary}${r.replaced !== undefined ? ` (replaced ${r.replaced})` : ''}`)];
  const total = job.result;
  if (total) {
    out.push(`In all: ${total.lines} line(s) heard${job.apply ? `, ${total.replaced} old line(s) replaced` : ''}.`);
    const loops = loopSentence(total.loops);
    if (loops) out.push(loops);
    if (total.speakers.unassigned) out.push(`${total.speakers.unassigned} line(s) have no speaker: ${speakersHint(job)}`);
  }
  if (job.lines?.length) {
    out.push('Heard:', ...job.lines.slice(0, maxLines).map(renderHeardLine));
    if (job.lines.length > maxLines) out.push(`(${job.lines.length - maxLines} more line(s): apply them, or re-transcribe a shorter range to read them)`);
  }
  if (job.state === 'running') out.push(`Still running: call retranscribe_range with jobId="${job.id}" to follow it (get_project lists it too).`);
  return out.join('\n');
}

/** The state of a speaker detection job, in a sentence (get_speakers, detect_speakers). */
export function speakerJobSentence(job: SpeakerJobLite): string | undefined {
  const where = job.range ? ` over ${span(job.range)}` : '';
  const parts = job.total ? ` (${job.done ?? 0}/${job.total})` : '';
  switch (job.state) {
    case 'running':
      return `Speaker detection${where} is running${parts}: call again later.`;
    case 'failed':
      return `The last speaker detection${where} failed: ${job.error ?? 'unknown error'}.`;
    case 'interrupted':
      return `The last speaker detection${where} was interrupted: the app closed while it ran${job.total ? `, at part ${job.done ?? 0} of ${job.total}` : ''}. Call detect_speakers again: the parts already done are kept.`;
    case 'done':
      return job.range
        ? `Speakers detected${where}: ${job.relabelled ?? 0} line(s) changed speaker${job.added ? `, ${job.added} new speaker(s)` : ''}${job.detectedParts === 0 ? ' (from the saved detection, nothing detected again)' : ''}.`
        : undefined;
  }
}

/** What works on a project outside its dub (get_project's "Jobs"). */
export function renderProjectJobs(jobs: readonly ProjectJobLite[]): string[] {
  return jobs.map((j) => {
    const pct = j.percent !== null && j.state === 'running' ? ` ${j.percent}%` : '';
    const eta = j.etaSec && j.state === 'running' ? `, about ${j.etaSec >= 3600 ? `${Math.floor(j.etaSec / 3600)} h ${Math.round((j.etaSec % 3600) / 60)} min` : `${Math.max(1, Math.round(j.etaSec / 60))} min`} left` : '';
    const detail = j.state === 'failed' ? j.error : j.state === 'done' ? j.result : j.message;
    const who = j.initiator && j.initiator.kind !== 'unknown' ? ` [started by ${j.initiator.client ?? j.initiator.kind}]` : '';
    const next =
      j.state === 'interrupted'
        ? j.kind === 'speakers.detect'
          ? ' (detect_speakers again continues from the parts done)'
          : ' (the app closed while it ran: start it again)'
        : '';
    return `  - ${j.title}: ${j.state}${pct}${detail ? ` (${detail})` : ''}${eta}${who}${next}`;
  });
}
