/**
 * A long video dubbed as a series of parts (models/series.ts).
 *
 *   1. The parent project runs the pipeline up to speech-to-text (runner.ts
 *      skips the rest for it): the whole video is transcribed once.
 *   2. analysed(): the cuts are planned (seriesPlanner.ts; the AI chosen in
 *      Settings picks among the pauses and names the parts, seriesAi.ts), and
 *      a character sheet is made from the whole transcript, so every part
 *      uses the same names and forms of address.
 *   3. The user reviews the plan (or it was asked to start by itself):
 *      createParts() makes a project per part over its window of the same
 *      video (linked, never copied), with its share of the transcript (so
 *      speech-to-text is not repeated) and the character sheet. Each part is a
 *      normal project: the editor, Export, the queue and pausing work on it.
 *   4. startParts() queues them in order.
 *
 * After that a part can be renamed and retitled (editPart) and parts rebuilt
 * from a fixed series transcript (rebuildParts) without stopping the queue;
 * a later season can continue the series (prepareSeries, seriesContinue.ts).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  AppErrorException,
  fallbackPartTitle,
  partName,
  partNameTemplateProblem,
  pipelineStepIndex,
  projectOutputVideoPath,
  sanitizeSpeakerVoices,
  toAppError,
  type CreateProjectInput,
  type PictureDetection,
  type PipelineState,
  type Project,
  type ProjectLineIssues,
  type RunScheduleResult,
  type SeriesListItem,
  type SeriesParentInfo,
  type SeriesPartInfo,
  type SeriesPlan,
  type SeriesPlanPart,
  type SeriesSettings,
  type SeriesState,
  type SeriesReviewReason,
  type SeriesView,
  type TranscriptSegment,
  type TranslationDocContext,
} from '@videodubber/shared';

import { runAsScheduler } from '../activity/context.js';
import { formatClock, recordEdit } from '../activity/history.js';
import { activity, said, type ActivityHandle } from '../activity/registry.js';
import { readSpeakerProfiles } from '../pipeline/diarization.js';
import { languageName } from '../providers/translation/llmTranslationProvider.js';
import { generateCharacterSheet, type AnalysisChat } from '../providers/translation/translationContext.js';
import { adTailFrom } from '../picture/pictureDetection.js';
import { autoBlurRegions, describeMarks, faintMarks } from '../picture/watermarkAuto.js';
import { sourceNameHints } from './sourceHints.js';
import { writeJsonAtomic, type ProjectStore } from '../workspace/projectStore.js';
import { aiChooseCut, aiTitlePart, type SeriesChat } from './seriesAi.js';
import { continuedVoices, matchSpeakersByVoice } from './seriesContinue.js';
import { partList, partNumbering, seriesNameOf } from './seriesNumbering.js';
import {
  admissibleWindow,
  boundedWindow,
  candidateCuts,
  cutWindows,
  fallbackCut,
  fileBoundaries,
  keepEditedTitles,
  markEdited,
  MIN_PART_MS,
  partCount,
  partsFromCuts,
  partsOutsideBounds,
  partTranscript,
  snapToFileBoundary,
  validateCuts,
  type CutWindow,
} from './seriesPlanner.js';
import { rangedMediaInfo } from './seriesRange.js';
import { redoFrom, stepDone } from './seriesRedo.js';
import { sanitizeSeriesSettings } from './seriesSanitize.js';

export { sanitizeSeriesSettings };

/** What works on a project now (Orchestrator.workOn), the most binding first. */
export type ProjectWork = 'running' | 'moving' | 'editing' | 'detecting' | 'queued';

/** A part something works on, in a sentence ("Part 23 is being dubbed now"). */
const WORK_NOW: Record<Exclude<ProjectWork, 'queued'>, string> = {
  running: 'is being dubbed now',
  moving: 'is moving its finished files to another folder',
  editing: 'is busy in the editor (a line being voiced again)',
  detecting: 'is having its speakers detected',
};

export interface SeriesServiceDeps {
  store: ProjectStore;
  projects: {
    createProject(input: CreateProjectInput): Promise<Project>;
    getProjectWithPipeline(projectId: string): Promise<{ project: Project; pipeline: PipelineState }>;
    /** A part's lines to look at (H7): the series view lists them per part. Optional for the fakes. */
    lineIssues?(projectId: string): Promise<ProjectLineIssues>;
  };
  /** Start (or queue) a part; one waiting for its models starts when they arrive. */
  start: (projectId: string) => Promise<RunScheduleResult | { waiting: true }>;
  /** The chat of an AI provider id, when it can follow instructions here. */
  chatFor: (providerId: string) => (SeriesChat & AnalysisChat) | undefined;
  /**
   * Changes of shot (ms) inside the given spans of a video. Optional: without
   * it the cuts are ranked by pauses and chapters only.
   */
  sceneChanges?: (videoPath: string, spans: { startMs: number; endMs: number }[]) => Promise<number[]>;
  /** Pause a part's dub (Orchestrator.pauseJob): a series parent pauses all its parts. */
  pause?: (projectId: string) => Promise<unknown>;
  /** Something is working on this project now (Orchestrator.busyProjects). */
  isBusy?: (projectId: string) => boolean;
  /**
   * What works on a project now (Orchestrator.workOn): a part that only waits
   * in the queue is rebuilt or edited where it waits and keeps its turn;
   * anything else working on it leaves it alone. Without it, `isBusy` (any
   * work, the queue included) leaves a part alone.
   */
  workOn?: (projectId: string) => ProjectWork | undefined;
  /**
   * Run `fn` while the queue starts nothing (Orchestrator.whileQueueHeld), so
   * a part changed where it waits cannot start half-changed.
   */
  holdQueue?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Rename a project, its finished files in a chosen folder along (Orchestrator.renameProject). */
  renameProject?: (projectId: string, name: string) => Promise<Project>;
  /**
   * Find a project's watermark, run to its end: a series whose settings ask
   * for the watermark to be blurred (watermarkAuto) looks once in the whole
   * video during its analysis and makes every part with the boxes.
   */
  detectWatermark?: (projectId: string) => Promise<PictureDetection>;
  logger?: { info(message: string): void; warn(message: string): void };
}

/**
 * Why a series asked to start by itself must stop at review: what in the
 * parent's analysis would make every part wrong. Pure.
 */
export function seriesReviewReasons(
  parent: Pick<Project, 'settings'>,
  pipeline: Pick<PipelineState, 'warnings'> | undefined,
): SeriesReviewReason[] {
  const warnings = pipeline?.warnings ?? [];
  const reasons: SeriesReviewReason[] = [];
  if (parent.settings.diarize && warnings.some((w) => w.code === 'speakers-failed')) {
    reasons.push({
      code: 'speakers-failed',
      message: 'Speaker detection failed, so every part would be dubbed in one voice. Re-detect speakers, then start the parts.',
    });
  }
  if (warnings.some((w) => w.code === 'loops-left')) {
    reasons.push({
      code: 'loops-left',
      message: 'The transcript still has repeated lines flagged as transcription loops. Check them (get_transcript, the editor), then start the parts.',
    });
  }
  // A garbled stretch or minutes of digital silence (a bad join or download):
  // the 27.8-hour series' outside join left 5.3 h garbled and 2 h silent, and
  // every part made from it would have carried that (claude-dubber, 2026-11-23).
  if (warnings.some((w) => w.code === 'transcript-mismatch' || w.code === 'digital-silence')) {
    reasons.push({
      code: 'transcript-mismatch',
      message:
        'Spot checks found stretches where the transcript does not match the audio, or minutes of complete silence (a bad join or download). get_project lists their times: check them, re-transcribe them (retranscribe_range) or fix the source, then start the parts.',
    });
  }
  return reasons;
}

