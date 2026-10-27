import { defineConfig } from 'vitest/config';

const packages = [
  'png',
  'testkit',
  'schema',
  'color',
  'raster',
  'rig',
  'convert',
  'core',
  'lint',
  'io',
  'ops',
  'server',
  'cli',
];

// Core packages (NFR-04) are held to 85% line coverage. To enforce another package, add it to this list.
const COVERED = ['schema', 'color', 'raster', 'rig', 'core'];
const LINES = 85;

export default defineConfig({
  test: {
    projects: packages.map((name) => ({
      test: { name, root: `packages/${name}`, include: ['test/**/*.test.ts'] },
    })),
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      thresholds: Object.fromEntries(
        COVERED.map((p) => [`packages/${p}/src/**`, { lines: LINES }]),
      ),
    },
  },
});
