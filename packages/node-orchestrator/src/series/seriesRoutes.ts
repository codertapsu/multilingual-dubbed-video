/**
 * The series routes added in 0.18.0 (docs/plans/production-requests-2026-11-23.md,
 * 2.2 and 5.2), registered at their anchor in server.ts:
 *
 *   PATCH /projects/:id/series-part   { name?, title?, summary? } a part renamed or
 *                                     retitled after it was made, its dub kept
 *   GET   /series                     the series a new one can continue (a later season)
 *
 * The routes the series had before (plan, parts, replan, rebuild-parts,
 * start) stay where they were in server.ts.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { SeriesService } from './seriesService.js';

export interface SeriesRoutesDeps {
  series: SeriesService;
  sendError: (reply: FastifyReply, err: unknown) => unknown;
}

export function registerSeriesRoutes(app: FastifyInstance, deps: SeriesRoutesDeps): void {
  app.patch(
    '/projects/:id/series-part',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { name?: unknown; title?: unknown; summary?: unknown } }>, reply) => {
      try {
        const b = req.body ?? {};
        const edit = {
          ...(typeof b.name === 'string' ? { name: b.name } : {}),
          ...(typeof b.title === 'string' ? { title: b.title } : {}),
          ...(typeof b.summary === 'string' ? { summary: b.summary } : {}),
        };
        if (Object.keys(edit).length === 0) {
          return reply.status(400).send({ error: { code: 'INVALID_EDIT', message: 'Send the part\'s new name, title or summary.' } });
        }
        return await deps.series.editPart(req.params.id, edit);
      } catch (err) {
        return deps.sendError(reply, err);
      }
    },
  );

  app.get('/series', async (_req, reply) => {
    try {
      return await deps.series.listSeries();
    } catch (err) {
      return deps.sendError(reply, err);
    }
  });
}
