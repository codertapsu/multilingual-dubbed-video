/**
 * The first-run self-check, in the user's language.
 *
 * The orchestrator names its checks in English ("Speech-to-text service",
 * "Free disk space") and the screen printed them as they came, with the raw
 * words ok / warn / fail as the verdict: the first screen a Vietnamese user
 * meets read like a log (UX audit, 2026-11-21). Each check is now named and
 * explained by its id; the server's own words stay as the detail line, and a
 * check this table does not know (a newer orchestrator) is shown as the server
 * sent it.
 *
 * Pure (no Angular): setup-checks.spec.ts checks every key against both locales.
 */
import type { PreflightCheck } from '../../core/models/setup';

/** What a check is called, by its id (setup/preflight.ts on the orchestrator). */
const LABEL: Readonly<Record<string, string>> = {
  ffmpeg: 'onboarding.check.ffmpeg',
  ffprobe: 'onboarding.check.ffprobe',
  'stt-worker': 'onboarding.check.stt-worker',
  'translation-worker': 'onboarding.check.translation-worker',
  'tts-worker': 'onboarding.check.tts-worker',
  network: 'onboarding.check.network',
  disk: 'onboarding.check.disk',
};

/** What to do about a check that is not ok, by id and verdict. */
const FIX: Readonly<Record<string, Partial<Record<PreflightCheck['status'], string>>>> = {
  ffmpeg: { fail: 'onboarding.check.media-tool-fix' },
  ffprobe: { fail: 'onboarding.check.media-tool-fix' },
  'stt-worker': { fail: 'onboarding.check.service-fix' },
  'translation-worker': { fail: 'onboarding.check.service-fix' },
  'tts-worker': { fail: 'onboarding.check.service-fix' },
  network: { warn: 'onboarding.check.network-fix', fail: 'onboarding.check.network-fix' },
  disk: { warn: 'onboarding.check.disk-fix', fail: 'onboarding.check.disk-fix' },
};

export interface SetupCheckView {
  id: string;
  status: PreflightCheck['status'];
  /** The check's name as a translation key, or null to show `label` as sent. */
  labelKey: string | null;
  label: string;
  /** What to do, as a translation key, or null to show `remediation` as sent. */
  fixKey: string | null;
  remediation?: string;
  /** The server's own words ("12.3 GB free", the ffmpeg version). */
  detail?: string;
}

export function setupCheckView(check: PreflightCheck): SetupCheckView {
  const known = Object.prototype.hasOwnProperty.call(LABEL, check.id);
  const fixKey = check.status === 'ok' ? null : (FIX[check.id]?.[check.status] ?? null);
  return {
    id: check.id,
    status: check.status,
    labelKey: known ? (LABEL[check.id] ?? null) : null,
    label: check.label,
    fixKey,
    // The server's advice, in English, only when there is no sentence of ours.
    ...(check.status !== 'ok' && !fixKey && check.remediation ? { remediation: check.remediation } : {}),
    ...(check.detail ? { detail: check.detail } : {}),
  };
}

/** Every key this module can return (checked by the spec). */
export const SETUP_CHECK_KEYS: readonly string[] = [
  ...Object.values(LABEL),
  ...new Set(
    Object.values(FIX)
      .flatMap((byStatus) => Object.values(byStatus))
      .filter((key): key is string => typeof key === 'string'),
  ),
];
