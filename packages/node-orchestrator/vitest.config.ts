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
  },
});
