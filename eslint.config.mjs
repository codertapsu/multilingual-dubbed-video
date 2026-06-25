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
      '**/.venv/**',
      '**/__pycache__/**',
      'scripts/package/**',
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

  // Plain Node scripts/configs (.mjs/.cjs/.js). TypeScript files get their
  // global resolution from the TS compiler, so `no-undef` is off there — but
  // these JS files need Node's globals declared or `no-undef` flags `console`,
  // `process`, etc.
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'writable',
        require: 'readonly',
        exports: 'writable',
        global: 'readonly',
      },
    },
  },
);
