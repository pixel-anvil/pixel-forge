import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { compareGolden } from './golden.js';
import type { GoldenOptions } from './golden.js';
import type { TestImage } from './image.js';

/** Options for {@link expectGolden}. */
export interface ExpectGoldenOptions extends GoldenOptions {
  /**
   * The calling test file: pass `import.meta.url` (or a path). Default: Vitest's
   * `expect.getState().testPath`. Goldens live in `<test dir>/__golden__/<name>.png`.
   */
  testFile?: string;
}

function testDir(testFile: string | undefined): string {
  const file = testFile ?? expect.getState().testPath;
  if (!file) {
    throw new Error(
      'expectGolden: cannot determine the test file; pass { testFile: import.meta.url }',
    );
  }
  return dirname(file.startsWith('file:') ? fileURLToPath(file) : file);
}

/**
 * Assert that `img` equals the golden `__golden__/<name>.png` next to the test (decoded-RGBA hash,
 * NFR-02). On mismatch writes `<name>.actual.png`, `<name>.expected.png`, `<name>.diff.png` into the
 * diff dir (`PF_GOLDEN_DIFF_DIR`, default `<repo>/.golden-diff`) and throws with both hashes and the
 * differing-pixel count. With `UPDATE_GOLDEN=1` writes the golden and passes (prints a notice).
 * A missing golden fails unless updating.
 */
export function expectGolden(name: string, img: TestImage, opts: ExpectGoldenOptions = {}): void {
  const goldenDir = opts.goldenDir ?? join(testDir(opts.testFile), '__golden__');
  const result = compareGolden(name, img, goldenDir, opts);
  if (result.status === 'updated' || result.status === 'created') {
    console.warn(`[testkit] ${result.message}`);
    return;
  }
  if (result.status === 'missing' || result.status === 'mismatch') {
    throw new Error(result.message);
  }
}
