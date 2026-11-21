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
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  AppErrorException,
  toAppError,
  type CreateProjectInput,
  type PipelineState,
  type Project,
  type RunScheduleResult,
  type SeriesParentInfo,
  type SeriesPlan,
  type SeriesState,
  type SeriesReviewReason,
  type SeriesView,
  type TranscriptSegment,
  type TranslationDocContext,
} from '@videodubber/shared';

import { languageName } from '../providers/translation/llmTranslationProvider.js';
import { generateCharacterSheet, type AnalysisChat } from '../providers/translation/translationContext.js';
import { writeJsonAtomic, type ProjectStore } from '../workspace/projectStore.js';
import { aiChooseCut, aiTitlePart, type SeriesChat } from './seriesAi.js';
import {
  admissibleWindow,
  boundedWindow,
  candidateCuts,
  cardWords,
  cutWindows,
  fallbackCut,
  MIN_PART_MS,
  partCount,
  partsFromCuts,
  partsOutsideBounds,
  partTranscript,
  validateCuts,
  type CutWindow,
} from './seriesPlanner.js';
import { rangedMediaInfo } from './seriesRange.js';
import { sanitizeSeriesSettings } from './seriesSanitize.js';

export { sanitizeSeriesSettings };

export interface SeriesServiceDeps {
  store: ProjectStore;
  projects: {
    createProject(input: CreateProjectInput): Promise<Project>;
    getProjectWithPipeline(projectId: string): Promise<{ project: Project; pipeline: PipelineState }>;
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
  pause?: (projectId: string) => Promise<void>;
  /** Something is working on this project now (Orchestrator.busyProjects). */
  isBusy?: (projectId: string) => boolean;
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
  return reasons;
}

/** What rebuilding one part did (rebuildParts). */
export interface RebuiltPart {
  projectId: string;
  index: number;
  rebuilt: boolean;
  /** Why it was left as it was. */
  skipped?: 'running' | 'translated' | 'missing';
  oldLines?: number;
  newLines?: number;
  speakers?: number;
}

export class SeriesService {
  private readonly busy = new Set<string>();

  constructor(private readonly deps: SeriesServiceDeps) {}

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

  /** The parent has transcribed the video: plan the parts (and make and start them when asked to). */
  async analysed(parentId: string): Promise<void> {
    if (this.busy.has(parentId)) return;
    this.busy.add(parentId);
    try {
      const parent = await this.parentOf(parentId);
      await this.setState(parentId, 'planning');
      // The character sheet first: the part titles use its names.
      await this.sharedSheet(parent).catch((err: unknown) =>
        this.deps.logger?.warn(`series ${parentId}: no shared character sheet (${toAppError(err).message}); each part makes its own.`),
      );
      const plan = await this.makePlan(parent);
      await writeJsonAtomic(this.planFile(parent), plan);
      // Start by itself only from a clean analysis (the user's call, 2026-11-21):
      // otherwise stop at review and say why.
      const pipeline = parent.series.settings.autoStart
        ? (await this.deps.projects.getProjectWithPipeline(parentId).catch(() => undefined))?.pipeline
        : undefined;
      const reasons = parent.series.settings.autoStart ? seriesReviewReasons(parent, pipeline) : [];
      if (parent.series.settings.autoStart && reasons.length === 0) {
        await this.createParts(parentId);
        await this.startParts(parentId);
      } else {
        if (reasons.length > 0) this.deps.logger?.warn(`series ${parentId}: stopped at review: ${reasons.map((r) => r.message).join(' ')}`);
        await this.setState(parentId, 'review', reasons.length > 0 ? { reviewReasons: reasons } : {});
      }
    } catch (err) {
      await this.setState(parentId, 'failed', { error: toAppError(err) }).catch(() => undefined);
    } finally {
      this.busy.delete(parentId);
    }
  }

