import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from '@pixel-forge/png';
import { assertImage, createImage, hashRGBA } from './image.js';
import type { TestImage } from './image.js';

/** Options shared by {@link compareGolden} and `expectGolden`. */
export interface GoldenOptions {
  /** Directory holding `<name>.png` goldens. Default: `__golden__` next to the test file. */
  goldenDir?: string;
  /** Directory for `.actual/.expected/.diff` PNGs. Default: `$PF_GOLDEN_DIFF_DIR`, else `<repo root>/.golden-diff`. */
  diffDir?: string;
  /** Overwrite the golden and pass. Default: `process.env.UPDATE_GOLDEN === '1'`. */
  update?: boolean;
}

/** Result of {@link compareGolden}. */
export interface GoldenResult {
  status: 'match' | 'updated' | 'created' | 'missing' | 'mismatch';
  goldenPath: string;
  actualHash: string;
  expectedHash?: string;
  /** Number of differing pixels (union area when sizes differ). Only for `mismatch`. */
  diffPixels?: number;
  /** Paths of the written diff files. Only for `mismatch`. */
  diffFiles?: { actual: string; expected: string; diff: string };
  message: string;
}

/** Walk up from this module to the directory holding `pnpm-workspace.yaml`. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/** Resolve the diff directory: explicit option, `PF_GOLDEN_DIFF_DIR`, else `<repo root>/.golden-diff`. */
export function resolveDiffDir(explicit?: string): string {
  return resolve(explicit ?? process.env.PF_GOLDEN_DIFF_DIR ?? join(repoRoot(), '.golden-diff'));
}

const MAGENTA = [255, 0, 255, 255] as const;
const CYAN = [0, 255, 255, 255] as const;

/**
 * Build a diff visualisation. Differing pixels are magenta, pixels whose RGB is equal but alpha differs
 * are cyan, equal pixels are dimmed grey. When sizes differ the canvas is the union and pixels outside
 * either image count as different. Returns the image and the number of differing pixels.
 */
export function diffImages(
  expected: TestImage,
  actual: TestImage,
): { image: TestImage; count: number } {
  const w = Math.max(expected.width, actual.width);
  const h = Math.max(expected.height, actual.height);
  const out = createImage(w, h);
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inE = x < expected.width && y < expected.height;
      const inA = x < actual.width && y < actual.height;
      let colour: readonly number[];
      if (inE && inA) {
        const e = (y * expected.width + x) * 4;
        const a = (y * actual.width + x) * 4;
        const same = [0, 1, 2, 3].every((i) => expected.data[e + i] === actual.data[a + i]);
        if (same) {
          const lum =
            (expected.data[e]! * 3 + expected.data[e + 1]! * 6 + expected.data[e + 2]!) / 10;
          const g = Math.round(150 + lum * 0.25);
          colour = [g, g, g, 255];
        } else {
          count++;
          const rgbSame = [0, 1, 2].every((i) => expected.data[e + i] === actual.data[a + i]);
          colour = rgbSame ? CYAN : MAGENTA;
        }
      } else {
        count++;
        colour = MAGENTA;
      }
      out.data.set(colour, (y * w + x) * 4);
    }
  }
  return { image: out, count };
}

function safeName(name: string): string {
  return name.replace(/[\\/]/g, '__');
}

/**
 * Compare `img` with the golden `<goldenDir>/<name>.png` by decoded-RGBA hash (see `hashRGBA`).
 * Performs the file I/O and returns a result instead of throwing. `expectGolden` wraps it.
 */
export function compareGolden(
  name: string,
  img: TestImage,
  goldenDir: string,
  opts: Pick<GoldenOptions, 'diffDir' | 'update'> = {},
): GoldenResult {
  assertImage(img);
  const goldenPath = join(goldenDir, `${name}.png`);
  const actualHash = hashRGBA(img);
  const update = opts.update ?? process.env.UPDATE_GOLDEN === '1';
  const exists = existsSync(goldenPath);

  if (update) {
    if (exists && hashRGBA(decodePng(readFileSync(goldenPath))) === actualHash) {
      return {
        status: 'match',
        goldenPath,
        actualHash,
        expectedHash: actualHash,
        message: 'golden up to date',
      };
    }
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, encodePng({ ...img, kind: 'rgba' }));
    const verb = exists ? 'updated' : 'created';
    return {
      status: verb,
      goldenPath,
      actualHash,
      message: `UPDATE_GOLDEN: ${verb} golden ${goldenPath} (hash ${actualHash}). Review it with: pnpm golden:sheet ${name}`,
    };
  }

  if (!exists) {
    return {
      status: 'missing',
      goldenPath,
      actualHash,
      message:
        `golden "${name}" not found at ${goldenPath}. ` +
        `Run with UPDATE_GOLDEN=1 to create it, then review it with: pnpm golden:sheet ${name}`,
    };
  }

  const expected = decodePng(readFileSync(goldenPath));
  const expectedHash = hashRGBA(expected);
  if (expectedHash === actualHash) {
    return { status: 'match', goldenPath, actualHash, expectedHash, message: 'golden matches' };
  }

  const diffDir = resolveDiffDir(opts.diffDir);
  mkdirSync(diffDir, { recursive: true });
  const base = join(diffDir, safeName(name));
  const diffFiles = {
    actual: `${base}.actual.png`,
    expected: `${base}.expected.png`,
    diff: `${base}.diff.png`,
  };
  const { image, count } = diffImages(expected, img);
  writeFileSync(diffFiles.actual, encodePng({ ...img, kind: 'rgba' }));
  writeFileSync(diffFiles.expected, encodePng({ ...expected, kind: 'rgba' }));
  writeFileSync(diffFiles.diff, encodePng({ ...image, kind: 'rgba' }));
  const sizes =
    expected.width === img.width && expected.height === img.height
      ? `${String(img.width)}x${String(img.height)}`
      : `expected ${String(expected.width)}x${String(expected.height)}, actual ${String(img.width)}x${String(img.height)}`;
  return {
    status: 'mismatch',
    goldenPath,
    actualHash,
    expectedHash,
    diffPixels: count,
    diffFiles,
    message:
      `golden "${name}" mismatch (${sizes}): ${String(count)} differing pixel(s)\n` +
      `  expected hash: ${expectedHash}\n  actual hash:   ${actualHash}\n` +
      `  diff files: ${diffFiles.actual}, ${diffFiles.expected}, ${diffFiles.diff}\n` +
      `  inspect with: pnpm golden:sheet ${name}   (accept intended changes with UPDATE_GOLDEN=1)`,
  };
}
