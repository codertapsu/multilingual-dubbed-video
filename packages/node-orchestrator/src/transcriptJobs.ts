/**
 * HTTP routes of the jobs on a project's lines and speakers (plan 1.3, 6.1):
 *
 *   GET /projects/:id/lines/retranscribe/:jobId   a re-transcription job (a range
 *       over 15 minutes, POST /projects/:id/lines/retranscribe answered 202):
 *       windows done, each window's outcome, the totals once it ended
 *   GET /projects/:id/jobs   what works on the project now, and what ended in the
 *       last 30 minutes, whoever started it (get_project lists it): speaker
 *       detection, re-transcription, and every other kind in the activity list
 *
 * And how many parts of a speaker detection may run at once
 * ({@link diarizationBudget}), wired into the provider in server.ts.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ActivityEntry, ActivityInitiator, ActivityState, PipelineStepId } from '@videodubber/shared';
import { formatClock } from './activity/history.js';
import { activity } from './activity/registry.js';
import type { LocalJobOrchestrator } from './orchestrator.js';
import type { SpeakerJobView } from './pipeline/speakerJob.js';
import { DISK_HEAVY_STEPS } from './providers/download/downloadGate.js';
import type { ProjectStore } from './workspace/projectStore.js';

/** One job of a project, as GET /projects/:id/jobs lists it. */
export interface ProjectJobView {
  id: string;
  /** `speakers.detect`, `lines.retranscribe`, ... (the activity list's kinds). */
  kind: string;
  title: string;
  /** `interrupted`: the app closed or crashed while it ran (start it again; saved work is kept). */
  state: ActivityState | 'interrupted';
  percent: number | null;
  message?: string;
  startedAt: string;
  endedAt?: string;
  etaSec?: number;
  result?: string;
  error?: string;
  initiator: ActivityInitiator;
}

/** Jobs this process runs itself: a running entry of these kinds it does not run died with an earlier one. */
const OWN_KINDS: ReadonlySet<string> = new Set(['speakers.detect', 'lines.retranscribe']);
/** Ended jobs stay listed this long. */
const RECENT_MS = 30 * 60_000;
const MAX_JOBS = 10;

/**
 * A project's jobs from the activity list: those still working and those that
 * ended in the last 30 minutes, newest first. A detection or re-transcription
 * the list says is running but no live job of this process holds was
 * interrupted (a list kept across a restart); so is a detection saved as
 * running in the project's folder that the list does not have. Pure.
 */
export function projectJobViews(
  entries: readonly ActivityEntry[],
  opts: { live: ReadonlySet<string>; now: number; savedSpeakerJob?: SpeakerJobView },
): ProjectJobView[] {
  const views: (ProjectJobView & { at: string })[] = entries
    .filter((e) => !e.endedAt || opts.now - Date.parse(e.endedAt) <= RECENT_MS)
    .map((e) => {
      const dead = !e.endedAt && OWN_KINDS.has(e.kind) && !opts.live.has(e.id);
      return {
        id: e.id,
        kind: e.kind,
        title: e.title,
        state: dead ? 'interrupted' : e.state,
        percent: e.percent,
        ...(e.message ? { message: e.message } : {}),
        startedAt: e.startedAt,
        ...(e.endedAt ? { endedAt: e.endedAt } : {}),
        ...(e.etaSec !== undefined && !dead ? { etaSec: e.etaSec } : {}),
        ...(e.result ? { result: e.result } : {}),
        ...(e.error ? { error: e.error.message } : {}),
        initiator: e.initiator,
        at: e.updatedAt,
      };
    });
  const saved = opts.savedSpeakerJob;
  if (saved?.state === 'interrupted' && !views.some((v) => v.kind === 'speakers.detect' && (v.id === saved.activityId || v.state === 'running'))) {
    views.push({
      id: saved.activityId ?? 'speakers.detect',
      kind: 'speakers.detect',
      title: saved.range ? `Detecting speakers at ${formatClock(saved.range.fromMs)}–${formatClock(saved.range.toMs)}` : 'Detecting speakers',
      state: 'interrupted',
      percent: saved.total > 0 ? Math.round((saved.done / saved.total) * 100) : null,
      ...(saved.total > 1 ? { message: `Part ${saved.done}/${saved.total}` } : {}),
      startedAt: saved.startedAt,
      initiator: { kind: 'unknown' },
      at: saved.startedAt,
    });
  }
  return views
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MAX_JOBS)
    .map(({ at: _at, ...v }) => v);
}

/**
 * How many parts of a speaker detection may run at once now: unlimited (the
 * engine's pool caps it) while the machine is otherwise idle, one while a
 * heavy step runs anywhere (the heavy lane is held, a dub is in a step of a
 * heavy engine or one that writes gigabytes: extract, mix, render) or the app
 * is short of memory. Pure.
 */
export function diarizationBudget(input: { heavyLane: boolean; runs: readonly { step: PipelineStepId; heavy: boolean }[]; pressure: boolean }): number {
  const busy = input.heavyLane || input.pressure || input.runs.some((r) => r.heavy || DISK_HEAVY_STEPS.has(r.step));
  return busy ? 1 : Number.POSITIVE_INFINITY;
}

export interface TranscriptJobRoutesDeps {
  orchestrator: Pick<LocalJobOrchestrator, 'retranscribeJob' | 'speakerJobState' | 'liveLineJobIds'>;
  store: Pick<ProjectStore, 'getProject'>;
  sendError: (reply: FastifyReply, err: unknown) => unknown;
}

export function registerTranscriptJobRoutes(app: FastifyInstance, deps: TranscriptJobRoutesDeps): void {
  app.get(
    '/projects/:id/lines/retranscribe/:jobId',
    async (req: FastifyRequest<{ Params: { id: string; jobId: string } }>, reply) => {
      const job = deps.orchestrator.retranscribeJob(req.params.id, req.params.jobId);
      if (!job) {
        return reply.status(404).send({
          error: {
            code: 'UNKNOWN',
            message: 'No such re-transcription job: the app restarted since, or it ended long ago. Each window it applied is in the transcript and its edit history.',
          },
        });
      }
      return job;
    },
  );

  app.get('/projects/:id/jobs', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      await deps.store.getProject(req.params.id);
      const saved = await deps.orchestrator.speakerJobState(req.params.id);
      return {
        jobs: projectJobViews(activity.list({ projectId: req.params.id }), {
          live: deps.orchestrator.liveLineJobIds(),
          now: Date.now(),
          ...(saved ? { savedSpeakerJob: saved } : {}),
        }),
      };
    } catch (err) {
      return deps.sendError(reply, err);
    }
  });
}
