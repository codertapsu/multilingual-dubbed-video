/**
 * HTTP routes of "Join several videos" (joinService.ts):
 *
 *   POST /join/check                 { videoPaths, renderQuality? } -> JoinCheck (how, cost, disk)
 *   POST /projects/join              JoinProjectRequest -> 201 { project, join }
 *   GET  /projects/:id/join          -> JoinStatus (404: not a joined project)
 *   POST /projects/:id/join/cancel   -> JoinStatus
 *   POST /projects/:id/join/restart  { reencode? } -> 202 JoinStatus
 *
 * And the guards a project whose input is still being joined needs, here so
 * the routes they guard stay as they were: run, retry and probe answer why
 * not yet (instead of a probe failing on a file that does not exist yet);
 * deleting the project cancels its join first; New project's Back + Continue
 * may rename it or change its settings, never its video; the projects folder
 * does not move under a join.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppErrorException, type JoinProjectRequest, type RenderQuality, type SeriesSettings } from '@videodubber/shared';

import type { JoinService } from './joinService.js';

export interface JoinRoutesDeps {
  joins: JoinService;
  sendError: (reply: FastifyReply, err: unknown) => void;
  /**
   * The series settings as POST /projects takes them, with a usable AI (the
   * one asked for, else the default); throws when none is set up.
   */
  resolveSeries?: (series: SeriesSettings) => Promise<SeriesSettings>;
}

const RENDER_QUALITIES = new Set<RenderQuality>(['auto', 'quality', 'fast']);

/** Routes that would run or probe the project's input. */
const NEEDS_INPUT = new Set(['/projects/:id/run', '/projects/:id/retry', '/projects/:id/probe']);

export function registerJoinRoutes(app: FastifyInstance, deps: JoinRoutesDeps): void {
  const { joins, sendError } = deps;

  app.post('/join/check', async (req: FastifyRequest<{ Body: { videoPaths?: unknown; renderQuality?: unknown } }>, reply) => {
    try {
      const quality = req.body?.renderQuality;
      return await joins.check(req.body?.videoPaths, {
        ...(typeof quality === 'string' && RENDER_QUALITIES.has(quality as RenderQuality) ? { renderQuality: quality as RenderQuality } : {}),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/projects/join', async (req: FastifyRequest<{ Body: JoinProjectRequest }>, reply) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object') throw new AppErrorException('INVALID_EDIT', 'Expected { videoPaths, name, settings }.');
      const series = body.series && deps.resolveSeries ? await deps.resolveSeries(body.series) : undefined;
      const { series: _asked, ...rest } = body;
      const made = await joins.create({ ...rest, ...(series ? { series } : {}) });
      return reply.status(201).send(made);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/projects/:id/join', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const status = await joins.status(req.params.id);
      if (!status) {
        return reply.status(404).send({ error: { code: 'UNKNOWN', message: 'This project was not made by joining videos.' } });
      }
      return status;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/projects/:id/join/cancel', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return await joins.cancel(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post(
    '/projects/:id/join/restart',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { reencode?: unknown } }>, reply) => {
      try {
        return reply.status(202).send(await joins.restart(req.params.id, { reencode: req.body?.reencode === true }));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.addHook('preHandler', async (req, reply) => {
    const route = req.routeOptions.url;
    if (!route || req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') return;
    const id = (req.params as { id?: unknown } | undefined)?.id;
    if (req.method === 'POST' && typeof id === 'string' && NEEDS_INPUT.has(route)) {
      const block = await joins.blockReason(id);
      if (block) {
        sendError(reply, block);
        return reply;
      }
      return;
    }
    if (route === '/projects/:id' && typeof id === 'string' && joins.isJoining(id)) {
      if (req.method === 'DELETE') {
        // Deleting the project is the way to abandon a join: stop it first.
        await joins.cancel(id);
        return;
      }
      const body = req.body as { inputVideoPath?: unknown } | undefined;
      if (req.method === 'PUT' && typeof body?.inputVideoPath === 'string' && body.inputVideoPath.trim()) {
        sendError(
          reply,
          new AppErrorException('RUN_IN_PROGRESS', 'The videos are being joined into this project: its video cannot be replaced now.', {
            remediation: 'Cancel the join (or wait for it), or make a new project for another video.',
          }),
        );
        return reply;
      }
      return;
    }
    if (req.method === 'PUT' && route === '/storage/projects-folder' && joins.busy) {
      sendError(
        reply,
        new AppErrorException('RUN_IN_PROGRESS', 'Videos are being joined into a project in the projects folder.', {
          remediation: 'Wait for the join to finish (the activity list shows it), then move the projects.',
        }),
      );
      return reply;
    }
  });

  // On the way out (POST /shutdown, SIGTERM): stop the joins; each starts again at the next start.
  app.addHook('onClose', async () => {
    await joins.stopAll();
  });
}
