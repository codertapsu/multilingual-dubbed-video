/**
 * The subtitles a site published for a downloaded video (Bilibili CC, or its
 * AI subtitles), as the project's transcript instead of speech-to-text
 * (`settings.useSourceSubtitles`). On a long video that saves the longest
 * step; the lines then go through the same timing fixes a transcript does.
 */
import fsp from 'node:fs/promises';

import type { Project, TranscriptSegment } from '@videodubber/shared';

import { partTranscript } from '../../series/seriesPlanner.js';

/** `ai-zh`, `zh-CN`, `zh-Hans` → `zh`. Pure. */
export function baseLanguage(code: string): string {
  return code.toLowerCase().replace(/^ai-/, '').split('-')[0] ?? '';
}

/** Bilibili's subtitle JSON (`{ body: [{ from, to, content }] }`, seconds) as transcript lines. Pure. */
export function bilibiliSubtitleLines(raw: unknown): TranscriptSegment[] {
  const body = (raw as { body?: { from?: unknown; to?: unknown; content?: unknown }[] })?.body;
  if (!Array.isArray(body)) return [];
  return body
    .flatMap((b) => {
      const from = Number(b.from);
      const to = Number(b.to);
      const text = typeof b.content === 'string' ? b.content.replace(/\s+/g, ' ').trim() : '';
      return Number.isFinite(from) && Number.isFinite(to) && to > from && text ? [{ startMs: Math.round(from * 1000), endMs: Math.round(to * 1000), sourceText: text }] : [];
    })
    .sort((a, b) => a.startMs - b.startMs)
    .map((l, i) => ({ id: `seg_${String(i + 1).padStart(4, '0')}`, index: i, ...l }));
}

/**
 * The transcript from the site's subtitles in the project's spoken language
 * (any track when that is "detect"), preferring the uploader's over the AI's;
 * undefined when there is none. A series part (`sourceRange`) gets the lines
 * of its own stretch on its own clock: its audio starts at the range's start,
 * and the whole video's lines would land everywhere but where they are spoken.
 */
export async function siteTranscript(
  project: Pick<Project, 'source' | 'settings' | 'sourceRange'>,
): Promise<{ segments: TranscriptSegment[]; language: string; label: string } | undefined> {
  const tracks = project.source?.subtitles ?? [];
  if (tracks.length === 0) return undefined;
  const want = baseLanguage(project.settings.sourceLanguage || '');
  const matching = tracks.filter((t) => !want || baseLanguage(t.language) === want).sort((a, b) => Number(a.ai) - Number(b.ai));
  for (const track of matching) {
    try {
      const all = bilibiliSubtitleLines(JSON.parse(await fsp.readFile(track.path, 'utf8')));
      const range = project.sourceRange;
      const segments = range ? partTranscript(all, { recapStartMs: range.startMs, endMs: range.endMs }) : all;
      if (segments.length > 0) return { segments, language: baseLanguage(track.language), label: track.label };
    } catch {
      /* moved or unreadable: the next one, or speech-to-text */
    }
  }
  return undefined;
}
