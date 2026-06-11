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
  toArgosLanguage,
  type InstalledModels,
  type ProjectSettings,
  type SetupInstallRequest,
} from '@videodubber/shared';

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

  // Translation — the local Argos source->target pair.
  if (settings.translationProviderId === 'argos') {
    const from = toArgosLanguage(settings.sourceLanguage);
    const to = toArgosLanguage(settings.targetLanguage);
    if (from && to && from !== to && !installed.argosPairs.some((p) => p.from === from && p.to === to)) {
      request.argosPairs = [{ from, to }];
    }
  }

  // TTS — an explicitly-chosen Piper voice. Auto-select degrades gracefully, so
  // only pre-fetch when the user pinned a specific voice id.
  if (settings.ttsProviderId === 'piper-local' && settings.ttsVoiceId) {
    if (!installed.piperVoices.includes(settings.ttsVoiceId)) request.piperVoices = [settings.ttsVoiceId];
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