  private async makePlan(parent: Project & { series: SeriesParentInfo }): Promise<SeriesPlan> {
    const lines = await this.lines(parent);
    const settings = parent.series.settings;
    const durationMs = parent.mediaInfo?.durationMs || lines.at(-1)?.endMs || 0;
    const chapters = (parent.source?.chapters ?? []).map((c) => c.startMs);
    const notes: string[] = [];
    const count = partCount(durationMs, settings.minMinutes, settings.maxMinutes);
    let candidates = candidateCuts(lines, { chapters });
    let windows = cutWindows(durationMs, count, settings, candidates);
    // A cut on a change of shot reads as a chapter, inside one shot as an
    // interruption: measured around the best pauses only, then ranked again.
    const scenes = await this.sceneChangesNear(parent, windows, candidates, notes);
    if (scenes.length > 0) {
      candidates = candidateCuts(lines, { chapters, scenes });
      windows = cutWindows(durationMs, count, settings, candidates);
    }
    const chat = this.deps.chatFor(settings.aiProviderId);
    if (!chat) notes.push(`The AI "${settings.aiProviderId}" is not available here: the longest pauses near each target were used.`);
    const seriesName = parent.name;
    const sourceLanguageName = languageName(parent.settings.sourceLanguage || 'auto');
    const minMs = settings.minMinutes * 60_000;
    const maxMs = Math.max(minMs, settings.maxMinutes * 60_000);
    const cuts: { ms: number; by: 'ai' | 'pause' }[] = [];
    let previous = 0;
    for (const spread of windows) {
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
      cuts.push(chosen);
      previous = chosen.ms;
    }
    const parts = partsFromCuts(durationMs, cuts, settings.recapSec, lines);
    for (const p of partsOutsideBounds(parts, settings.minMinutes, settings.maxMinutes)) {
      notes.push(
        `Part ${p.index} is ${p.minutes.toFixed(1)} min, outside ${settings.minMinutes}–${settings.maxMinutes} min: ` +
          'the video does not split into parts of that length at its pauses. Move the cuts (set_split_plan) to change it.',
      );
    }
    if (chat) {
      const targetLanguageName = languageName(parent.settings.targetLanguage);
      const names = await this.sheetNames(parent);
      for (const part of parts) {
        try {
          const named = await aiTitlePart(chat, part, parts.length, lines, { seriesName, sourceLanguageName, targetLanguageName, names });
          if (named) Object.assign(part, named);
        } catch (err) {
          notes.push(`Part ${part.index}: no title from the AI (${toAppError(err).message}).`);
        }
      }
    }
    return { aiProviderId: settings.aiProviderId, parts, candidates, createdAt: new Date().toISOString(), notes };
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
      segments: lines.map((l) => ({ id: l.id, sourceText: l.sourceText, startMs: l.startMs, endMs: l.endMs })),
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
    const durationMs = parent.mediaInfo?.durationMs || plan.parts.at(-1)?.endMs || 0;
    const current = plan.parts.slice(1).map((p) => p.startMs);
    let cuts = current;
    if (edit.cuts) {
      const checked = validateCuts(edit.cuts, durationMs);
      if (!checked.ok) throw new AppErrorException('INVALID_EDIT', checked.reason);
      cuts = checked.cuts;
    }
    const byOf = (ms: number): 'ai' | 'pause' | 'manual' => {
      const same = plan.parts.slice(1).find((p) => Math.abs(p.startMs - ms) < 500);
      return same && same.cutBy !== 'start' ? same.cutBy : 'manual';
    };
    const titles = edit.titles ?? (cuts === current ? plan.parts.map((p) => ({ title: p.title, summary: p.summary })) : []);
    const parts = partsFromCuts(durationMs, cuts.map((ms) => ({ ms, by: byOf(ms) })), parent.series.settings.recapSec, lines, titles);
    const next: SeriesPlan = { ...plan, parts };
    await writeJsonAtomic(this.planFile(parent), next);
    return next;
  }

