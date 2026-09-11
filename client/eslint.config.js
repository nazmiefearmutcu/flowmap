// Flat ESLint config for the FlowMap client (Campaign 4, lane E3).
//
// Curated intentionally: typescript-eslint *recommended* (non-type-checked)
// plus react-hooks' flat recommended preset. Type-aware rules are out of scope
// — `tsc -b` is the type gate — so this adds cheap hygiene on top: unused
// vars/imports, hook dependency correctness, and the TS recommended set.
// No stylistic/formatting rules (no import sorting, no quote rules).
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // Generated / artifact / vendored trees are never linted.
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'tests/e2e/__artifacts__/**',
      'test-results/**',
      'perf_report.json',
    ],
  },

  // Base TS hygiene for every source, test and config file.
  ...tseslint.configs.recommended,

  // React hooks. eslint-plugin-react-hooks v7's `recommended-latest` bundles
  // the React Compiler diagnostics (react-hooks/refs, /set-state-in-effect,
  // /preserve-manual-memoization, /immutability, ...). Those flag 40+ existing
  // patterns across files this lane must not touch (client/src/App.tsx and
  // friends) and fixing them is a behavior-level rewrite, not lint tooling —
  // so the gate keeps the two classic correctness rules and leaves the
  // compiler-rules migration as a documented follow-up (lane-E3.md).
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Browser globals for the app and its jsdom tests; Node globals for the
  // tooling side (vite/vitest/playwright configs, scripts/*.mjs).
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['*.{js,mjs,cjs,ts}', 'scripts/**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
  },

  // Rule curation for the pre-existing tree (evidence in lane-E3.md):
  // - unused vars: allow the conventional `_`-prefixed deliberate ignores.
  // - `any`: survey #2 verified 0 real `any` in src/; the few survivors are
  //   test stubs. Keep the rule visible as a warning (never fails the gate).
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
