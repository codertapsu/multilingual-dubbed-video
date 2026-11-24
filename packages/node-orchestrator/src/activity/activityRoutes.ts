/**
 * One place for all the work, and an edit history (docs/plans/
 * production-requests-2026-11-23.md, Phase 3):
 *
 *   GET  /activity?projectId=&active=1&limit=&since=  the list, newest first (since: changed at or after)
 *   GET  /activity/events?projectId=                 SSE: {type:'entry', entry, replay?}
 *   GET  /activity/agents                            the MCP sessions of the last hour
 *   POST /activity/report                            an agent's own outside work (report_activity)
 *   GET  /projects/:id/history?limit=                the edit history, newest first (no lines)
 *   GET  /projects/:id/history/:entryId              one entry with its lines
 *   POST /projects/:id/history/:entryId/undo         undo it (refused with what changed since)
 *
 * Registering also starts what fills the list and keeps it: the activity read
 * back from disk (activityLog.ts), the edit history on disk (historyStore.ts),
 * the followers of the dubs, installs, downloads and re-voicing, and a line in
 * the app's structured log when an entry starts and ends (its id is the log
 * reference the Activity view shows).
 */
import path from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  toAppError,
  type ActivityEntry,
  type ActivityReport,
  type ActivityState,
  type ActivityStreamEvent,
  type DownloadQueueEvent,
  type EngineInstallEvent,
  type SegmentPatch,
  type SetupEvent,
  type TranscriptSegment,
} from '@videodubber/shared';

import type { LogRecord } from '../diagnostics/logFiles.js';
import type { EventBusRegistry } from '../events.js';
import { ActivityLog, settleInterrupted } from './activityLog.js';
import { AgentSessions } from './agents.js';
import { headerValue, initiatorFromHeaders } from './context.js';
import { dubRuns as defaultDubRuns, type DubRunTracker } from './dubRuns.js';
import { configureEditHistory, getEdit, listEditSummaries, summarizeEdit } from './history.js';
import { FileEditHistoryStore } from './historyStore.js';
import { activity as defaultRegistry, type ActivityRegistry } from './registry.js';
import { RevoiceTracker } from './revoicing.js';
import { followDownloads, followEngineInstalls, followModelInstalls } from './sources.js';
import { undoEdit, UndoRefusedError } from './undo.js';

type Subscribable<E> = { subscribe(listener: (event: E) => void): () => void };

export interface ActivityRoutesDeps {
  /** `<config>/logs`: the app-wide activity.jsonl goes beside the other logs. */
  logsDir: string;
  /** The projects (their folders hold their history and activity log). */
  store: {
    paths(projectId: string): { root: string; logsDir: string; sourceJson: string; translatedJson: string };
    exists(projectId: string): Promise<boolean>;
    getProject(projectId: string): Promise<{ name: string }>;
  };
  /** Every project's run events (the dubs' steps and endings). */
  bus: Pick<EventBusRegistry, 'observe'>;
  engineBus?: Subscribable<EngineInstallEvent>;
  setupBus?: Subscribable<SetupEvent>;
  downloads?: Subscribable<DownloadQueueEvent>;
  /** The writes an undo goes through. */
  orchestrator: {
    replaceSourceLines(
      projectId: string,
      fromMs: number,
      toMs: number,
      lines: { startMs: number; endMs: number; text: string; speakerId?: string }[],
      opts: { summary?: string; undoOf?: string; precondition?: (current: readonly TranscriptSegment[]) => void },
    ): Promise<unknown>;
    patchSegments(
      projectId: string,
      patches: SegmentPatch[],
      opts: { summary?: string; undoOf?: string; precondition?: (base: readonly TranscriptSegment[]) => void },
    ): Promise<unknown>;
  };
  /** The projects folder is moving: no project file is written meanwhile. */
  projectsMoving?: () => boolean;
  structured?: { write(record: LogRecord): void };
  sseHeaders: (req: FastifyRequest) => Record<string, string>;
  sendError: (reply: FastifyReply, err: unknown) => unknown;
  /** Injected in tests (default: the app's one registry and dub tracker). */
  registry?: ActivityRegistry;
  dubRuns?: DubRunTracker;
}

