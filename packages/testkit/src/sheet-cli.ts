import { globSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { decodePng, encodePng } from '@pixel-forge/png';
import { goldenSheet } from './sheet.js';
import type { SheetEntry } from './sheet.js';

/** Result of {@link buildSheet}. */
export interface BuiltSheet {
  /** Output file written. */
  out: string;
  /** Input files used, in sheet order. */
  inputs: string[];
}

const isGlob = (s: string): boolean => /[*?[\]/\\]/.test(s);

/** Slug used in the output file name. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'sheet';
}

/** Find PNGs for a bare golden name under `repoRoot`. */
export function findByName(repoRoot: string, name: string): string[] {
  const diffDir = join(repoRoot, '.golden-diff');
  const found: string[] = [];
  for (const kind of ['expected', 'actual', 'diff']) {
    const f = join(diffDir, `${name}.${kind}.png`);
    if (existsSync(f)) found.push(f);
  }
  const goldens = [
    ...globSync(`packages/*/test/**/__golden__/${name}.png`, { cwd: repoRoot }),
    ...globSync(`fixtures/**/${name}.png`, { cwd: repoRoot }),
  ]
    .filter((p) => !p.includes('node_modules'))
    .sort()
    .map((p) => join(repoRoot, p));
  return [...goldens, ...found];
}

/**
 * Build `.golden-diff/sheet-<name>.png` from golden PNGs and/or `.golden-diff/*` files.
 * `target` is a bare name (golden `__golden__/<name>.png`, `fixtures/**` `<name>.png`, and
 * `.golden-diff/<name>.{expected,actual,diff}.png`) or a glob/path relative to `repoRoot`.
 */
export function buildSheet(repoRoot: string, target: string, scale = 8): BuiltSheet {
  const inputs = isGlob(target)
    ? globSync(target, { cwd: repoRoot })
        .filter((p) => p.endsWith('.png'))
        .sort()
        .map((p) => resolve(repoRoot, p))
    : findByName(repoRoot, target);
  if (inputs.length === 0) throw new Error(`golden:sheet: no PNG files found for "${target}"`);
  const entries: SheetEntry[] = inputs.map((f) => ({
    label: basename(f, '.png'),
    img: decodePng(readFileSync(f)),
  }));
  const sheet = goldenSheet(entries, { scale, grid: true });
  const dir = join(repoRoot, '.golden-diff');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `sheet-${slug(isGlob(target) ? target : target)}.png`);
  writeFileSync(out, encodePng({ ...sheet, kind: 'rgba' }));
  return { out, inputs };
}
