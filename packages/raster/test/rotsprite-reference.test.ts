/**
 * Agreement with the T0.4 spike reference implementation (`spikes/rotsprite/reference/rot.mjs`), which
 * is imported as-is. Every difference between the port and the reference is enumerated here:
 *
 * 1. Outside the image: the port treats it as transparent; the reference replicates edge pixels in
 *    Scale2x. Giving the reference a 1-px transparent border makes the two identical (the border stays
 *    transparent through all three passes), so the tests pad the reference's input.
 * 2. Multiples of 90°: the port uses the exact pixel permutation; the reference runs the general
 *    formula. They agree on every subject (checked), the shortcut just guarantees it.
 * 3. Samples exactly on the pivot's ×8 centre line (only at 45° + k·90° in practice): the port's
 *    mirror-symmetric choice vs the reference's +x/+y side.
 * 4. Pivot pin: the port copies the pivot colour onto `pivotOut`; the reference does not. The sample
 *    there is already the pivot colour, so this never changes a pixel on these subjects.
 */
import { describe, expect, it } from 'vitest';
import { PreparedRotSprite, cosQ16, flipH, sinQ16 } from '../src/index.js';
import type { TiledImage } from '../src/index.js';
import { rotateWindow } from '../src/rotsprite/rotate.js';
import { SUBJECTS, TORSO, UPPER_ARM } from './rotsprite-fixtures.js';
import {
  opaqueCount,
  paletteImage,
  relMap,
  subjectImage,
  TRIO,
  windowImage,
} from './rotsprite-helpers.js';

interface RefImage {
  w: number;
  h: number;
  p: Uint32Array;
}
interface RefResult extends RefImage {
  ox: number;
  oy: number;
}
interface RefModule {
  rotSprite(
    src: RefImage,
    px: number,
    py: number,
    deg: number,
    opts?: { big?: RefImage },
  ): RefResult;
  rotNearest(src: RefImage, px: number, py: number, deg: number): RefResult;
  scale8(src: RefImage): RefImage;
}
const REFERENCE = new URL('../../../spikes/rotsprite/reference/rot.mjs', import.meta.url).href;
const ref = (await import(REFERENCE)) as RefModule;

/** The reference's image format (packed, transparent = 0), with `pad` transparent pixels around. */
function toRef(img: TiledImage, pad: number): RefImage {
  const w = img.width + 2 * pad;
  const h = img.height + 2 * pad;
  const p = new Uint32Array(w * h);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const [r, g, b, a] = img.get(x, y);
      if (a !== 0) p[(y + pad) * w + x + pad] = (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
    }
  }
  return { w, h, p };
}

/** Same keys and values as `relMap`. */
function refMap(r: RefResult): Map<string, string> {
  const m = new Map<string, string>();
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const v = r.p[y * r.w + x] ?? 0;
      if (v === 0) continue;
      const c = [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
      m.set(`${String(x - r.ox)},${String(y - r.oy)}`, c.join(','));
    }
  }
  return m;
}

const DEGREES = Array.from({ length: 360 }, (_, i) => i);
const SPIKE_KNOBS = { pin: false, exactQuarterTurns: false, centreTie: 'spike' } as const;
const images = [
  ...SUBJECTS.map((s) => ({ name: s.name, img: subjectImage(s), pivot: s.pivot })),
  ...Array.from({ length: 8 }, (_, n) => {
    const img = paletteImage(4 + n, 3 + ((n * 3) % 7), 300 + n, TRIO);
    return { name: `random-${String(n)}`, img, pivot: { x: n % img.width, y: 1 } };
  }),
];

