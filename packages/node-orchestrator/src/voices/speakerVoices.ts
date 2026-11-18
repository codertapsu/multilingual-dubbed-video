/**
 * A voice for every speaker of a project's video, in one go.
 *
 * The user agrees once to the source-video statement ("I have the right to use
 * the voices in this video"), which covers every voice in it; then each
 * speaker's best lines (sourceVoices.speakerLineRanges) are analysed, the
 * proposed window is used as is, and the voice is made and assigned to that
 * speaker. A speaker with too little clear speech is skipped, and said so: it
 * keeps the project voice, and the user can still pick lines by hand.
 *
 * Only a person reaches this (the app's Speakers panel); no MCP tool does.
 */
import { AppErrorException, isSpeakerId, summarizeSpeakers, type VoiceProfile, type VoiceReferencePolicy } from '@videodubber/shared';
import { acceptConsent, type ConsentInput } from './consent.js';
import type { VoiceProfileService } from './profileService.js';
import { analyzeProjectSource, readProjectLines, type SourceVoiceDeps } from './sourceVoices.js';

export interface SpeakerVoicesDeps {
  source: SourceVoiceDeps;
  service: VoiceProfileService;
  /** Give each speaker its new voice (merged into the project's speakerVoices). */
  assign: (projectId: string, assignments: { speakerId: string; voiceId: string }[]) => Promise<void>;
}

export interface SpeakerVoicesInput {
  consent: ConsentInput;
  engine?: string;
  /** Which speakers (default: every speaker in the transcript). */
  speakerIds?: string[];
  /** A name per speaker, in the user's language ("Người nói 1"). */
  names?: Record<string, string>;
}

export interface SpeakerVoicesResult {
  made: { speakerId: string; profile: VoiceProfile }[];
  skipped: { speakerId: string; reason: 'too-short' | 'failed'; speechMs?: number; message?: string }[];
}

export async function makeSpeakerVoices(
  deps: SpeakerVoicesDeps,
  projectId: string,
  policy: VoiceReferencePolicy,
  input: SpeakerVoicesInput,
  signal?: AbortSignal,
): Promise<SpeakerVoicesResult> {
  // The statement first: nothing is analysed or made without it.
  acceptConsent(input.consent, 'project');
  if (input.consent.relation !== 'source-video') {
    throw new AppErrorException('VOICE_CONSENT_REQUIRED', "Confirm that you may use the voices in this project's video.");
  }
  const audio = await deps.source.projectAudio(projectId);
  const lines = audio ? await readProjectLines(audio.transcriptPath) : [];
  const wanted = input.speakerIds?.filter(isSpeakerId);
  const speakers = summarizeSpeakers(lines).filter((s) => !wanted || wanted.includes(s.speakerId));
  if (speakers.length === 0) {
    throw new AppErrorException(
      'VOICE_REFERENCE_REJECTED',
      'This transcript has no speakers yet. Turn on speaker detection and re-dub from speech-to-text, or set who says each line in the editor.',
    );
  }

  const result: SpeakerVoicesResult = { made: [], skipped: [] };
  for (const speaker of speakers) {
    if (signal?.aborted) break;
    try {
      const analysis = await analyzeProjectSource(deps.source, projectId, policy, { speakerId: speaker.speakerId }, signal);
      if (analysis.checks.warnings.includes('too-short')) {
        result.skipped.push({ speakerId: speaker.speakerId, reason: 'too-short', speechMs: analysis.checks.speechMs });
        continue;
      }
      const name = input.names?.[speaker.speakerId]?.trim().slice(0, 80) || `Speaker ${Number(speaker.speakerId.slice(8)) + 1}`;
      const profile = await deps.service.create({
        analysisId: analysis.analysisId,
        window: analysis.window,
        name,
        consent: input.consent,
        keepRecording: true,
        denoise: true,
        ...(input.engine ? { engine: input.engine } : {}),
      });
      result.made.push({ speakerId: speaker.speakerId, profile });
    } catch (err) {
      if (signal?.aborted) break;
      result.skipped.push({
        speakerId: speaker.speakerId,
        reason: 'failed',
        message: err instanceof AppErrorException ? err.appError.message : err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (result.made.length > 0) {
    await deps.assign(
      projectId,
      result.made.map((m) => ({ speakerId: m.speakerId, voiceId: m.profile.id })),
    );
  }
  return result;
}