  /** A project per part of the plan, once. */
  async createParts(projectId: string): Promise<string[]> {
    const parent = await this.parentOf(projectId);
    if (parent.series.partIds?.length) return parent.series.partIds;
    const plan = await this.readPlan(parent);
    if (!plan) throw new AppErrorException('INVALID_EDIT', 'The video is still being analysed; the parts come when it is done.');
    const lines = await this.lines(parent);
    const parentPaths = this.deps.store.paths(parent.id);
    const sheet = await fsp.readFile(parentPaths.translationContextJson, 'utf8').catch(() => undefined);
    const words = cardWords(parent.settings.targetLanguage);
    // A folder the user chose is shared; the parent's own render folder is not.
    const chosenFolder = path.resolve(parent.outputDir) !== path.resolve(parentPaths.renderDir) ? parent.outputDir : undefined;
    const ids: string[] = [];
    for (const part of plan.parts) {
      const child = await this.deps.projects.createProject({
        name: `${parent.name} - ${words.part === '第' ? `第${part.index}集` : `${words.part} ${String(part.index).padStart(2, '0')}`}`,
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
          count: plan.parts.length,
          seriesName: parent.name,
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
   * in order (the agent paused and restarted 17 parts one by one, B7).
   */
  async startParts(
    projectId: string,
  ): Promise<{ projectId: string; started?: boolean; queued?: boolean; waiting?: boolean; done?: boolean; error?: string }[]> {
    const parent = await this.parentOf(projectId);
    const ids = parent.series.partIds?.length ? parent.series.partIds : await this.createParts(projectId);
    const out = [];
    for (const id of ids) {
      try {
        const status = (await this.deps.store.getProject(id).catch(() => undefined))?.status;
        if (status === 'completed') {
          out.push({ projectId: id, done: true });
          continue;
        }
        if (status === 'running' || status === 'queued') {
          out.push({ projectId: id, ...(status === 'running' ? { started: true } : { queued: true }) });
          continue;
        }
        out.push({ projectId: id, ...(await this.deps.start(id)) });
      } catch (err) {
        out.push({ projectId: id, error: toAppError(err).message });
      }
    }
    return out;
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
   * translation checkpoints moved aside. A part already translated is left
   * alone unless `force` (its translation is then discarded, kept beside as
   * translated.discarded-<time>.json); a part being dubbed is never touched.
   */
  async rebuildParts(projectId: string, opts: { force?: boolean } = {}): Promise<RebuiltPart[]> {
    const parent = await this.parentOf(projectId);
    const ids = parent.series.partIds ?? [];
    if (ids.length === 0) {
      throw new AppErrorException('INVALID_EDIT', 'The parts are not made yet: they are made from the series transcript as it is then.');
    }
    const plan = await this.readPlan(parent);
    if (!plan) throw new AppErrorException('INVALID_EDIT', 'The series has no plan to rebuild its parts from.');
    const lines = await this.lines(parent);
    const sheet = await fsp.readFile(this.deps.store.paths(parent.id).translationContextJson, 'utf8').catch(() => undefined);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out: RebuiltPart[] = [];
    for (const [i, id] of ids.entries()) {
      const part = plan.parts[i];
      const index = i + 1;
      const project = await this.deps.store.getProject(id).catch(() => undefined);
      if (!part || !project) {
        out.push({ projectId: id, index, rebuilt: false, skipped: 'missing' });
        continue;
      }
      if (this.deps.isBusy?.(id) || project.status === 'running' || project.status === 'queued') {
        out.push({ projectId: id, index, rebuilt: false, skipped: 'running' });
        continue;
      }
      const paths = this.deps.store.paths(id);
      const translated = await fsp.stat(paths.translatedJson).then((s) => s.size > 0, () => false);
      if (translated && !opts.force) {
        out.push({ projectId: id, index, rebuilt: false, skipped: 'translated' });
        continue;
      }
      const old = await this.lines(project).catch(() => [] as TranscriptSegment[]);
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
      out.push({
        projectId: id,
        index,
        rebuilt: true,
        oldLines: old.length,
        newLines: transcript.length,
        speakers: new Set(transcript.map((l) => l.speakerId).filter(Boolean)).size,
      });
    }
    this.deps.logger?.info(
      `series ${parent.id}: rebuilt ${out.filter((p) => p.rebuilt).length} of ${out.length} part(s) from the series transcript.`,
    );
    return out;
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
      parts.push({
        index: p.index,
        ...(id ? { projectId: id } : {}),
        title: (state?.project.series?.role === 'part' ? state.project.series.title : undefined) ?? p.title,
        startMs: p.startMs,
        endMs: p.endMs,
        ...(state ? { status: state.project.status, progressPercent: Math.round(state.pipeline.progressPercent) } : {}),
      });
    }
    return {
      parentId: parent.id,
      name: parent.name,
      state: parent.series.state,
      parentStatus: parent.status,
      settings: parent.series.settings,
      ...(plan ? { plan } : {}),
      ...(parent.series.reviewReasons?.length ? { reviewReasons: parent.series.reviewReasons } : {}),
      parts,
      ...(parent.series.error ? { error: parent.series.error } : {}),
    };
  }
}
