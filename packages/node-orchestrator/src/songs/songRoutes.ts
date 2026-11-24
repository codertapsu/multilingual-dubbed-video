/**
 * The song routes (the editor's Songs section, MCP mark_song and
 * get_transcript):
 *   GET  /projects/:id/songs  the lines kept as the original song, the open
 *                             suggestions (songSuggestions.ts), songSubtitles;
 *   POST /projects/:id/songs  keep lines as the original song, or dub them
 *                             again ({ lineIds | fromMs+toMs, song,
 *                             applyToParts }); settles their suggestions.
 * With applyToParts on a series, the parent's lines are marked in every part
 * by time (a part's lines are the parent's, moved to the part's own time):
 * the parts of the 27.8-hour series were made long before anyone looked at
 * its songs.
 */
import fsp from 'node:fs/promises';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AppErrorException, type Project, type TranscriptSegment } from '@videodubber/shared';

import { activity } from '../activity/registry.js';
import type { ProjectStore } from '../workspace/projectStore.js';
import { isSong, windowsInPart, type SongMarkRequest, type SongMarkResult } from './songLines.js';
import { openSuggestions, readSongSuggestions, settleSuggestions, songSuggestionsPath } from './songSuggestions.js';

type PartOutcome = { projectId: string; index: number; ok: boolean; skipped?: string; error?: string };

export interface SongRouteDeps {
  store: ProjectStore;
  orchestrator: { markSongs(projectId: string, request: SongMarkRequest): Promise<SongMarkResult> };
  /** server.ts forEachPart: a series' parts in order, a part being dubbed skipped with the reason. */
  forEachPart(projectId: string, apply: (partId: string) => Promise<unknown>): Promise<PartOutcome[]>;
  sendError(reply: FastifyReply, err: unknown): void;
}

async function readLines(file: string): Promise<TranscriptSegment[] | undefined> {
  try {
    const doc = JSON.parse(await fsp.readFile(file, 'utf8')) as { segments?: TranscriptSegment[] } | TranscriptSegment[];
    return Array.isArray(doc) ? doc : doc.segments;
  } catch {
    return undefined;
  }
}

/** The project's lines: translated when they are, else as transcribed. */
async function projectLines(store: ProjectStore, projectId: string): Promise<TranscriptSegment[]> {
  const paths = store.paths(projectId);
  return (await readLines(paths.translatedJson)) ?? (await readLines(paths.sourceJson)) ?? [];
}

/** One write of a project's suggestions file at a time (two marks at once must not lose one's settling). */
const settling = new Map<string, Promise<void>>();
function settleInTurn(projectId: string, work: () => Promise<void>): Promise<void> {
  const next = (settling.get(projectId) ?? Promise.resolve()).then(work, work);
  const tail = next.catch(() => undefined);
  settling.set(projectId, tail);
  void tail.then(() => {
    if (settling.get(projectId) === tail) settling.delete(projectId);
  });
  return next;
}

export function registerSongRoutes(app: FastifyInstance, deps: SongRouteDeps): void {
  const { store, orchestrator } = deps;

  app.get('/projects/:id/songs', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const project = await store.getProject(req.params.id);
      const paths = store.paths(req.params.id);
      const lines = await projectLines(store, req.params.id);
      const file = await readSongSuggestions(songSuggestionsPath(paths));
      return {
        songs: lines.filter(isSong).map((l) => ({
          id: l.id,
          startMs: l.startMs,
          endMs: l.endMs,
          text: (l.sourceText ?? '').trim(),
          ...(l.translatedText ? { translatedText: l.translatedText } : {}),
        })),
        suggestions: openSuggestions(file, lines),
        ...(file?.checkedAt ? { checkedAt: file.checkedAt } : {}),
        songSubtitles: project.settings.songSubtitles === true,
        // A part's transcript came from its series: the suggestions are reviewed there.
        ...(project.series?.role === 'part' && !file ? { seriesParentId: project.series.parentId } : {}),
      };
    } catch (err) {
      return deps.sendError(reply, err);
    }
  });

  app.post(
    '/projects/:id/songs',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: { lineIds?: string[]; fromMs?: number; toMs?: number; song?: boolean; applyToParts?: boolean };
      }>,
      reply,
    ) => {
      try {
        const body = req.body ?? {};
        const song = body.song !== false;
        const lineIds = Array.isArray(body.lineIds) ? body.lineIds.filter((id): id is string => typeof id === 'string') : undefined;
        const request: SongMarkRequest = {
          song,
          ...(lineIds?.length ? { lineIds } : {}),
          ...(body.fromMs !== undefined ? { fromMs: Number(body.fromMs) } : {}),
          ...(body.toMs !== undefined ? { toMs: Number(body.toMs) } : {}),
        };
        const result = await orchestrator.markSongs(req.params.id, request);
        const paths = store.paths(req.params.id);
        await settleInTurn(req.params.id, async () =>
          settleSuggestions(songSuggestionsPath(paths), result.targets.map((t) => t.id), await projectLines(store, req.params.id)),
        );
        if (body.applyToParts !== true) return result;
        return { ...result, parts: await markInParts(deps, req.params.id, result) };
      } catch (err) {
        return deps.sendError(reply, err);
      }
    },
  );
}

/**
 * The parent's decision in every part: the windows of the lines it named,
 * moved into each part's time. Reported as one activity (48 parts take a while).
 */
async function markInParts(deps: SongRouteDeps, parentId: string, result: SongMarkResult): Promise<PartOutcome[]> {
  const parent: Project = await deps.store.getProject(parentId);
  if (parent.series?.role !== 'parent') {
    throw new AppErrorException('INVALID_EDIT', 'applyToParts works on a series (the project the parts were made from).');
  }
  const windows = result.targets.map((t) => ({ startMs: t.startMs, endMs: t.endMs }));
  const total = parent.series.partIds?.length ?? 0;
  const job = activity.start({
    kind: 'songs',
    title: `${result.song ? 'Keeping songs' : 'Dubbing songs again'} in the parts of "${parent.name}"`,
    projectId: parentId,
  });
  let done = 0;
  let marked = 0;
  try {
    const parts = await deps.forEachPart(parentId, async (partId) => {
      const part = await deps.store.getProject(partId);
      done++;
      job.progress(total ? (done / total) * 100 : null, `Part ${done}/${total}`);
      if (!part.sourceRange) return;
      const inPart = windowsInPart(windows, part.sourceRange);
      if (inPart.length === 0) return;
      const r = await deps.orchestrator.markSongs(partId, { song: result.song, windows: inPart });
      marked += r.changed.length;
      await settleInTurn(partId, async () =>
        settleSuggestions(songSuggestionsPath(deps.store.paths(partId)), r.targets.map((t) => t.id), await projectLines(deps.store, partId)),
      );
    });
    job.done(`${marked} line(s) changed in ${parts.filter((p) => p.ok).length} part(s)`);
    return parts;
  } catch (err) {
    job.fail(err);
    throw err;
  }
}
