import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the desktop UI's PURE modules (timeline math, edit history,
 * time-stretch-free scheduling decisions) — framework-free code that runs in
 * plain Node. Angular components are deliberately out of scope here; the i18n
 * gate (scripts/check-i18n.mjs) still runs first in the `test` script.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