/** What rebuilding one part did (rebuildParts). */
export interface RebuiltPart {
  projectId: string;
  /** The part's number as shown. */
  index: number;
  rebuilt: boolean;
  /** Why it was left as it was. */
  skipped?: 'running' | 'translated' | 'missing';
  /** The same, in a sentence ("is being dubbed now"). */
  reason?: string;
  /** Rebuilt where it waited in the queue: it kept its turn. */
  queued?: boolean;
  /** Its translation was set aside (force): its next run continues at the translation. */
  translationDiscarded?: boolean;
  oldLines?: number;
  newLines?: number;
  speakers?: number;
}

/** What editing a part did (editPart). */
export interface EditedPart {
  project: Project;
  /**
   * Its video shows the old title: it was set to render again (paused at
   * Render; Continue or start_series renders it, nothing else).
   */
  renderAgain: boolean;
}

export class SeriesService {
  private readonly busy = new Set<string>();

  constructor(private readonly deps: SeriesServiceDeps) {}

  /** What works on a project now; without the orchestrator's answer, any work or a run on record. */
  private workOn(projectId: string, project?: Pick<Project, 'status'>): ProjectWork | undefined {
    if (this.deps.workOn) return this.deps.workOn(projectId);
    if (this.deps.isBusy?.(projectId) || project?.status === 'running' || project?.status === 'queued') return 'running';
    return undefined;
  }

  /** `fn` while the queue starts nothing (when the orchestrator can hold it). */
  private hold<T>(fn: () => Promise<T>): Promise<T> {
    return this.deps.holdQueue ? this.deps.holdQueue(fn) : fn();
  }

