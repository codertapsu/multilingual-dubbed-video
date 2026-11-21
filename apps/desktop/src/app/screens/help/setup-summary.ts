import type { PreflightCheck, PreflightResult } from '../../core/models/setup';
import type { WorkersHealth } from '../../core/models/view-models';

/**
 * The Help screen in plain words.
 *
 * The self-check and the service list printed what the backend says, which is
 * written for a log: English labels ("Speech-to-text service"), English
 * remediations naming scripts/start-services.sh, service ids such as `stt`,
 * and the pipeline-step words "Completed" / "Failed" for a service that runs
 * (UX audit, 2026-11). This maps what the app knows to i18n keys; the server's
 * own words stay available under "Technical details", because support needs
 * exactly them.
 */

/** The self-check's checks by id (setup/preflight.ts), and their plain names. */
const CHECK_NAMES: Record<string, string> = {
  ffmpeg: 'help.check.ffmpeg',
  ffprobe: 'help.check.ffprobe',
  'stt-worker': 'help.check.stt',
  'translation-worker': 'help.check.translation',
  'tts-worker': 'help.check.tts',
  network: 'help.check.network',
  disk: 'help.check.disk',
};

/** What to do when a check is not ok. */
const CHECK_FIXES: Record<string, string> = {
  ffmpeg: 'help.fix.tools',
  ffprobe: 'help.fix.tools',
  'stt-worker': 'help.fix.service',
  'translation-worker': 'help.fix.service',
  'tts-worker': 'help.fix.service',
  network: 'help.fix.network',
  disk: 'help.fix.disk',
};

/** GET /workers/health's rows: the three services, and the two tools that are files rather than programs left running. */
const SERVICE_NAMES: Record<keyof WorkersHealth, string> = {
  stt: 'help.service.stt',
  translation: 'help.service.translation',
  tts: 'help.service.tts',
  ffmpeg: 'help.service.ffmpeg',
  ffprobe: 'help.service.ffprobe',
};
const TOOLS: ReadonlySet<string> = new Set(['ffmpeg', 'ffprobe']);

export interface CheckView {
  id: string;
  status: PreflightCheck['status'];
  /** The plain name's key, or null for a check this build does not know: show the server's label. */
  nameKey: string | null;
  /** What to do (only when not ok), or null: show the server's remediation. */
  fixKey: string | null;
  /** The server's own words, for Technical details. */
  label: string;
  detail?: string;
  remediation?: string;
}

/** The self-check, ready to show. Pure. */
export function checkViews(result: PreflightResult): CheckView[] {
  return result.checks.map((c) => ({
    id: c.id,
    status: c.status,
    nameKey: CHECK_NAMES[c.id] ?? null,
    fixKey: c.status === 'ok' ? null : (CHECK_FIXES[c.id] ?? null),
    label: c.label,
    ...(c.detail ? { detail: c.detail } : {}),
    ...(c.remediation ? { remediation: c.remediation } : {}),
  }));
}

export interface ServiceView {
  id: string;
  available: boolean;
  /** A tool (FFmpeg) is "Ready / Missing"; a service is "Running / Not running". */
  kind: 'service' | 'tool';
  nameKey: string | null;
  detail?: string;
}

/** The service rows, ready to show. Pure. */
export function serviceViews(health: WorkersHealth): ServiceView[] {
  return (Object.entries(health) as [string, { available: boolean; detail?: string }][]).map(([id, v]) => ({
    id,
    available: v.available,
    kind: TOOLS.has(id) ? 'tool' : 'service',
    nameKey: SERVICE_NAMES[id as keyof WorkersHealth] ?? null,
    ...(v.detail ? { detail: v.detail } : {}),
  }));
}

/**
 * The one line Help leads with: nothing wrong, things to look at, or
 * problems. A warning (offline, a little low on disk) still lets the app
 * work, so it is not counted as a problem: an offline-first app that calls
 * being offline a problem teaches its users to ignore it.
 */
export interface SetupSummary {
  tone: 'ok' | 'warn' | 'fail';
  /** Checks that fail: dubbing cannot work until they are fixed. */
  problems: number;
  /** Checks that warn: the app works, with something to know. */
  warnings: number;
}

/** From the self-check when it ran, else from the service rows; null when neither answered. Pure. */
export function setupSummary(preflight: PreflightResult | null, health: WorkersHealth | null): SetupSummary | null {
  if (preflight) {
    const problems = preflight.checks.filter((c) => c.status === 'fail').length;
    const warnings = preflight.checks.filter((c) => c.status === 'warn').length;
    return { tone: problems > 0 ? 'fail' : warnings > 0 ? 'warn' : 'ok', problems, warnings };
  }
  if (health) {
    const problems = Object.values(health).filter((s) => !s.available).length;
    return { tone: problems > 0 ? 'fail' : 'ok', problems, warnings: 0 };
  }
  return null;
}

/** Every key this module can hand out (the spec checks both locales have them). */
export const SETUP_SUMMARY_KEYS: readonly string[] = [
  ...Object.values(CHECK_NAMES),
  ...new Set(Object.values(CHECK_FIXES)),
  ...Object.values(SERVICE_NAMES),
];
