/**
 * HTTP routes of the picture options (watermarks and the band over the
 * source's own subtitles; docs/plans/production-requests-2026-11-23.md 4.2–4.4):
 *
 *   POST /projects/:id/picture/detect   { fresh?, waitMs?, ai? } start or join the detection; its state
 *   GET  /projects/:id/picture/detect   what it is doing, or its last result
 *   POST /projects/:id/picture/frame    { atMs? } one frame (a data: URL) for the editor
 *   POST /picture/detect                { videoPath, fresh?, waitMs? } the same for a video that is no project yet (the wizard)
 *   POST /picture/frame                 { videoPath, atMs? }
 *
 * What they find is a PROPOSAL: settings.blurRegions and
 * burnSubtitleStyle.coverBand are saved with PUT /projects/:id/settings
 * (`?applyToParts=true` for a whole series), like any other setting.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { PictureDetectionService, StartDetection } from './pictureDetection.js';

export interface PictureRoutesDeps {
  pictures: PictureDetectionService;
  sendError: (reply: FastifyReply, err: unknown) => unknown;
}

/** The start options a body may carry, checked. */
function startOptions(body: unknown): StartDetection {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return {
    ...(b.fresh === true ? { fresh: true } : {}),
    ...(typeof b.waitMs === 'number' && Number.isFinite(b.waitMs) ? { waitMs: b.waitMs } : {}),
    ...(b.ai === true ? { ai: true } : {}),
  };
}

const atOf = (body: unknown): number | undefined => {
  const v = (body && typeof body === 'object' ? (body as Record<string, unknown>).atMs : undefined) as unknown;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

export function registerPictureRoutes(app: FastifyInstance, deps: PictureRoutesDeps): void {
  const { pictures, sendError } = deps;

  app.post('/projects/:id/picture/detect', async (req: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply) => {
    try {
      return await pictures.detectProject(req.params.id, startOptions(req.body));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/projects/:id/picture/detect', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return await pictures.projectState(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/projects/:id/picture/frame', async (req: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply) => {
    try {
      return await pictures.projectFrame(req.params.id, atOf(req.body));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/picture/detect', async (req: FastifyRequest<{ Body: { videoPath?: unknown } }>, reply) => {
    try {
      return await pictures.detectFile(req.body?.videoPath as string, startOptions(req.body));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/picture/frame', async (req: FastifyRequest<{ Body: { videoPath?: unknown } }>, reply) => {
    try {
      return await pictures.fileFrame(req.body?.videoPath as string, atOf(req.body));
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
