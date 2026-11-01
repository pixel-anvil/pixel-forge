// Bundles `pf` into one ESM file with every dependency (workspace packages, the MCP SDK, zod,
// commander) inlined, so it runs from any directory and `pnpm link --global` needs nothing else.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  entry: { pf: 'src/bin.ts' },
  outDir: 'bundle',
  format: ['esm'],
  platform: 'node',
  target: 'node26',
  outExtension: () => ({ js: '.mjs' }),
  noExternal: [/.*/],
  bundle: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  clean: true,
  define: { __PF_VERSION__: JSON.stringify(version) },
  // Some inlined CommonJS packages call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __pfCreateRequire } from 'node:module';\nconst require = __pfCreateRequire(import.meta.url);",
  },
});
