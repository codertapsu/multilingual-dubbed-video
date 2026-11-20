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
  type SeriesView,
  type TranscriptSegment,
} from '@videodubber/shared';

import { languageName } from '../providers/translation/llmTranslationProvider.js';
import { generateCharacterSheet, type AnalysisChat } from '../providers/translation/translationContext.js';
import { writeJsonAtomic, type ProjectStore } from '../workspace/projectStore.js';
import { aiChooseCut, aiTitlePart, type SeriesChat } from './seriesAi.js';
import {
  candidateCuts,
  cardWords,
  cutWindows,
  fallbackCut,
  partCount,
  partsFromCuts,
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
  logger?: { info(message: string): void; warn(message: string): void };
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
    const { error: _old, ...rest } = parent.series;
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
      const plan = await this.makePlan(parent);
      await writeJsonAtomic(this.planFile(parent), plan);
      await this.sharedSheet(parent).catch((err: unknown) =>
        this.deps.logger?.warn(`series ${parentId}: no shared character sheet (${toAppError(err).message}); each part makes its own.`),
      );
      if (parent.series.settings.autoStart) {
        await this.createParts(parentId);
        await this.startParts(parentId);
      } else {
        await this.setState(parentId, 'review');
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
    const cuts: { ms: number; by: 'ai' | 'pause' }[] = [];
    for (const w of windows) {
      let ms: number | undefined;
      if (chat) {
        try {
          ms = await aiChooseCut(chat, w, lines, { seriesName, sourceLanguageName });
          if (ms === undefined) notes.push(`Cut ${w.index}: the AI gave no usable answer; the best pause was used.`);
        } catch (err) {
          notes.push(`Cut ${w.index}: the AI failed (${toAppError(err).message}); the best pause was used.`);
        }
      }
      cuts.push(ms !== undefined ? { ms, by: 'ai' } : { ms: fallbackCut(w), by: 'pause' });
    }
    const parts = partsFromCuts(durationMs, cuts, settings.recapSec, lines);
    if (chat) {
      const targetLanguageName = languageName(parent.settings.targetLanguage);
      for (const part of parts) {
        try {
          const named = await aiTitlePart(chat, part, parts.length, lines, { seriesName, sourceLanguageName, targetLanguageName });
          if (named) Object.assign(part, named);
        } catch (err) {
          notes.push(`Part ${part.index}: no title from the AI (${toAppError(err).message}).`);
        }
      }
    }
    return { aiProviderId: settings.aiProviderId, parts, candidates, createdAt: new Date().toISOString(), notes };
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

  /** Queue every part in order (the queue runs as many at once as the machine allows). */
  async startParts(projectId: string): Promise<{ projectId: string; started?: boolean; queued?: boolean; waiting?: boolean; error?: string }[]> {
    const parent = await this.parentOf(projectId);
    const ids = parent.series.partIds?.length ? parent.series.partIds : await this.createParts(projectId);
    const out = [];
    for (const id of ids) {
      try {
        out.push({ projectId: id, ...(await this.deps.start(id)) });
      } catch (err) {
        out.push({ projectId: id, error: toAppError(err).message });
      }
    }
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
      parts,
      ...(parent.series.error ? { error: parent.series.error } : {}),
    };
  }
}
