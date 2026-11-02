// Usage: pnpm golden:sheet <name-or-glob> [--scale N]
// Builds .golden-diff/sheet-<name>.png from golden PNGs and/or .golden-diff/* files.
import { URL, fileURLToPath } from 'node:url';
import { buildSheet } from '../dist/sheet-cli.js';

const args = process.argv.slice(2);
let scale = 8;
const i = args.indexOf('--scale');
if (i >= 0) scale = Number(args.splice(i, 2)[1]);
const target = args[0];
if (!target) {
  console.error('usage: pnpm golden:sheet <golden-name-or-glob> [--scale N]');
  process.exit(2);
}
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
try {
  const { out, inputs } = buildSheet(repoRoot, target, scale);
  console.log(
    `sheet: ${out}\n  from ${inputs.length} file(s):\n${inputs.map((f) => `    ${f}`).join('\n')}`,
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
