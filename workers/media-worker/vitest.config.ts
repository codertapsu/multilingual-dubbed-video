import { defineConfig } from 'vitest/config';

/**
 * The unit tests here are intentionally ffmpeg-free: they exercise the pure
 * arg-builders and parsers only. No globals; explicit imports from 'vitest'.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