describe('agreement with the spike reference implementation', () => {
  it('identical pixels, canvas and pivotOut with the spike conventions, every 1°', () => {
    for (const { name, img, pivot } of images) {
      const prep = new PreparedRotSprite(img);
      const r = toRef(img, 1);
      const big = ref.scale8(r);
      for (const deg of DEGREES) {
        const mine = rotateWindow(prep, pivot, deg, 'rotsprite', SPIKE_KNOBS);
        const theirs = ref.rotSprite(r, pivot.x + 1, pivot.y + 1, deg, { big });
        expect(relMap(windowImage(img, mine), mine.pivotOut), `${name} ${String(deg)}°`).toEqual(
          refMap(theirs),
        );
        expect([mine.w, mine.h, mine.pivotOut.x, mine.pivotOut.y]).toEqual([
          theirs.w,
          theirs.h,
          theirs.ox,
          theirs.oy,
        ]);
        const nMine = rotateWindow(prep, pivot, deg, 'nearest', SPIKE_KNOBS);
        const nTheirs = ref.rotNearest(r, pivot.x + 1, pivot.y + 1, deg);
        expect(relMap(windowImage(img, nMine), nMine.pivotOut)).toEqual(refMap(nTheirs));
      }
    }
  }, 20_000);

  it('with the production defaults, differences are confined to centre-line ties at 45° + k·90°', () => {
    // All table angles on the subject set, plus every 5° on the 60 palette images the mirror test
    // uses and their mirror images (they contain unequal ×8 pixels on the pivot's centre lines; on
    // one orientation the symmetric rule happens to pick the reference's +x side, on the other not).
    const tieImages = Array.from({ length: 60 }, (_, n) => {
      const img = paletteImage(3 + (n % 9), 3 + ((n * 3) % 8), 100 + n, TRIO);
      const pivot = { x: n % img.width, y: (n * 5) % img.height };
      return [
        { name: `tie-${String(n)}`, img, pivot },
        {
          name: `tie-${String(n)}-mirrored`,
          img: flipH(img),
          pivot: { x: img.width - 1 - pivot.x, y: pivot.y },
        },
      ];
    }).flat();
    const runs = [
      ...images.map((i) => ({ ...i, steps: 1440 })),
      ...tieImages.map((i) => ({ ...i, steps: 72 })),
    ];
    let differing = 0;
    for (const { name, img, pivot, steps } of runs) {
      const prep = new PreparedRotSprite(img);
      const r = toRef(img, 1);
      const big = ref.scale8(r);
      for (let k = 0; k < steps; k++) {
        const deg = (k * 360) / steps;
        const mine = rotateWindow(prep, pivot, deg, 'rotsprite');
        const a = relMap(windowImage(img, mine), mine.pivotOut);
        const b = refMap(ref.rotSprite(r, pivot.x + 1, pivot.y + 1, deg, { big }));
        const c = cosQ16(deg);
        const s = sinQ16(deg);
        for (const key of new Set([...a.keys(), ...b.keys()])) {
          if (a.get(key) === b.get(key)) continue;
          differing++;
          const [dx = 0, dy = 0] = key.split(',').map(Number);
          // Only samples exactly on a ×8 centre line through the pivot may differ.
          expect(
            c * dx + s * dy === 0 || c * dy - s * dx === 0,
            `${name} ${String(deg)}° ${key}`,
          ).toBe(true);
          expect(deg % 90, `${name} ${String(deg)}°`).toBe(45);
        }
      }
    }
    expect(differing).toBeGreaterThan(0);
  }, 20_000);

  it('without padding, the reference differs exactly where the art touches its image edge', () => {
    // UPPER_ARM fills its bounding box edge to edge: the reference's edge replication stops Scale2x
    // from rounding those outer corners, so it differs from the port. TORSO has a transparent
    // border, so edge replication only replicates transparency and the results agree.
    const differs = (img: TiledImage, pivot: { x: number; y: number }): boolean => {
      const prep = new PreparedRotSprite(img);
      const r = toRef(img, 0);
      const big = ref.scale8(r);
      return DEGREES.some((deg) => {
        const mine = rotateWindow(prep, pivot, deg, 'rotsprite', SPIKE_KNOBS);
        const a = relMap(windowImage(img, mine), mine.pivotOut);
        return (
          JSON.stringify([...a].sort()) !==
          JSON.stringify([...refMap(ref.rotSprite(r, pivot.x, pivot.y, deg, { big }))].sort())
        );
      });
    };
    expect(differs(subjectImage(UPPER_ARM), UPPER_ARM.pivot)).toBe(true);
    expect(differs(subjectImage(TORSO), TORSO.pivot)).toBe(false);
  }, 20_000);

  it("area: the spike's edge replication swings as much as the transparent edge on the thin limbs", () => {
    // Measured max |area change| over every 1° on the unpadded subjects (edge replication = the spike's
    // own behaviour). Production (transparent edge): upper-arm 3, forearm 2; see rotsprite.test.ts.
    // Edge replication is not a way to ±1 px: it gives 3 on both, so the swing is inherent to 2-px art.
    const spikeWorst: Record<string, number> = { 'upper-arm': 3, forearm: 3, shin: 3, torso: 10 };
    for (const s of SUBJECTS) {
      const img = subjectImage(s);
      const n0 = opaqueCount(img);
      const r = toRef(img, 0);
      const big = ref.scale8(r);
      let worst = 0;
      for (const deg of DEGREES) {
        const out = ref.rotSprite(r, s.pivot.x, s.pivot.y, deg, { big });
        worst = Math.max(worst, Math.abs(out.p.reduce((n, v) => n + (v === 0 ? 0 : 1), 0) - n0));
      }
      expect(worst, s.name).toBe(spikeWorst[s.name]);
    }
  });
});
