import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the orchestrator package.
 *
 * Tests are designed to run with NO real workers and NO ffmpeg:
 * everything is injected (MediaService + ProviderRegistry), so the suite
 * is fast and hermetic.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Never the app's own processes. The server tests build the real server,
    // whose readiness probes call the workers' /health; with the default URLs
    // (5101–5103) that is a running VideoDubber's workers on the same machine
    // (a production series ran while 0.18.0 was developed, 2026-11-23). Port 1
    // refuses at once, which the tests already expect of absent workers.
    env: {
      STT_WORKER_URL: 'http://127.0.0.1:1',
      TRANSLATION_WORKER_URL: 'http://127.0.0.1:1',
      TTS_WORKER_URL: 'http://127.0.0.1:1',
      ORCHESTRATOR_URL: 'http://127.0.0.1:1',
    },
  },
});
