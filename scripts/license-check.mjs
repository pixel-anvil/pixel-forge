// Fails when any installed production dependency uses a licence outside the allow-list (NFR-11).
import { execFileSync } from 'node:child_process';

const allowed = [
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'ISC',
  '0BSD',
  'Zlib',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0', // argparse (transitive dev tooling only)
];
// Dev-only exception: lightningcss (MPL-2.0, file-level copyleft) is pulled in by vite/vitest. It is
// never bundled or distributed, so it is excluded here; revisit if it ever reaches a shipped artifact.
const devToolExceptions = ['lightningcss', 'spdx-exceptions', 'spdx-ranges']; // spdx-*: CC-BY-3.0 data used only by the checker itself
const args = [
  '--start',
  '.',
  '--excludePrivatePackages',
  '--summary',
  '--onlyAllow',
  allowed.join(';'),
  '--excludePackagesStartingWith',
  devToolExceptions.join(';'),
];
if (process.argv.includes('--production')) args.push('--production'); // default also checks dev tooling
try {
  execFileSync('node_modules/.bin/license-checker-rseidelsohn', args, { stdio: 'inherit' });
} catch (error) {
  console.error(String(error));
  process.exit(1);
}
