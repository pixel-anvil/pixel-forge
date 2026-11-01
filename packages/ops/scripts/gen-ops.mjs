// Generator for the op registry outputs (T5.1, spec 6.3, ADR-003):
//   packages/ops/generated/mcp-tools.json   MCP tool definitions
//   packages/ops/generated/cli.json         CLI subcommand metadata
//   docs/contracts/OPERATIONS.md            the operations reference
//
// Usage (from the repo root; `pnpm gen` / `pnpm gen:check` run it through scripts/gen.mjs):
//   node packages/ops/scripts/gen-ops.mjs           write the files
//   node packages/ops/scripts/gen-ops.mjs --check   exit 1 if a committed file is stale
//
// The content comes from `generatedFiles(registry)` in the built package, so the script first runs
// an incremental `tsc -b packages/ops` (a no-op when dist is current). JSON is formatted with the
// repo's prettier config; the Markdown is written as generated (docs/ is prettier-ignored).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const check = process.argv.includes('--check');

// Run tsc's JS entry with this node binary: `.bin/tsc` is a shell shim that Windows cannot spawn.
const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
const build = spawnSync(process.execPath, [tsc, '-b', 'packages/ops'], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) {
  console.error('[gen-ops] tsc -b packages/ops failed');
  process.exit(1);
}

const { generatedFiles, registry } = await import(
  pathToFileURL(join(root, 'packages', 'ops', 'dist', 'index.js')).href
);

async function format(source, file) {
  if (!file.endsWith('.json')) return source;
  const prettier = await import('prettier');
  const options = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(source, { ...options, filepath: file });
}

let stale = 0;
for (const { path, content } of generatedFiles(registry)) {
  const file = join(root, path);
  const out = await format(content, file);
  if (check) {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    if (current !== out) {
      stale++;
      console.error(`[gen-ops] ${path} is stale; run \`pnpm gen\``);
    }
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, out);
    console.log(`[gen-ops] wrote ${path}`);
  }
}
process.exit(stale === 0 ? 0 : 1);
