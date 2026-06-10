import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for @videodubber/shared.
 *
 * Tests live alongside source as `src/**\/*.test.ts` and run in the Node
 * environment. No build step is required because Vitest transpiles TS on the
 * fly via esbuild.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
