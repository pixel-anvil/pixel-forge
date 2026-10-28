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

/** Rules shared by the pure packages and by `io`'s pure files. */
const PURE_RULES = {
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
      patterns: [{ group: nodeBuiltins, message: 'Pure packages must not import Node built-ins.' }],
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.check/**',
      'node_modules/**',
      'spikes/**',
      'fixtures/**',
      '.claude/**',
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
    rules: PURE_RULES,
  },
  {
    // io is pure except its Node entry point (`@pixel-forge/io/node`, src/node.ts).
    files: ['packages/io/src/**/*.ts'],
    ignores: ['packages/io/src/node.ts'],
    rules: {
      'no-restricted-properties': PURE_RULES['no-restricted-properties'],
      'no-restricted-imports': PURE_RULES['no-restricted-imports'],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'io is pure: only src/node.ts may use Node globals.' },
        { name: 'Buffer', message: 'io is pure: only src/node.ts may use Node globals.' },
      ],
    },
  },
  {
    // testkit indexes pixel buffers in tight loops; noUncheckedIndexedAccess makes `!` the readable choice.
    files: ['packages/testkit/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
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
