// Runs the committed generators: `node scripts/gen.mjs` writes their outputs, `--check` only verifies
// that the committed files are up to date (exit 1 if any is stale). Wired to `pnpm gen` / `pnpm gen:check`,
// the latter being part of `pnpm verify`.
//
// Generators registered so far:
//   - packages/raster/scripts/gen-trig-table.mjs  -> packages/raster/src/trig-table.ts (T1.6)
// T5.1 adds op-registry generation (docs, JSON Schemas, CLI and MCP tool tables); register it below.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATORS = ['packages/raster/scripts/gen-trig-table.mjs'];

const check = process.argv.includes('--check');
let failed = false;
for (const script of GENERATORS) {
  const args = [join(root, script), ...(check ? ['--check'] : [])];
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: root });
  if (r.status !== 0) {
    failed = true;
    console.error(`[gen${check ? ':check' : ''}] ${script} failed (exit ${String(r.status)})`);
  }
}
process.exit(failed ? 1 : 0);
