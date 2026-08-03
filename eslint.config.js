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
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,

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
      'scripts/**/*.ts',
      'packages/**/*.ts',
      '**/*.config.{ts,js}',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