  /** A part's lines as written (empty ones too), for its edit history. */
  private async rawLines(file: string): Promise<TranscriptSegment[]> {
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as { segments?: TranscriptSegment[] } | TranscriptSegment[];
      return Array.isArray(raw) ? raw : (raw.segments ?? []);
    } catch {
      return [];
    }
  }

  private planFile(parent: Project): string {
    return path.join(parent.workspaceDir, 'series', 'plan.json');
  }

  async readPlan(parent: Project): Promise<SeriesPlan | undefined> {
    try {
      return JSON.parse(await fsp.readFile(this.planFile(parent), 'utf8')) as SeriesPlan;
    } catch {
      return undefined;
    }
  }

  private async parentOf(projectId: string): Promise<Project & { series: SeriesParentInfo }> {
    const project = await this.deps.store.getProject(projectId);
    const id = project.series?.role === 'part' ? project.series.parentId : projectId;
    const parent = id === projectId ? project : await this.deps.store.getProject(id);
    if (parent.series?.role !== 'parent') {
      throw new AppErrorException('INVALID_EDIT', `"${project.name}" is not split into parts.`, {
        remediation: 'Create the project with "Split into parts" (New project) to dub a long video as a series.',
      });
    }
    return parent as Project & { series: SeriesParentInfo };
  }

  private async setState(parentId: string, state: SeriesState, patch: Partial<SeriesParentInfo> = {}): Promise<void> {
    const parent = await this.deps.store.getProject(parentId);
    if (parent.series?.role !== 'parent') return;
    const { error: _old, reviewReasons: _reasons, ...rest } = parent.series;
    await this.deps.store.saveProject({ ...parent, series: { ...rest, ...patch, state } });
  }

  private async lines(project: Project): Promise<TranscriptSegment[]> {
    const raw = JSON.parse(await fsp.readFile(this.deps.store.paths(project.id).sourceJson, 'utf8')) as
      | { segments?: TranscriptSegment[] }
      | TranscriptSegment[];
    return (Array.isArray(raw) ? raw : (raw.segments ?? [])).filter((l) => l.sourceText?.trim());
  }

  /**
   * The series' lines its parts are made from: none from where the advert
   * begins. A series planned on 0.21.0 ends at the banner, but the advert's
   * voice can start before it (Săn Yêu: "个个个点击评论区蓝色链接", 4 s early),
   * so its last part, made or rebuilt now, leaves those lines out
   * (adTailFrom finds them by their words).
   */
  private async partSourceLines(parent: Project): Promise<TranscriptSegment[]> {
    const lines = await this.lines(parent);
    const tailFrom = await adTailFrom(parent, lines);
    return tailFrom === undefined ? lines : lines.filter((l) => l.startMs < tailFrom);
  }

  /**
   * The parent has transcribed the video: plan the parts (and make and start
   * them when asked to). Also how a plan is made again (POST /series/replan):
   * `keepTitles` keeps the titles and summaries written in review. Followed
   * in the activity list (`series.plan`).
   */
  async analysed(parentId: string, opts: { keepTitles?: boolean; again?: boolean } = {}): Promise<void> {
    if (this.busy.has(parentId)) return;
    this.busy.add(parentId);
    let job: ActivityHandle | undefined;
    try {
      const parent = await this.parentOf(parentId);
      const before = opts.keepTitles ? await this.readPlan(parent) : undefined;
      job = activity.start({
        kind: 'series.plan',
        title: said(
          `${opts.again ? 'Planning again' : 'Planning'} the parts of "${seriesNameOf(parent)}"`,
          opts.again ? 'activity.text.series-replan' : 'activity.text.series-plan',
          { name: seriesNameOf(parent) },
        ),
        projectId: parentId,
      });
      await this.setState(parentId, 'planning');
      // The watermark, once for the whole video, while the AI plans (a picture
      // job beside a chat): every part is made with the boxes.
      const marks = this.findWatermark(parent, job);
      // The character sheet first: the part titles use its names.
      job.progress(null, said('Making the character sheet from the whole transcript', 'activity.text.series-sheet'));
      await this.sharedSheet(parent).catch((err: unknown) =>
        this.deps.logger?.warn(`series ${parentId}: no shared character sheet (${toAppError(err).message}); each part makes its own.`),
      );
      // A series continuing another: its voices for the speakers who sound like its speakers.
      const voiceNotes: string[] = [];
      await this.matchVoices(parentId, voiceNotes).catch((err: unknown) =>
        voiceNotes.push(`Voices were not matched to the series this one continues (${toAppError(err).message}).`),
      );
      const plan = await this.makePlan(parent, (percent, message) => job?.progress(percent, message));
      plan.notes.push(...voiceNotes, ...(await marks));
      if (before) {
        const kept = keepEditedTitles(plan.parts, before.parts);
        if (kept > 0) plan.notes.push(`The titles or summaries written in review were kept for ${kept} part(s).`);
      }
      await writeJsonAtomic(this.planFile(parent), plan);
      // Start by itself only from a clean analysis (the user's call, 2026-11-21):
      // otherwise stop at review and say why.
      const pipeline = parent.series.settings.autoStart
        ? (await this.deps.projects.getProjectWithPipeline(parentId).catch(() => undefined))?.pipeline
        : undefined;
      const reasons = parent.series.settings.autoStart ? seriesReviewReasons(parent, pipeline) : [];
      if (parent.series.settings.autoStart && reasons.length === 0) {
        // The app starts them by itself: the activity list says so, not that
        // whoever started the analysis hours ago asked for 48 dubs.
        await runAsScheduler(async () => {
          await this.createParts(parentId);
          await this.startParts(parentId);
        });
        job.done(said(`${plan.parts.length} parts planned, made and started`, 'activity.text.series-started', { n: plan.parts.length }));
      } else {
        if (reasons.length > 0) this.deps.logger?.warn(`series ${parentId}: stopped at review: ${reasons.map((r) => r.message).join(' ')}`);
        await this.setState(parentId, 'review', reasons.length > 0 ? { reviewReasons: reasons } : {});
        job.done(said(`${plan.parts.length} parts planned, ready for review`, 'activity.text.series-review', { n: plan.parts.length }));
      }
    } catch (err) {
      job?.fail(err);
      await this.setState(parentId, 'failed', { error: toAppError(err) }).catch(() => undefined);
    } finally {
      this.busy.delete(parentId);
    }
  }

  /** One part per joined file, or parts by length (replan_series perFile), before the parts are made. */
  async setPerFile(parentId: string, perFile: boolean): Promise<void> {
    const parent = await this.parentOf(parentId);
    if (parent.series.partIds?.length) throw new AppErrorException('INVALID_EDIT', 'The parts are already made.');
    const { perFile: _was, ...rest } = parent.series.settings;
    await this.deps.store.saveProject({ ...parent, series: { ...parent.series, settings: perFile ? { ...rest, perFile: true } : rest } });
  }

  /**
   * "Find the watermark and blur it" for a whole series (watermarkAuto): look
   * once in the whole video and save the clear marks as the series' boxes, so
   * every part is made with them and review shows them (the plan's notes).
   * Per-part detection at render stays the fallback when nothing is found
   * (claude-dubber's design, 2026-11-25). Never fails the plan: what happened
   * is a note.
   */
  private async findWatermark(parent: Project & { series: SeriesParentInfo }, job: ActivityHandle | undefined): Promise<string[]> {
    const auto = parent.settings.watermarkAuto;
    if (!auto || !this.deps.detectWatermark) return [];
    if ((parent.settings.blurRegions?.length ?? 0) > 0) {
      return [`The ${parent.settings.blurRegions!.length} box(es) the series already hides are used in every part (no watermark search).`];
    }
    try {
      job?.progress(null, said('Looking for a watermark in the whole video', 'activity.text.series-watermark'));
      const detection = await this.deps.detectWatermark(parent.id);
      const regions = autoBlurRegions(detection, auto);
      if (regions.length === 0) {
        const faint = faintMarks(detection);
        return [
          `No watermark stood out in the whole video${faint > 0 ? ` (${faint} faint mark(s))` : ''}: each part looks for its own when it renders.`,
        ];
      }
      const fresh = await this.deps.store.getProject(parent.id);
      await this.deps.store.saveProject({ ...fresh, settings: { ...fresh.settings, blurRegions: regions } });
      return [
        `Found ${describeMarks(detection)} in the whole video: every part is made with it blurred. Check it in the series' picture (detect_watermark shows the frame), or change it with update_settings blurRegions on the series before the parts are made.`,
      ];
    } catch (err) {
      return [`The watermark could not be looked for (${toAppError(err).message}): each part looks for its own when it renders.`];
    }
  }

  private async makePlan(
    parent: Project & { series: SeriesParentInfo },
    onProgress?: (percent: number, message: string) => void,
  ): Promise<SeriesPlan> {
    const lines = await this.lines(parent);
    const settings = parent.series.settings;
    const videoMs = parent.mediaInfo?.durationMs || lines.at(-1)?.endMs || 0;
    // An advert tail: the series ends where it starts, at once, with no review
    // to wait for (2026-11-27: the planner made parts of the advert alone).
    const tailFrom = await adTailFrom(parent, lines);
    const durationMs = tailFrom !== undefined && tailFrom < videoMs ? tailFrom : videoMs;
    const chapters = (parent.source?.chapters ?? []).map((c) => c.startMs);
    // A project joined from several files: where one ends and the next begins
    // is a preferred cut (one source video per part where the lengths allow).
    const boundaries = fileBoundaries(parent.inputFiles, durationMs);
    const notes: string[] = [];
    if (durationMs < videoMs) {
      notes.push(
        `The series ends at ${formatClock(durationMs)}: from there to the end (${formatClock(videoMs)}) the same banner stays on the picture, ` +
          'an advert for the full version, not the story. Speech-to-text stopped there too. To dub it as well, turn off "Stop where an advert tail begins" (stopAtAdTail) and redo the series from speech-to-text.',
      );
    }
    const count = partCount(durationMs, settings.minMinutes, settings.maxMinutes);
    let candidates = candidateCuts(lines, { chapters, boundaries });
    let windows = cutWindows(durationMs, count, settings, candidates);
    // A cut on a change of shot reads as a chapter, inside one shot as an
    // interruption: measured around the best pauses only, then ranked again.
    const scenes = await this.sceneChangesNear(parent, windows, candidates, notes);
    if (scenes.length > 0) {
      candidates = candidateCuts(lines, { chapters, scenes, boundaries });
      windows = cutWindows(durationMs, count, settings, candidates);
    }
    const chat = this.deps.chatFor(settings.aiProviderId);
    if (!chat) notes.push(`The AI "${settings.aiProviderId}" is not available here: the longest pauses near each target were used.`);
    const seriesName = seriesNameOf(parent);
    const sourceLanguageName = languageName(parent.settings.sourceLanguage || 'auto');
    const minMs = settings.minMinutes * 60_000;
    const maxMs = Math.max(minMs, settings.maxMinutes * 60_000);
    const cuts: { ms: number; by: 'ai' | 'pause' | 'file' }[] = [];
    // One part per joined file: the cuts are where the files meet.
    const perFile = settings.perFile === true && boundaries.length > 0;
    if (settings.perFile === true && boundaries.length === 0) {
      notes.push('One part per file was asked for, but this video is not joined from several files: it is cut by length.');
    }
    if (perFile) {
      cuts.push(...boundaries.map((ms) => ({ ms, by: 'file' as const })));
      notes.push(`One part per file: ${boundaries.length + 1} parts, cut where each file begins.`);
    }
    // Progress over the cuts, then the titles.
    const steps = Math.max(1, (perFile ? 0 : windows.length) + count);
    let stepsDone = 0;
    let previous = 0;
    for (const spread of perFile ? [] : windows) {
      onProgress?.((100 * stepsDone++) / steps, `Choosing cut ${spread.index} of ${windows.length}`);
      // Each cut where the parts it leaves can all stay within the bounds:
      // inside the usual window around the even split when that fits them,
      // else the bounds themselves; widened a little only when no pause
      // between lines lies inside (a part slightly long beats a cut mid-line).
      const bounds = admissibleWindow(previous, spread.index, count, durationMs, minMs, maxMs);
      let w = spread;
      if (bounds) {
        const near = { fromMs: Math.max(bounds.fromMs, spread.fromMs), toMs: Math.min(bounds.toMs, spread.toMs) };
        const inside = near.fromMs <= near.toMs ? near : bounds;
        w = boundedWindow(spread, inside, candidates);
        for (const slack of [30_000, 60_000, 120_000, 180_000]) {
          if (w.candidates.length > 0) break;
          w = boundedWindow(
            spread,
            { fromMs: Math.max(MIN_PART_MS, inside.fromMs - slack), toMs: Math.min(durationMs - MIN_PART_MS, inside.toMs + slack) },
            candidates,
          );
        }
      }
      if (!bounds) {
        notes.push(`Cut ${spread.index}: no cut keeps every part within ${settings.minMinutes}–${settings.maxMinutes} min here; the best pause near the even split was used.`);
      } else if (w.candidates.length === 0) {
        notes.push(`Cut ${w.index}: no pause between lines where the parts stay within ${settings.minMinutes}–${settings.maxMinutes} min; cut at ${Math.round(w.targetMs / 1000)} s.`);
      }
      let ms: number | undefined;
      if (chat && w.candidates.length > 0) {
        // One retry: a model that returned nothing usable once usually answers the second time.
        for (let attempt = 1; attempt <= 2 && ms === undefined; attempt++) {
          try {
            ms = await aiChooseCut(chat, w, lines, { seriesName, sourceLanguageName });
            if (ms === undefined && attempt === 2) notes.push(`Cut ${w.index}: the AI gave no usable answer twice; the best pause was used.`);
          } catch (err) {
            if (attempt === 2) notes.push(`Cut ${w.index}: the AI failed (${toAppError(err).message}); the best pause was used.`);
          }
        }
      }
      const chosen = ms !== undefined ? { ms, by: 'ai' as const } : { ms: fallbackCut(w), by: 'pause' as const };
      // Where two joined files meet close by: there (one source video per part).
      const snapped = snapToFileBoundary(chosen.ms, boundaries, { previousMs: previous, durationMs, minPartMs: MIN_PART_MS });
      if (snapped !== undefined) {
        notes.push(`Cut ${spread.index}: moved ${(Math.abs(snapped - chosen.ms) / 1000).toFixed(1)} s to where the next video file begins.`);
        chosen.ms = snapped;
      }
      cuts.push(chosen);
      previous = chosen.ms;
    }
    const { offset, total } = partNumbering(settings, cuts.length + 1);
    const parts = partsFromCuts(durationMs, cuts, settings.recapSec, lines, [], offset);
    for (const p of partsOutsideBounds(parts, settings.minMinutes, settings.maxMinutes)) {
      notes.push(
        `Part ${p.index} is ${p.minutes.toFixed(1)} min, outside ${settings.minMinutes}–${settings.maxMinutes} min: ` +
          'the video does not split into parts of that length at its pauses. Move the cuts (set_split_plan) to change it.',
      );
    }
    // Every part gets a title (1.5 of the 2026-11-23 plan): the AI's, after one
    // retry when its answer is unusable, else the plain "Phần 42" with a note.
    // Two parts of the 27.8-hour series kept '' with nothing to say why.
    const targetLanguage = parent.settings.targetLanguage;
    if (chat) {
      const targetLanguageName = languageName(targetLanguage);
      const names = await this.sheetNames(parent);
      const speakers = await this.speakerNames(parent);
      for (const part of parts) {
        onProgress?.((100 * stepsDone++) / steps, `Naming part ${part.index}`);
        let named: { title: string; summary: string } | undefined;
        const said = lines.some((l) => l.endMs > part.startMs && l.startMs < part.endMs);
        let cause: string | undefined = said ? undefined : 'nothing is said in it';
        for (let attempt = 1; said && attempt <= 2 && !named; attempt++) {
          try {
            named = await aiTitlePart(chat, part, total, lines, { seriesName, sourceLanguageName, targetLanguageName, names, speakers });
            if (!named) cause = 'no usable answer';
          } catch (err) {
            cause = toAppError(err).message;
          }
        }
        if (named) {
          Object.assign(part, named);
        } else {
          part.title = fallbackPartTitle(part.index, targetLanguage);
          notes.push(`Part ${part.index}: no title from the AI${cause ? ` (${cause})` : ''}, named '${part.title}'.`);
        }
      }
    } else {
      for (const part of parts) part.title = fallbackPartTitle(part.index, targetLanguage);
      if (parts.length > 0) notes.push(`No AI named the parts: they are called '${parts[0]!.title}' and so on until they are given titles.`);
    }
    return {
      aiProviderId: settings.aiProviderId,
      parts,
      candidates,
      createdAt: new Date().toISOString(),
      notes,
      ...(durationMs < videoMs ? { endMs: durationMs } : {}),
    };
  }

  /** The names the shared character sheet settled on (cast, and the glossary's renderings). */
  private async sheetNames(parent: Project): Promise<string[]> {
    try {
      const sheet = JSON.parse(await fsp.readFile(this.deps.store.paths(parent.id).translationContextJson, 'utf8')) as TranslationDocContext;
      return [
        ...(sheet.cast ?? []).map((c) => c.name),
        ...(sheet.glossary ?? []).map((g) => `${g.source} = ${g.target}`),
      ].filter((n) => n && n.trim());
    } catch {
      return [];
    }
  }

  /** Who each speaker id is, from the shared sheet (cast[].speakerId): the part summaries name the right person. */
  private async speakerNames(parent: Project): Promise<Map<string, string>> {
    try {
      const sheet = JSON.parse(await fsp.readFile(this.deps.store.paths(parent.id).translationContextJson, 'utf8')) as TranslationDocContext;
      return new Map((sheet.cast ?? []).filter((c) => c.speakerId && c.name).map((c) => [c.speakerId!, c.name]));
    } catch {
      return new Map();
    }
  }

  /** How many of each window's best pauses are looked at for a change of shot. */
  private static readonly SCENE_CANDIDATES_PER_CUT = 16;

  /**
   * Changes of shot within 1.5 s of each window's best pauses (a few seconds
   * of video each, not the film); none when the measure is missing or fails.
   */
  private async sceneChangesNear(
    parent: Project,
    windows: readonly CutWindow[],
    candidates: readonly { ms: number; score: number }[],
    notes: string[],
  ): Promise<number[]> {
    const measure = this.deps.sceneChanges;
    if (!measure || windows.length === 0) return [];
    const spans = windows.flatMap((w) =>
      candidates
        .filter((c) => c.ms >= w.fromMs && c.ms <= w.toMs)
        .sort((a, b) => b.score - a.score)
        .slice(0, SeriesService.SCENE_CANDIDATES_PER_CUT)
        .map((c) => ({ startMs: Math.max(0, c.ms - 1500), endMs: c.ms + 1500 })),
    );
    if (spans.length === 0) return [];
    try {
      const found = await measure(parent.inputVideoPath, spans);
      this.deps.logger?.info(`series ${parent.id}: ${found.length} change(s) of shot near ${spans.length} candidate pause(s).`);
      return found;
    } catch (err) {
      notes.push(`Changes of shot were not measured (${toAppError(err).message}): pauses and chapters only.`);
      return [];
    }
  }

  /** One character sheet from the whole transcript, shared by every part. */
  private async sharedSheet(parent: Project & { series: SeriesParentInfo }): Promise<void> {
    const paths = this.deps.store.paths(parent.id);
    if (await fsp.stat(paths.translationContextJson).then(() => true, () => false)) return;
    const chat = this.deps.chatFor(parent.series.settings.aiProviderId);
    if (!chat) return;
    const lines = await this.lines(parent);
    const outcome = await generateCharacterSheet(chat, {
      sourceLanguage: parent.settings.sourceLanguage,
      targetLanguage: parent.settings.targetLanguage,
      // With who speaks: without the ids the sheet could map no speaker and
      // plan no forms of address (claude-dubber, 2026-11-25, F2).
      segments: lines.map((l) => ({ id: l.id, sourceText: l.sourceText, startMs: l.startMs, endMs: l.endMs, ...(l.speakerId ? { speakerId: l.speakerId } : {}) })),
      hints: sourceNameHints(parent),
    });
    if (outcome.analysis) await writeJsonAtomic(paths.translationContextJson, outcome.analysis);
  }

  /**
   * The user's changes before the parts are made: cut times (the parts follow
   * them) and titles. Also how an agent (the plugin) sends its own cuts.
   */
  async revisePlan(projectId: string, edit: { cuts?: number[]; titles?: { title?: string; summary?: string }[] }): Promise<SeriesPlan> {
    const parent = await this.parentOf(projectId);
    if (parent.series.partIds?.length) {
      throw new AppErrorException('INVALID_EDIT', 'The parts are already made: change them in each part instead.');
    }
    const plan = await this.readPlan(parent);
    if (!plan) throw new AppErrorException('INVALID_EDIT', 'The video is still being analysed; the plan comes when it is done.');
    const lines = await this.lines(parent);
    // A series that ends before the video (an advert tail) keeps its end.
    const durationMs = plan.endMs ?? (parent.mediaInfo?.durationMs || plan.parts.at(-1)?.endMs || 0);
    const current = plan.parts.slice(1).map((p) => p.startMs);
    let cuts = current;
    if (edit.cuts) {
      const checked = validateCuts(edit.cuts, durationMs);
      if (!checked.ok) throw new AppErrorException('INVALID_EDIT', checked.reason);
      cuts = checked.cuts;
    }
    const byOf = (ms: number): 'ai' | 'pause' | 'manual' | 'file' => {
      const same = plan.parts.slice(1).find((p) => Math.abs(p.startMs - ms) < 500);
      return same && same.cutBy !== 'start' ? same.cutBy : 'manual';
    };
    const titles = edit.titles ?? (cuts === current ? plan.parts.map((p) => ({ title: p.title, summary: p.summary })) : []);
    const { offset } = partNumbering(parent.series.settings, cuts.length + 1);
    const parts = partsFromCuts(durationMs, cuts.map((ms) => ({ ms, by: byOf(ms) })), parent.series.settings.recapSec, lines, titles, offset);
    // What the user wrote is remembered, so planning again can keep it (replan_series keepTitles).
    if (edit.titles) markEdited(parts, plan.parts);
    else if (cuts === current) for (const [k, p] of parts.entries()) if (plan.parts[k]?.edited) p.edited = plan.parts[k]!.edited;
    const next: SeriesPlan = { ...plan, parts };
    await writeJsonAtomic(this.planFile(parent), next);
    return next;
  }

  /**
   * A project per part of the plan, once: named from the series' template
   * (the default one: "<series> - Phần 01"), numbered as shown (after the
   * series it continues), with the series' settings, voices included.
   */
  async createParts(projectId: string): Promise<string[]> {
    const planned = await this.parentOf(projectId);
    if (planned.series.partIds?.length) return planned.series.partIds;
    const plan = await this.readPlan(planned);
    if (!plan) throw new AppErrorException('INVALID_EDIT', 'The video is still being analysed; the parts come when it is done.');
    // A series continuing another matches its voices again now: speakers may
    // have been detected again since the plan (a series stopped at review
    // because speaker detection failed). Matching only fills speakers with no
    // voice yet, so doing it twice changes nothing.
    if (planned.series.settings.continues) {
      const voiceNotes: string[] = [];
      await this.matchVoices(planned.id, voiceNotes).catch((err: unknown) =>
        voiceNotes.push(`Voices were not matched to the series this one continues (${toAppError(err).message}).`),
      );
      const notes = [...plan.notes.filter((n) => !n.startsWith('Voices')), ...voiceNotes];
      await writeJsonAtomic(this.planFile(planned), { ...plan, notes });
    }
    const parent = await this.parentOf(projectId);
    const lines = await this.partSourceLines(parent);
    const parentPaths = this.deps.store.paths(parent.id);
    const sheet = await fsp.readFile(parentPaths.translationContextJson, 'utf8').catch(() => undefined);
    const seriesName = seriesNameOf(parent);
    const { total } = partNumbering(parent.series.settings, plan.parts.length);
    // A folder the user chose is shared; the parent's own render folder is not.
    const chosenFolder = path.resolve(parent.outputDir) !== path.resolve(parentPaths.renderDir) ? parent.outputDir : undefined;
    const ids: string[] = [];
    for (const part of plan.parts) {
      const child = await this.deps.projects.createProject({
        name: partName(parent.series.settings.nameTemplate, {
          series: seriesName,
          n: part.index,
          total,
          ...(part.title ? { title: part.title } : {}),
          targetLanguage: parent.settings.targetLanguage,
        }),
        inputVideoPath: parent.inputVideoPath,
        settings: parent.settings,
        ...(chosenFolder ? { outputDir: chosenFolder } : {}),
        linkInputVideo: true,
        ...(parent.source ? { source: parent.source } : {}),
      });
      const paths = this.deps.store.paths(child.id);
      const transcript = partTranscript(lines, part);
      await writeJsonAtomic(paths.sourceJson, { segments: transcript });
      if (sheet) await fsp.writeFile(paths.translationContextJson, sheet, 'utf8');
      const fresh = await this.deps.store.getProject(child.id);
      await this.deps.store.saveProject({
        ...fresh,
        sourceRange: { startMs: part.recapStartMs, endMs: part.endMs },
        series: {
          role: 'part',
          parentId: parent.id,
          index: part.index,
          count: total,
          seriesName,
          ...(part.title ? { title: part.title } : {}),
          ...(part.summary ? { summary: part.summary } : {}),
          recapEndMs: part.startMs - part.recapStartMs,
        },
        ...(parent.mediaInfo ? { mediaInfo: rangedMediaInfo(parent.mediaInfo, { startMs: part.recapStartMs, endMs: part.endMs }) } : {}),
      });
      ids.push(child.id);
    }
    await this.setState(parent.id, 'parts', { partIds: ids });
    return ids;
  }

  /**
   * Queue every part in order (the queue runs as many at once as the machine
   * allows). Finished parts are left alone, and a part already dubbing or
   * waiting keeps its place: a series paused as a whole continues as one,
   * in order (the agent paused and restarted 17 parts one by one, B7). A
   * part paused or stopped on its own (`pausedByUser`) is left too
   * (`held`): only starting that part continues it.
   */
  async startParts(
    projectId: string,
  ): Promise<
    { projectId: string; index: number; started?: boolean; queued?: boolean; waiting?: boolean; done?: boolean; held?: boolean; error?: string }[]
  > {
    const parent = await this.parentOf(projectId);
    const ids = parent.series.partIds?.length ? parent.series.partIds : await this.createParts(projectId);
    // Each part by the number it is shown with (part 49 of a continued series).
    const { offset } = partNumbering(parent.series.settings, ids.length);
    const out = [];
    for (const [i, id] of ids.entries()) {
      const index = offset + i + 1;
      try {
        const part = await this.deps.store.getProject(id).catch(() => undefined);
        const status = part?.status;
        if (status === 'completed') {
          out.push({ projectId: id, index, done: true });
          continue;
        }
        if (status === 'running' || status === 'queued') {
          out.push({ projectId: id, index, ...(status === 'running' ? { started: true } : { queued: true }) });
          continue;
        }
        if (part?.pausedByUser) {
          out.push({ projectId: id, index, held: true });
          continue;
        }
        out.push({ projectId: id, index, ...(await this.deps.start(id)) });
      } catch (err) {
        out.push({ projectId: id, index, error: toAppError(err).message });
      }
    }
    return out;
  }

  /** The number before a series' first part (`partNumberOffset`; 0 for a series that continues none, or a project of no series). */
  async numberOffsetOf(projectId: string): Promise<number> {
    const parent = await this.parentOf(projectId).catch(() => undefined);
    return parent ? partNumbering(parent.series.settings, 0).offset : 0;
  }

  /** The part ids of a series parent ([] for any other project). */
  async partIdsOf(projectId: string): Promise<string[]> {
    const project = await this.deps.store.getProject(projectId);
    return project.series?.role === 'parent' ? (project.series.partIds ?? []) : [];
  }

  /** Pause every part that is dubbing or waiting, in order; returns the ids paused. */
  async pauseParts(projectId: string): Promise<string[]> {
    const pause = this.deps.pause;
    if (!pause) return [];
    const paused: string[] = [];
    for (const id of await this.partIdsOf(projectId)) {
      const status = (await this.deps.store.getProject(id).catch(() => undefined))?.status;
      if (status !== 'running' && status !== 'queued') continue;
      await pause(id);
      paused.push(id);
    }
    return paused;
  }

  /**
   * Make the parts' transcripts again from the series transcript (after the
   * parent's was fixed: speakers re-detected, loops repaired): the same slicing
   * as when they were made, the shared character sheet copied again, stale
   * translation checkpoints moved aside, each rewrite in the part's edit
   * history. `parts`: only these (their numbers as shown), else every part.
   * A part already translated is left alone unless `force` (its translation is
   * then discarded, kept beside as translated.discarded-<time>.json, and its
   * next run continues at the translation). A part waiting in the queue is
   * rebuilt where it waits and keeps its turn; one being dubbed, or worked on
   * in the editor, is never touched, and the answer says why. Followed in the
   * activity list (`series.rebuild`).
   *
   * WHY a subset, in place: the rebuild was all or nothing and skipped queued
   * parts, so the agent of the 27.8-hour series paused the whole queue to
   * rebuild two parts (claude-dubber report, 2026-11-23).
   */
  async rebuildParts(projectId: string, opts: { force?: boolean; parts?: readonly number[] } = {}): Promise<RebuiltPart[]> {
    const parent = await this.parentOf(projectId);
    const ids = parent.series.partIds ?? [];
    if (ids.length === 0) {
      throw new AppErrorException('INVALID_EDIT', 'The parts are not made yet: they are made from the series transcript as it is then.');
    }
    const plan = await this.readPlan(parent);
    if (!plan) throw new AppErrorException('INVALID_EDIT', 'The series has no plan to rebuild its parts from.');
    const { offset } = partNumbering(parent.series.settings, ids.length);
    const numberAt = (i: number): number => plan.parts[i]?.index ?? offset + i + 1;
    let wanted: Set<number> | undefined;
    if (opts.parts?.length) {
      const known = new Set(ids.map((_, i) => numberAt(i)));
      const unknown = opts.parts.filter((n) => !known.has(n));
      if (unknown.length > 0) {
        throw new AppErrorException(
          'INVALID_EDIT',
          `"${seriesNameOf(parent)}" has no part ${partList(unknown)}: its parts are ${numberAt(0)}–${numberAt(ids.length - 1)}.`,
        );
      }
      wanted = new Set(opts.parts);
    }
    const chosen = [...ids.entries()].filter(([i]) => !wanted || wanted.has(numberAt(i)));
    const job = activity.start({
      kind: 'series.rebuild',
      title: said(
        `Rebuilding ${wanted ? `part ${partList([...wanted])}` : 'every part'} of "${seriesNameOf(parent)}" from the series transcript`,
        wanted ? 'activity.text.series-rebuild-some' : 'activity.text.series-rebuild-all',
        { parts: wanted ? partList([...wanted]) : '', name: seriesNameOf(parent) },
      ),
      projectId: parent.id,
    });
    try {
      const lines = await this.partSourceLines(parent);
      const sheet = await fsp.readFile(this.deps.store.paths(parent.id).translationContextJson, 'utf8').catch(() => undefined);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const out: RebuiltPart[] = [];
      for (const [k, [i, id]] of chosen.entries()) {
        job.progress((100 * k) / chosen.length, said(`Part ${numberAt(i)}`, 'activity.text.part-n', { n: numberAt(i) }));
        out.push(await this.rebuildPart(id, plan.parts[i], numberAt(i), lines, sheet, stamp, opts.force === true));
      }
      const rebuilt = out.filter((p) => p.rebuilt).length;
      this.deps.logger?.info(`series ${parent.id}: rebuilt ${rebuilt} of ${out.length} part(s) from the series transcript.`);
      job.done(said(`${rebuilt} of ${out.length} part(s) rebuilt`, 'activity.text.series-rebuilt', { n: rebuilt, total: out.length }));
      return out;
    } catch (err) {
      job.fail(err);
      throw err;
    }
  }

  /** One part of rebuildParts, while the queue starts nothing. */
  private rebuildPart(
    id: string,
    part: SeriesPlanPart | undefined,
    index: number,
    lines: readonly TranscriptSegment[],
    sheet: string | undefined,
    stamp: string,
    force: boolean,
  ): Promise<RebuiltPart> {
    return this.hold(async (): Promise<RebuiltPart> => {
      const project = await this.deps.store.getProject(id).catch(() => undefined);
      if (!part || !project) return { projectId: id, index, rebuilt: false, skipped: 'missing', reason: 'not found' };
      const work = this.workOn(id, project);
      if (work && work !== 'queued') return { projectId: id, index, rebuilt: false, skipped: 'running', reason: WORK_NOW[work] };
      // On record as queued while not in the queue yet (the app just started): left queued too.
      const queued = work === 'queued' || project.status === 'queued';
      const paths = this.deps.store.paths(id);
      const translated = await fsp.stat(paths.translatedJson).then((s) => s.size > 0, () => false);
      if (translated && !force) return { projectId: id, index, rebuilt: false, skipped: 'translated', reason: 'already translated' };
      // Queued to redo only later steps: its turn was weighed for that work, not a translation.
      const fromStep = project.queue?.fromStep;
      if (translated && queued && fromStep && pipelineStepIndex(fromStep) > pipelineStepIndex('translation')) {
        return {
          projectId: id,
          index,
          rebuilt: false,
          skipped: 'running',
          reason: `is waiting in the queue to redo its dub from "${fromStep}": take it out of the queue (pause it), then rebuild it`,
        };
      }
      const old = await this.rawLines(paths.sourceJson);
      const transcript = partTranscript(lines, part);
      const moveAside = async (file: string, suffix: string): Promise<void> => {
        if (await fsp.stat(file).then(() => true, () => false)) {
          await fsp.rename(file, file.replace(/\.json$/, `.${suffix}-${stamp}.json`)).catch(() => undefined);
        }
      };
      await moveAside(paths.translationCheckpointJson, 'stale');
      await moveAside(paths.refineCheckpointJson, 'stale');
      if (translated) await moveAside(paths.translatedJson, 'discarded');
      await writeJsonAtomic(paths.sourceJson, { segments: transcript });
      if (sheet) await writeJsonAtomic(paths.translationContextJson, JSON.parse(sheet) as unknown);
      if (translated) {
        // Translated, voiced and rendered again from the new lines on its next
        // run (seriesRedo.ts); a queued one keeps its turn and does the same.
        await this.deps.store.savePipeline(redoFrom(await this.deps.store.getPipeline(id), 'translation'));
        if (!queued) {
          const fresh = await this.deps.store.getProject(id);
          if (fresh.status !== 'paused') await this.deps.store.saveProject({ ...fresh, status: 'paused' });
        }
      }
      // The part's history: an id diff when its lines kept their ids, else the whole part as a range.
      const sameIds = old.length === transcript.length && old.every((l, k) => l.id === transcript[k]!.id);
      await recordEdit({
        projectId: id,
        target: 'source',
        summary: `Rebuilt from the series transcript: ${old.length} → ${transcript.length} line(s)${translated ? '; its translation was set aside' : ''}`,
        summaryKey: translated ? 'history.summary.rebuilt-set-aside' : 'history.summary.rebuilt',
        summaryParams: { from: old.length, to: transcript.length },
        ...(sameIds ? {} : { range: { fromMs: 0, toMs: Math.max(part.endMs - part.recapStartMs, old.at(-1)?.endMs ?? 0) } }),
        before: old,
        after: transcript,
      });
      return {
        projectId: id,
        index,
        rebuilt: true,
        ...(queued ? { queued: true } : {}),
        ...(translated ? { translationDiscarded: true } : {}),
        oldLines: old.length,
        newLines: transcript.length,
        speakers: new Set(transcript.map((l) => l.speakerId).filter(Boolean)).size,
      };
    });
  }

  /**
   * Rename a part, or change its title or summary, after it was made, keeping
   * everything it has done (PATCH /projects/:id/series-part, MCP edit_part).
   * In a chosen folder its files follow a new name, those already rendered
   * too. A name the series' template made follows a new title (when the
   * template uses {title}); a name the user chose stays. A new title on a
   * part already rendered sets it to render again, since the title card is
   * drawn by the render: it pauses at Render, and Continue or start_series
   * renders it, nothing else. Refused while it is being dubbed; a part waiting
   * in the queue is changed where it waits and keeps its turn.
   *
   * WHY: once the parts existed nothing renamed them or fixed a title:
   * PUT /projects/:id resets the pipeline and works only before the first run
   * (claude-dubber report, 2026-11-23).
   */
  async editPart(partId: string, edit: { name?: string; title?: string; summary?: string }): Promise<EditedPart> {
    const project = await this.deps.store.getProject(partId);
    if (project.series?.role !== 'part') {
      throw new AppErrorException('INVALID_EDIT', `"${project.name}" is not a part of a series.`, {
        remediation: 'Before the parts are made, change their titles in the plan (the series page, or set_split_plan).',
      });
    }
    const name = edit.name?.trim();
    const title = edit.title?.trim();
    const summary = edit.summary?.trim();
    if (edit.name !== undefined && !name) throw new AppErrorException('INVALID_EDIT', 'A part needs a name.');
    if ((name?.length ?? 0) > 200) throw new AppErrorException('INVALID_EDIT', 'A part name has at most 200 characters.');
    if ((title?.length ?? 0) > 120) throw new AppErrorException('INVALID_EDIT', 'A part title has at most 120 characters.');
    if ((summary?.length ?? 0) > 600) throw new AppErrorException('INVALID_EDIT', 'A part summary has at most 600 characters.');
    return this.hold(async (): Promise<EditedPart> => {
      const current = await this.deps.store.getProject(partId);
      const info = current.series as SeriesPartInfo;
      const work = this.workOn(partId, current);
      if (work && work !== 'queued') {
        throw new AppErrorException('RUN_IN_PROGRESS', `Part ${info.index} ${WORK_NOW[work]}.`, {
          remediation: 'Change it once that is done, or pause it first.',
        });
      }
      const queued = work === 'queued' || current.status === 'queued';
      const titleChanged = title !== undefined && title !== (info.title ?? '');
      let nextName = name;
      if (nextName === undefined && titleChanged) {
        const parent = await this.deps.store.getProject(info.parentId).catch(() => undefined);
        const template = parent?.series?.role === 'parent' ? parent.series.settings.nameTemplate : undefined;
        const vars = { series: info.seriesName, n: info.index, total: info.count, targetLanguage: current.settings.targetLanguage };
        if (current.name === partName(template, { ...vars, ...(info.title ? { title: info.title } : {}) })) {
          nextName = partName(template, { ...vars, title: title! });
        }
      }
      if (nextName !== undefined && nextName !== current.name) await this.rename(partId, nextName);
      const fresh = await this.deps.store.getProject(partId);
      const nextInfo: SeriesPartInfo = {
        ...(fresh.series as SeriesPartInfo),
        ...(title !== undefined ? { title } : {}),
        ...(summary !== undefined ? { summary } : {}),
      };
      let saved = await this.deps.store.saveProject({ ...fresh, series: nextInfo });
      let renderAgain = false;
      if (titleChanged && !queued) {
        const pipeline = await this.deps.store.getPipeline(partId);
        const rendered =
          stepDone(pipeline, 'render') && (await fsp.stat(projectOutputVideoPath(saved)).then((s) => s.size > 0, () => false));
        if (rendered) {
          await this.deps.store.savePipeline(redoFrom(pipeline, 'render'));
          saved = await this.deps.store.saveProject({ ...(await this.deps.store.getProject(partId)), status: 'paused' });
          renderAgain = true;
        }
      }
      this.deps.logger?.info(`series part ${partId}: ${[nextName !== undefined ? 'renamed' : '', titleChanged ? 'retitled' : '', summary !== undefined ? 'summary changed' : ''].filter(Boolean).join(', ') || 'unchanged'}${renderAgain ? '; renders again' : ''}.`);
      return { project: saved, renderAgain };
    });
  }

  /** Rename a project (its finished files along, when the orchestrator can move them). */
  private async rename(projectId: string, name: string): Promise<void> {
    if (this.deps.renameProject) {
      await this.deps.renameProject(projectId, name);
      return;
    }
    await this.deps.store.saveProject({ ...(await this.deps.store.getProject(projectId)), name });
  }

  /**
   * Refuse a part name template the parts cannot be named with, saying why
   * (POST /projects, /downloads/dub).
   */
  checkNameTemplate(template: string): void {
    const problem = partNameTemplateProblem(template);
    if (!problem) return;
    const why =
      problem.code === 'no-number'
        ? 'it has neither {n} nor {nn}, so every part would have the same name'
        : problem.code === 'unknown-placeholder'
          ? `${problem.placeholder} is not one of its placeholders`
          : problem.code === 'too-long'
            ? `it is longer than ${problem.max} characters`
            : 'it is empty';
    throw new AppErrorException('INVALID_EDIT', `The part name template cannot be used: ${why}.`, {
      remediation: 'Use {series}, {n}, {nn} (two digits), {total} and {title}, e.g. "{series} - Tập {nn}: {title}".',
    });
  }

  /**
   * The series settings a new series is made with (POST /projects): its name
   * template checked, and a series continuing another given that one's name,
   * the numbers after its last part and its template (when it brings none),
   * its own choices kept. Its voices are matched once its speakers are known
   * (matchVoices).
   */
  async prepareSeries(input: SeriesSettings): Promise<SeriesSettings> {
    const { nameTemplate: rawTemplate, continues: rawContinues, ...rest } = input;
    const template = rawTemplate?.trim();
    if (template) this.checkNameTemplate(template);
    const base: SeriesSettings = { ...rest, ...(template ? { nameTemplate: template } : {}) };
    const continues = rawContinues?.trim();
    if (!continues) return base;
    const from = await this.parentOf(continues).catch((err: unknown) => {
      const e = toAppError(err);
      throw new AppErrorException('INVALID_EDIT', e.code === 'INVALID_EDIT' ? e.message : `There is no series "${continues}" to continue.`, {
        remediation: 'Name the series by its project id (or any of its parts\' ids): list_projects, or the series page.',
      });
    });
    const own = from.series.partIds?.length || (await this.readPlan(from))?.parts.length || 0;
    if (own === 0) {
      throw new AppErrorException('INVALID_EDIT', `"${seriesNameOf(from)}" has no parts yet, so it cannot be continued.`, {
        remediation: 'Its parts are planned once its video is analysed: continue it after that.',
      });
    }
    const { offset } = partNumbering(from.series.settings, own);
    const last = offset + own;
    const fromTotal = from.series.settings.totalParts;
    const fromTemplate = from.series.settings.nameTemplate;
    return {
      ...base,
      continues: from.id,
      seriesName: input.seriesName?.trim() || seriesNameOf(from),
      partNumberOffset: input.partNumberOffset ?? last,
      ...(input.totalParts ? { totalParts: input.totalParts } : fromTotal && fromTotal > last ? { totalParts: fromTotal } : {}),
      ...(template ? {} : fromTemplate ? { nameTemplate: fromTemplate } : {}),
    };
  }

  /** Every series with parts made or planned, for a new one to continue (GET /series). */
  async listSeries(): Promise<SeriesListItem[]> {
    const out: SeriesListItem[] = [];
    for (const p of await this.deps.store.listProjects()) {
      if (p.series?.role !== 'parent') continue;
      const parent = p as Project & { series: SeriesParentInfo };
      const own = parent.series.partIds?.length || (await this.readPlan(parent))?.parts.length || 0;
      if (own === 0) continue;
      const { offset, total } = partNumbering(parent.series.settings, own);
      out.push({
        parentId: p.id,
        name: seriesNameOf(parent),
        state: parent.series.state,
        firstNumber: offset + 1,
        lastNumber: offset + own,
        total,
        targetLanguage: p.settings.targetLanguage,
        ...(parent.series.settings.nameTemplate ? { nameTemplate: parent.series.settings.nameTemplate } : {}),
      });
    }
    return out;
  }

  /** The voice per speaker a series uses: its parent's, else its latest part's (applyToParts sets both). */
  private async voiceTableOf(series: Project & { series: SeriesParentInfo }): Promise<{ table: { speakerId: string; voiceId: string }[]; ttsProviderId: string }> {
    if (series.settings.speakerVoices?.length) return { table: series.settings.speakerVoices, ttsProviderId: series.settings.ttsProviderId };
    for (const id of [...(series.series.partIds ?? [])].reverse()) {
      const part = await this.deps.store.getProject(id).catch(() => undefined);
      if (part?.settings.speakerVoices?.length) return { table: part.settings.speakerVoices, ttsProviderId: part.settings.ttsProviderId };
    }
    return { table: [], ttsProviderId: series.settings.ttsProviderId };
  }

  /**
   * A series continuing another: give each speaker here who sounds like one
   * of its speakers (voice prints, seriesContinue.ts) that speaker's voice,
   * when it has no voice of its own yet. The others keep none: the voices for
   * minor speakers are for them. Says what it did in `notes` (each starting
   * "Voices"). Nothing for any other series.
   */
  private async matchVoices(parentId: string, notes: string[]): Promise<void> {
    const parent = await this.parentOf(parentId);
    const fromId = parent.series.settings.continues;
    if (!fromId) return;
    const from = await this.deps.store.getProject(fromId).catch(() => undefined);
    if (from?.series?.role !== 'parent') {
      notes.push(`Voices: the series this one continues (${fromId}) is gone, so none were copied from it.`);
      return;
    }
    const fromSeries = from as Project & { series: SeriesParentInfo };
    const fromName = seriesNameOf(fromSeries);
    const theirs = await this.voiceTableOf(fromSeries);
    if (theirs.table.length === 0) {
      notes.push(`Voices: "${fromName}" has no voice per speaker to copy.`);
      return;
    }
    // A voice id belongs to its engine: another engine here would not know it.
    if (theirs.ttsProviderId !== parent.settings.ttsProviderId) {
      notes.push(`Voices: "${fromName}" was voiced with ${theirs.ttsProviderId}, this series with ${parent.settings.ttsProviderId}, so its voices were not copied.`);
      return;
    }
    const ours = await readSpeakerProfiles(this.deps.store.paths(parent.id).diarizationJson);
    if (ours.length === 0) {
      notes.push(`Voices: no speakers are detected here yet; "${fromName}"'s voices are matched to them by voice once they are (when the parts are made).`);
      return;
    }
    const matches = matchSpeakersByVoice(await readSpeakerProfiles(this.deps.store.paths(from.id).diarizationJson), ours);
    const { table, given } = continuedVoices(parent.settings.speakerVoices, matches, theirs.table);
    if (given.length > 0) {
      const fresh = await this.deps.store.getProject(parent.id);
      const speakerVoices = sanitizeSpeakerVoices(table);
      if (speakerVoices) await this.deps.store.saveProject({ ...fresh, settings: { ...fresh.settings, speakerVoices } });
    }
    const shown = matches.slice(0, 12).map((m) => `${m.ours} = ${m.theirs} there (${m.similarity.toFixed(2)})`);
    const left = ours.filter((s) => !matches.some((m) => m.ours === s.speakerId)).length;
    notes.push(
      `Voices from "${fromName}": ${matches.length} of ${ours.length} speaker(s) here sound like its speakers` +
        `${shown.length > 0 ? ` (${shown.join('; ')}${matches.length > shown.length ? '; …' : ''})` : ''}` +
        `${given.length > 0 ? `, ${given.length} given their voice` : ''}; ${left} left to the voices for minor speakers (cast_voices).`,
    );
  }

  /** The series a project belongs to (it, or its parent), with its parts' progress. */
  async view(projectId: string): Promise<SeriesView> {
    const parent = await this.parentOf(projectId);
    const plan = await this.readPlan(parent);
    const parts: SeriesView['parts'] = [];
    const ids = parent.series.partIds ?? [];
    for (const [i, p] of (plan?.parts ?? []).entries()) {
      const id = ids[i];
      const state = id ? await this.deps.projects.getProjectWithPipeline(id).catch(() => undefined) : undefined;
      const info = state?.project.series?.role === 'part' ? state.project.series : undefined;
      const summary = info?.summary ?? p.summary;
      // Its lines to look at, so each part says it has some (and get_series which).
      const issues = state && this.deps.projects.lineIssues ? await this.deps.projects.lineIssues(state.project.id).catch(() => undefined) : undefined;
      parts.push({
        index: p.index,
        ...(id ? { projectId: id } : {}),
        title: info?.title ?? p.title,
        ...(summary ? { summary } : {}),
        ...(state ? { name: state.project.name } : {}),
        startMs: p.startMs,
        endMs: p.endMs,
        ...(state ? { status: state.project.status, progressPercent: Math.round(state.pipeline.progressPercent) } : {}),
        ...(state?.project.pausedByUser ? { pausedByUser: true } : {}),
        ...(issues && (issues.flagged.length > 0 || issues.overruns.length > 0) ? { issues } : {}),
      });
    }
    const continuesId = parent.series.settings.continues;
    const continued = continuesId ? await this.deps.store.getProject(continuesId).catch(() => undefined) : undefined;
    return {
      parentId: parent.id,
      name: parent.name,
      state: parent.series.state,
      parentStatus: parent.status,
      settings: parent.series.settings,
      ...(plan ? { plan } : {}),
      ...(parent.series.reviewReasons?.length ? { reviewReasons: parent.series.reviewReasons } : {}),
      parts,
      ...(continuesId
        ? {
            continues: {
              parentId: continuesId,
              name: continued?.series?.role === 'parent' ? seriesNameOf(continued as Project & { series: SeriesParentInfo }) : continuesId,
            },
          }
        : {}),
      ...(parent.series.error ? { error: parent.series.error } : {}),
    };
  }
}
