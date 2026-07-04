/**
 * Compute the REQUIRED default-pipeline resources a project needs that aren't
 * installed yet — so they can be fetched in the BACKGROUND as soon as the user
 * picks languages, instead of a run hitting a missing model mid-pipeline.
 *
 * It only covers resources the {@link SetupInstaller} itself manages AND records
 * in setup.json, so the "is it installed?" check is reliable (no false-blocking):
 *   - the local faster-whisper model,
 *   - the local Argos source->target pair,
 *   - an explicitly-chosen Piper voice.
 *
 * Cloud / Ollama / engine-pack providers bring their own resources and are
 * handled by their own flows (the readiness gate + lazy install), so they're
 * intentionally skipped here.
 */
import {
  argosPivotLegs,
  type InstalledModels,
  type ProjectSettings,
  type SetupInstallRequest,
} from '@videodubber/shared';
import { recommendedPiperVoice } from './catalog.js';

/** The missing required resources for this project's selected default providers. */
export function computeRequiredResources(
  settings: ProjectSettings,
  installed: InstalledModels,
): SetupInstallRequest {
  const request: SetupInstallRequest = {};

  // STT — the local faster-whisper model (cloud/whisper.cpp bring their own).
  if (settings.sttProviderId === 'faster-whisper') {
    const model = settings.sttModel ?? 'small';
    if (model && !installed.whisperModels.includes(model)) request.whisperModel = model;
  }

  // Translation — the local Argos packages. Argos pivots through English, so a
  // non-English pair (e.g. zh->vi) needs BOTH legs (zh->en, en->vi), not a
  // single direct package Argos doesn't publish.
  if (settings.translationProviderId === 'argos') {
    const legs = argosPivotLegs(settings.sourceLanguage, settings.targetLanguage);
    const missing = legs.filter((l) => !installed.argosPairs.some((p) => p.from === l.from && p.to === l.to));
    if (missing.length > 0) request.argosPairs = missing;
  }

  // TTS — the Piper voice the dub will actually use: the pinned voice, or (when
  // none is pinned) the recommended default voice for the target language that
  // the worker auto-selects. We REQUIRE it so a default dub can never fall
  // through to Piper's silent/fallback engine for want of a downloaded voice.
  if (settings.ttsProviderId === 'piper-local') {
    const voiceId = settings.ttsVoiceId || recommendedPiperVoice(settings.targetLanguage)?.id;
    if (voiceId && !installed.piperVoices.includes(voiceId)) request.piperVoices = [voiceId];
  }

  return request;
}

/** True if the request would actually install something. */
export function hasRequiredResources(request: SetupInstallRequest): boolean {
  return Boolean(
    request.whisperModel ||
      (request.argosPairs?.length ?? 0) > 0 ||
      (request.piperVoices?.length ?? 0) > 0,
  );
}
