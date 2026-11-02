// Usage: pnpm fixtures | pnpm fixtures:check
import { URL, fileURLToPath } from 'node:url';
import { checkFixtures, runFixtures } from '../dist/fixtures.js';

const root = fileURLToPath(new URL('../../../fixtures', import.meta.url));
try {
  if (process.argv.includes('--check')) {
    const problems = await checkFixtures({ root });
    if (problems.length > 0) {
      console.error(
        `fixtures out of date (run \`pnpm fixtures\` and commit):\n  ${problems.join('\n  ')}`,
      );
      process.exit(1);
    }
    console.log('fixtures up to date');
  } else {
    const files = await runFixtures({ root, onGenerator: (f) => console.log(`generate ${f}`) });
    console.log(
      `wrote ${files.length} file(s):\n${files.map((f) => `  fixtures/${f}`).join('\n')}`,
    );
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
