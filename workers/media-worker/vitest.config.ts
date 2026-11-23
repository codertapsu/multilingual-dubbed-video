import { defineConfig } from 'vitest/config';

/**
 * The unit tests here are intentionally ffmpeg-free: they exercise the pure
 * arg-builders and parsers only. The one exception is `*.ffmpeg.test.ts`: tiny
 * generated files through real ffmpeg, where only the real thing can tell
 * (audio on the picture's clock), skipped where ffmpeg is not installed.
 * No globals; explicit imports from 'vitest'.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
