import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/stardust-results/**',
      '.agents/**',
      'conformance/.varial/**',
      'tests/dapps/.checkouts/**',
      'site/.next/**',
      'site/.source/**',
      'site/out/**',
      'site/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': ['error', { patterns: ['./*', '../*'] }],
    },
  },
  {
    // Playwright fixtures that need no other fixture take {} first.
    files: ['conformance/**/*.ts', 'src/test/**/*.ts'],
    rules: {
      'no-empty-pattern': 'off',
    },
  },
);
