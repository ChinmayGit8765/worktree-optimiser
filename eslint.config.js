import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * Deliberately the non-type-checked typescript-eslint preset. Type-aware linting
 * would duplicate what `npm run typecheck` already enforces, at several times the
 * runtime, and its extra rules are mostly stylistic. The value here is catching
 * what tsc does not: unused code, floating promises in the obvious cases, and
 * hook misuse in the dashboard.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'apps/manager/public/**',
      'data/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---- shared rules -------------------------------------------------------
  {
    rules: {
      // `_`-prefixed args are an intentional signal that a parameter is unused,
      // usually to keep a positional signature.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Non-null assertions are used deliberately after explicit length/format
      // checks, mostly in parsers where the index is already proven.
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ---- manager, mcp, launcher (node) --------------------------------------
  {
    files: ['apps/manager/**/*.ts', 'apps/mcp/**/*.ts', 'bin/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // ---- dashboard (browser + react) ---------------------------------------
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // ---- tests --------------------------------------------------------------
  {
    files: ['apps/manager/test/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Fixtures legitimately use loose shapes.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // ---- config files -------------------------------------------------------
  {
    files: ['*.js', '*.config.{js,ts}', 'apps/*/vite.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
)
