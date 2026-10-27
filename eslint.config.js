import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const PURE = ['schema', 'color', 'raster', 'rig', 'convert', 'core', 'png'];

const nodeBuiltins = [
  'node:*',
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'readline',
  'stream',
  'stream/*',
  'string_decoder',
  'timers',
  'tls',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.check/**',
      'node_modules/**',
      'spikes/**',
      'fixtures/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['packages/**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: PURE.map((p) => `packages/${p}/src/**/*.ts`),
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Non-deterministic: pure packages must not use Math.random.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Non-deterministic: pure packages must not use Date.now.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: nodeBuiltins, message: 'Pure packages must not import Node built-ins.' },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        module: 'readonly',
        require: 'readonly',
      },
    },
  },
);
