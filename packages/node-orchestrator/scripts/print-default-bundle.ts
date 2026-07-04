/**
 * Build-time bridge: print the bundled-default-models staging plan derived from
 * the single source of truth (src/setup/defaultBundle.ts), so the POSIX staging
 * script (scripts/package/fetch-default-models.sh) and the release-bundle
 * assertion (scripts/package/build-sidecars.sh) consume ONE list without
 * duplicating the pair list or the pivot/voice derivation in bash.
 *
 * Run via tsx (it imports TypeScript workspace source directly):
 *
 *   node_modules/.bin/tsx packages/node-orchestrator/scripts/print-default-bundle.ts [--sh]
 *
 * Prerequisite: packages/shared must be built (dist/), because catalog.ts imports
 * the bare specifier `@videodubber/shared`, which resolves only to its dist. The
 * release build guarantees this by running the orchestrator build before staging.
 *
 * Default output is pretty JSON (for inspection/tests). With `--sh` it prints
 * tab-separated records the shell reads line-by-line:
 *
 *   whisper <model>
 *   argos   <from>  <to>
 *   piper   <id>    <onnxUrl>  <onnxJsonUrl>
 */
// Thin wrapper: all logic (the plan, the DEFAULT_WHISPER_MODEL override, and the
// JSON/--sh serialization) lives in the typechecked + unit-tested defaultBundle.ts,
// so this entry point can't silently drift from the format the shell scripts parse.
import {
  computeDefaultBundlePlan,
  formatBundlePlan,
  withWhisperOverride,
} from '../src/setup/defaultBundle.js';

const plan = withWhisperOverride(computeDefaultBundlePlan(), process.env.DEFAULT_WHISPER_MODEL);
process.stdout.write(formatBundlePlan(plan, process.argv.includes('--sh') ? 'sh' : 'json'));
