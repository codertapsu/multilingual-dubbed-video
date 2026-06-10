// Flat ESLint config for the VideoDubber monorepo.
//
// Uses typescript-eslint's recommended preset. Rules are kept pragmatic
// for an early-stage project: `no-explicit-any` is a warning (not an
// error) so it surfaces without blocking iteration.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Globally ignored paths (build artifacts, deps, generated, Rust).
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      'apps/desktop/src-tauri/**',
      'apps/desktop/.angular/**',
      '**/*.d.ts',
    ],
  },

  // Base JS + TS recommended rules.
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // Project-wide rule tweaks.
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },

  // Tests may be a bit looser.
  {
    files: ['**/*.spec.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