const PROJECT_ID = /^[\w-]{1,80}$/;
const STATES: readonly ActivityState[] = ['running', 'waiting', 'done', 'failed', 'cancelled'];
/** Open reports one app keeps at most: an agent that never ends its reports cannot fill the list. */
const MAX_OPEN_REPORTS = 50;
/** Ended entries replayed to a stream that connects, besides the running ones. */
const REPLAY_ENDED_MS = 10 * 60_000;

const TTS_ROUTE = '/projects/:id/segments/:segId/tts';

const clampLimit = (raw: string | undefined, fallback: number, max: number): number => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};

const notFound = (reply: FastifyReply, message: string): FastifyReply =>
  reply.status(404).send({ error: { code: 'UNKNOWN', message, remediation: 'Check the id; list the projects (or the history) to see the valid ones.' } });

const badRequest = (reply: FastifyReply, message: string): FastifyReply =>
  reply.status(400).send({ error: { code: 'INVALID_EDIT', message } });

export async function registerActivityRoutes(app: FastifyInstance, deps: ActivityRoutesDeps): Promise<void> {
  const registry = deps.registry ?? defaultRegistry;
  const dubRuns = deps.dubRuns ?? defaultDubRuns;
  const { store } = deps;

  // ---- The edit history, kept in each project's folder.
  configureEditHistory(new FileEditHistoryStore((projectId) => path.join(store.paths(projectId).root, 'history')));

  // ---- The activity on disk: read back, then every change written.
  const projectFile = async (projectId: string, purpose: 'write' | 'read'): Promise<string | undefined> => {
    if (!PROJECT_ID.test(projectId)) return undefined;
    if (purpose === 'write' && deps.projectsMoving?.()) return undefined;
    if (!(await store.exists(projectId))) return undefined;
    return path.join(store.paths(projectId).logsDir, 'activity.jsonl');
  };
  const log = new ActivityLog({ logsDir: deps.logsDir, projectFile });
  registry.restore(settleInterrupted(await log.readAll()));
  dubRuns.adoptRestored();
  const unsubscribers: (() => void)[] = [log.attach(registry)];

  // ---- The structured log: a line when an entry starts and when it ends.
  const logged = new Set<string>();
  unsubscribers.push(
    registry.subscribe((e) => {
      const first = !logged.has(e.id);
      if (!first && !e.endedAt) return;
      if (first) logged.add(e.id);
      if (e.endedAt) logged.delete(e.id);
      if (first && e.endedAt && e.state !== 'failed') return; // reported finished at once: one line is enough
      deps.structured?.write({
        level: e.state === 'failed' ? 'warn' : 'info',
        msg: `activity ${e.endedAt ? e.state : 'started'}: ${e.title}${e.endedAt && e.message ? ` (${e.message})` : ''}`,
        event: 'activity',
        activityId: e.id,
        kind: e.kind,
        initiator: e.initiator.kind,
        ...(e.initiator.client ? { client: e.initiator.client } : {}),
        ...(e.projectId ? { projectId: e.projectId } : {}),
        ...(e.logRef ? { mcpRequestId: e.logRef } : {}),
      });
    }),
  );

  // ---- What fills the list: dubs, installs, downloads, re-voicing.
  unsubscribers.push(deps.bus.observe((projectId, event) => dubRuns.onEvent(projectId, event)));
  if (deps.engineBus) unsubscribers.push(followEngineInstalls(deps.engineBus, registry));
  if (deps.setupBus) unsubscribers.push(followModelInstalls(deps.setupBus, registry));
  if (deps.downloads) unsubscribers.push(followDownloads(deps.downloads, registry));
  const revoice = new RevoiceTracker(registry);
  const agents = new AgentSessions();

  app.addHook('onRequest', (req, _reply, done) => {
    agents.seen(req.headers);
    if (req.method === 'POST' && req.routeOptions?.url === TTS_ROUTE) {
      const { id } = req.params as { id: string };
      const left = Number.parseInt(headerValue(req.headers['x-vd-batch-left']) ?? '', 10);
      revoice.started(id, initiatorFromHeaders(req.headers), Number.isFinite(left) ? left : undefined);
    }
    done();
  });
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'POST' || req.routeOptions?.url !== TTS_ROUTE) return;
    const { id } = req.params as { id: string };
    revoice.ended(id, initiatorFromHeaders(req.headers), reply.statusCode < 400, reply.statusCode >= 400 ? `HTTP ${reply.statusCode}` : undefined);
  });
  app.addHook('onClose', async () => {
    for (const off of unsubscribers) off();
    revoice.dispose();
    await log.flush();
  });

  // ---- Project names on the entries (the list is read by people).
  const names = new Map<string, { name: string; at: number }>();
  const nameOf = async (projectId: string): Promise<string | undefined> => {
    const cached = names.get(projectId);
    if (cached && Date.now() - cached.at < 60_000) return cached.name;
    const name = await store
      .getProject(projectId)
      .then((p) => p.name)
      .catch(() => undefined);
    if (name !== undefined) names.set(projectId, { name, at: Date.now() });
    if (names.size > 500) names.delete(names.keys().next().value!);
    return name ?? cached?.name;
  };
  const named = async (e: ActivityEntry): Promise<ActivityEntry> => {
    if (!e.projectId) return e;
    const name = await nameOf(e.projectId);
    return name ? { ...e, projectName: name } : e;
  };

  // ---- Routes ----------------------------------------------------------------

  app.get(
    '/activity',
    async (req: FastifyRequest<{ Querystring: { projectId?: string; active?: string; limit?: string; since?: string } }>, reply) => {
      try {
        const projectId = req.query.projectId?.trim() || undefined;
        if (projectId && !PROJECT_ID.test(projectId)) return badRequest(reply, 'Not a project id.');
        const active = req.query.active === '1' || req.query.active === 'true';
        const limit = clampLimit(req.query.limit, 100, 500);
        // `since` (an updatedAt the caller saw): only what changed at or after it,
        // for a client that polls (the window: see core/activity/activity.service.ts).
        const since = req.query.since?.trim() || undefined;
        if (since && Number.isNaN(Date.parse(since))) return badRequest(reply, '"since" is an ISO time, as the entries\' updatedAt.');
        let entries = registry.list({ ...(projectId ? { projectId } : {}), active });
        if (since) entries = entries.filter((e) => e.updatedAt >= since);
        else if (projectId && !active) {
          // The project's own log holds what the app no longer keeps in memory.
          const known = new Set(entries.map((e) => e.id));
          const older = settleInterrupted((await log.readProject(projectId, limit)).filter((e) => !known.has(e.id)));
          entries = [...entries, ...older].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        }
        return { entries: await Promise.all(entries.slice(0, limit).map(named)) };
      } catch (err) {
        return deps.sendError(reply, err);
      }
    },
  );

  app.get('/activity/events', (req: FastifyRequest<{ Querystring: { projectId?: string } }>, reply) => {
    const projectId = req.query.projectId?.trim() || undefined;
    reply.raw.writeHead(200, deps.sseHeaders(req)).flushHeaders();
    reply.hijack();
    let open = true;
    // Written in order: a name lookup must not let a later change overtake an earlier one.
    let chain: Promise<void> = Promise.resolve();
    const send = (entry: ActivityEntry, replay: boolean): void => {
      if (projectId && entry.projectId !== projectId) return;
      chain = chain.then(async () => {
        const event: ActivityStreamEvent = { type: 'entry', entry: await named(entry), ...(replay ? { replay: true } : {}) };
        if (open) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });
    };
    const since = Date.now() - REPLAY_ENDED_MS;
    for (const e of registry.list({ ...(projectId ? { projectId } : {}), limit: 200 }).reverse()) {
      if (!e.endedAt || Date.parse(e.endedAt) >= since) send(e, true);
    }
    const unsubscribe = registry.subscribe((e) => send(e, false));
    const heartbeat = setInterval(() => {
      if (open) reply.raw.write(': ping\n\n');
    }, 15_000);
    const cleanup = (): void => {
      open = false;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  app.get('/activity/agents', async () => ({ sessions: agents.list() }));

  app.post('/activity/report', async (req: FastifyRequest<{ Body: ActivityReport & { progress?: number | null } }>, reply) => {
    try {
      const body = req.body ?? {};
      const state = body.state;
      if (state !== undefined && !STATES.includes(state)) return badRequest(reply, `"state" is one of ${STATES.join(', ')}.`);
      const rawPercent = body.percent !== undefined ? body.percent : body.progress;
      if (rawPercent !== undefined && rawPercent !== null && (typeof rawPercent !== 'number' || !Number.isFinite(rawPercent))) {
        return badRequest(reply, '"percent" is a number from 0 to 100, or null.');
      }
      const percent = rawPercent === undefined ? undefined : rawPercent === null ? null : Math.max(0, Math.min(100, Math.round(rawPercent)));
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : undefined;
      const detail = typeof body.detail === 'string' ? body.detail.trim().slice(0, 1000) : undefined;
      const patch = {
        ...(title ? { title } : {}),
        ...(state ? { state } : {}),
        ...(percent !== undefined ? { percent } : {}),
        ...(detail !== undefined ? { message: detail } : {}),
        ...(state === 'done' && detail ? { result: detail } : {}),
      };

      if (body.id !== undefined) {
        const current = typeof body.id === 'string' ? registry.get(body.id) : undefined;
        if (!current || !current.external) return notFound(reply, `There is no reported activity "${String(body.id)}".`);
        if (current.endedAt) {
          return reply.status(409).send({ error: { code: 'INVALID_EDIT', message: 'That report has ended: report the next piece of work as a new one (without "id").' } });
        }
        return { entry: await named(registry.report(current.id, patch)!) };
      }

      if (!title) return badRequest(reply, 'Say what the work is: "title".');
      const projectId = typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : undefined;
      if (projectId && (!PROJECT_ID.test(projectId) || !(await store.exists(projectId)))) {
        return notFound(reply, `There is no project "${projectId}".`);
      }
      if (registry.list({ active: true }).filter((e) => e.external).length >= MAX_OPEN_REPORTS) {
        return badRequest(reply, `${MAX_OPEN_REPORTS} reported activities are still open: end some (state "done") before reporting more.`);
      }
      const handle = registry.start({
        kind: 'external',
        title,
        external: true,
        ...(projectId ? { projectId } : {}),
        ...(state === 'waiting' ? { waiting: true } : {}),
        ...(detail ? { message: detail } : {}),
      });
      const entry = state !== undefined || percent !== undefined ? registry.report(handle.id, patch) : registry.get(handle.id);
      return reply.status(201).send({ entry: await named(entry!) });
    } catch (err) {
      return deps.sendError(reply, err);
    }
  });

  // ---- The edit history ------------------------------------------------------

  const projectOr404 = async (projectId: string, reply: FastifyReply): Promise<boolean> => {
    if (PROJECT_ID.test(projectId) && (await store.exists(projectId))) return true;
    notFound(reply, `Project not found: ${projectId}`);
    return false;
  };

  app.get(
    '/projects/:id/history',
    async (req: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: string } }>, reply) => {
      try {
        if (!(await projectOr404(req.params.id, reply))) return reply;
        const entries = await listEditSummaries(req.params.id);
        return { entries: entries.slice(0, clampLimit(req.query.limit, 200, 200)) };
      } catch (err) {
        return deps.sendError(reply, err);
      }
    },
  );

  app.get('/projects/:id/history/:entryId', async (req: FastifyRequest<{ Params: { id: string; entryId: string } }>, reply) => {
    try {
      if (!(await projectOr404(req.params.id, reply))) return reply;
      const entry = await getEdit(req.params.id, req.params.entryId);
      if (!entry) return notFound(reply, `This project has no history entry "${req.params.entryId}".`);
      return { entry, summary: summarizeEdit(entry) };
    } catch (err) {
      return deps.sendError(reply, err);
    }
  });

  app.post('/projects/:id/history/:entryId/undo', async (req: FastifyRequest<{ Params: { id: string; entryId: string } }>, reply) => {
    try {
      const { id, entryId } = req.params;
      if (!(await projectOr404(id, reply))) return reply;
      if (!(await getEdit(id, entryId))) return notFound(reply, `This project has no history entry "${entryId}".`);
      return await undoEdit(
        {
          paths: (projectId) => store.paths(projectId),
          replaceSourceLines: (projectId, fromMs, toMs, lines, opts) => deps.orchestrator.replaceSourceLines(projectId, fromMs, toMs, lines, opts),
          patchSegments: (projectId, patches, opts) => deps.orchestrator.patchSegments(projectId, patches, opts),
        },
        id,
        entryId,
      );
    } catch (err) {
      if (err instanceof UndoRefusedError) {
        // The changes that stop it go with the error, for the window to word them.
        return reply.status(409).send({ error: { ...toAppError(err), changes: err.changes } });
      }
      return deps.sendError(reply, err);
    }
  });
}
