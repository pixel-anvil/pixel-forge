/**
 * Review sheets for the orchestrator (not a golden, nothing is committed). Opt-in:
 *
 *   PF_REVIEW_SHEET=1 pnpm exec vitest run --project raster packages/raster/test/rotsprite-sheet.test.ts
 *
 * writes `.golden-diff/rotsprite-review-<subject>.png` (×8, grid, labelled): each synthetic subject at
 * 0, 5, 15, 30, 45, 60, 90 and 135° with RotSprite, then 30 and 45° with nearest. The pivot pixel is
 * recoloured magenta and every result is drawn at `centre − pivotOut`, so the magenta pixel must sit
 * on the same spot in every cell.
 */
import { compareGolden, goldenSheet, resolveDiffDir } from '@pixel-forge/testkit';
import type { SheetEntry } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import { TiledImage, blit, prepareRotSprite, rotateAbout } from '../src/index.js';
import { SUBJECTS } from './rotsprite-fixtures.js';
import { subjectImage } from './rotsprite-helpers.js';

const RUNS: readonly ['rotsprite' | 'nearest', number][] = [
  ['rotsprite', 0],
  ['rotsprite', 5],
  ['rotsprite', 15],
  ['rotsprite', 30],
  ['rotsprite', 45],
  ['rotsprite', 60],
  ['rotsprite', 90],
  ['rotsprite', 135],
  ['nearest', 30],
  ['nearest', 45],
];

describe.runIf(process.env.PF_REVIEW_SHEET === '1')('RotSprite review sheet', () => {
  it('writes one sheet per subject into .golden-diff/', () => {
    for (const s of SUBJECTS) {
      const img = subjectImage(s);
      img.set(s.pivot.x, s.pivot.y, [255, 0, 255, 255]);
      const far = Math.max(
        ...[0, img.width].flatMap((x) =>
          [0, img.height].map((y) => Math.hypot(x - s.pivot.x - 0.5, y - s.pivot.y - 0.5)),
        ),
      );
      const r = Math.ceil(far) + 1;
      const prep = prepareRotSprite(img);
      const entries: SheetEntry[] = RUNS.map(([algo, deg]) => {
        const out = rotateAbout(prep, s.pivot, deg, algo);
        const canvas = new TiledImage(2 * r + 1, 2 * r + 1);
        blit(canvas, out.img, r - out.pivotOut.x, r - out.pivotOut.y);
        return {
          label: `${algo === 'nearest' ? 'NN' : 'RS'} ${String(deg)}`,
          img: canvas.toRGBA(),
        };
      });
      const sheet = goldenSheet(entries, { scale: 8, columns: 5 });
      const res = compareGolden(`rotsprite-review-${s.name}`, sheet, resolveDiffDir(), {
        update: true,
      });
      expect(['created', 'updated', 'match']).toContain(res.status);
    }
  });
});
