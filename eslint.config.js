import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/cdk.out/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'localNotes/**',
      '.claude/worktrees/**', // gitignored sibling worktrees — other branches' code, not ours to lint
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // The browser extension ships as plain classic scripts with no build (content scripts, the background
  // page, the options page) — each one's top level is a script, not a module.
  {
    files: ['extension/src/**/*.js', 'extension/test/fixtures/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        module: 'readonly',
        require: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['extension/test/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Browser app (React)
  {
    files: ['app/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Node-side code (lambdas, cdk, scripts, shared, config files)
  {
    files: [
      'lambdas/**/*.ts',
      'cdk/**/*.ts',
      'scripts/**/*.{ts,mjs}',
      'packages/**/*.ts',
      '**/*.config.{ts,js}',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Tests + test utilities aren't hot-reloaded — the fast-refresh rule doesn't apply.
  {
    files: ['**/*.test.{ts,tsx}', 'app/src/test/**'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
);
