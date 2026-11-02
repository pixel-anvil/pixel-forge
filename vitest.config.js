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

// Core packages (NFR-04) are held to 85% line coverage (cli: measured in process; the bundle tests add none). To enforce another package, add it to this list.
const COVERED = ['png', 'schema', 'color', 'raster', 'rig', 'core', 'io', 'ops', 'server', 'cli'];
const LINES = 85;
// Shared CI runners under coverage pass the 5 s default on image-heavy tests (TEST-01).
const TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    projects: packages.map((name) => ({
      test: {
        name,
        root: `packages/${name}`,
        include: ['test/**/*.test.ts'],
        testTimeout: TEST_TIMEOUT_MS,
      },
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
