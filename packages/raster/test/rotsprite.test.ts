import { readFileSync, writeFileSync } from 'node:fs';
import { asciiToImage, expectAscii } from '@pixel-forge/testkit';
import { describe, expect, it, vi } from 'vitest';
import {
  IndexedImage,
  PreparedRotSprite,
  RasterError,
  ROTSPRITE_MAX_AREA,
  TiledImage,
  cosQ16,
  crop,
  flipH,
  prepareRotSprite,
  rot180,
  rot270,
  rot90,
  rotateAbout,
  rotatePoint,
  sinQ16,
} from '../src/index.js';
import type { Pivot, RotatableImage, Rgba, RotationAlgo } from '../src/index.js';
import { centreTie, rotateWindow } from '../src/rotsprite/rotate.js';
import { SUBJECTS, TORSO, UPPER_ARM } from './rotsprite-fixtures.js';
import {
  TRIO,
  indexedImage,
  iou,
  opaqueCount,
  paletteImage,
  relMap,
  subjectImage,
  windowImage,
} from './rotsprite-helpers.js';
import { randomImage, rng } from './util.js';

const R: Rgba = [255, 0, 0, 255];
const legend = { X: R } as const;
const rgbk = { R, G: [0, 255, 0, 255], B: [0, 0, 255, 255], K: [0, 0, 0, 255] } as const;
const ALGOS = ['rotsprite', 'nearest'] as const;
const DEGREES = Array.from({ length: 360 }, (_, i) => i);
const SENTINEL: Rgba = [255, 0, 255, 255];

const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof RasterError ? e.code : 'other';
  }
  return undefined;
};

const bar = (n: number): TiledImage => {
  const img = new TiledImage(n, 1);
  for (let x = 0; x < n; x++) img.set(x, 0, R);
  return img;
};

describe('rotateAbout: hand-written cases', () => {
  it('a single pixel stays a single pixel at every angle', () => {
    const img = new TiledImage(3, 3);
    img.set(1, 1, R);
    for (const algo of ALGOS) {
      for (const deg of [0, 0.25, 17, 45, 90, 133.5, 359.75, -30]) {
        const r = rotateAbout(img, { x: 1, y: 1 }, deg, algo);
        expect([r.img.width, r.img.height, r.pivotOut.x, r.pivotOut.y]).toEqual([1, 1, 0, 0]);
        expect(r.img.get(0, 0)).toEqual(R);
      }
    }
  });

  it('an empty image gives a 1x1 empty image with the pivot on it', () => {
    for (const algo of ALGOS) {
      const r = rotateAbout(new TiledImage(5, 4), { x: 2, y: 3 }, 30, algo);
      expect([r.img.width, r.img.height, r.pivotOut.x, r.pivotOut.y]).toEqual([1, 1, 0, 0]);
      expect(r.img.tileCount).toBe(0);
    }
  });

  it('a 5-px bar about its centre at ±45° becomes a 3-px diagonal (derived by hand)', () => {
    // RotSprite: Scale2x leaves a 1-px bar alone (above = below), so it samples a solid 40x8 bar;
    // only offsets with dx = dy land in the 8-px-high band and |11.3·dx| < 20 keeps dx in -1..1.
    for (const algo of ALGOS) {
      const cw = rotateAbout(bar(5), { x: 2, y: 0 }, 45, algo);
      expectAscii(cw.img.toRGBA(), 'X..\n.X.\n..X', legend);
      expect(cw.pivotOut).toEqual({ x: 1, y: 1 });
      const ccw = rotateAbout(bar(5), { x: 2, y: 0 }, -45, algo);
      expectAscii(ccw.img.toRGBA(), '..X\n.X.\nX..', legend);
      expect(ccw.pivotOut).toEqual({ x: 1, y: 1 });
    }
  });

  it('90° about the top-left pixel is rot90 with the pivot carried along', () => {
    const src = TiledImage.fromRGBA(asciiToImage('RGB\nK..', rgbk));
    for (const algo of ALGOS) {
      const r = rotateAbout(src, { x: 0, y: 0 }, 90, algo);
      expectAscii(r.img.toRGBA(), 'KR\n.G\n.B', rgbk);
      expect(r.pivotOut).toEqual({ x: 1, y: 0 });
    }
  });

  it("'none' returns an independent copy of the full canvas with pivotOut = pivot", () => {
    const img = randomImage(9, 7, 3);
    const before = img.hashRGBA();
    const r = rotateAbout(img, { x: 4, y: 2 }, 33.25, 'none');
    expect(r.pivotOut).toEqual({ x: 4, y: 2 });
    expect(r.img).not.toBe(img);
    expect(r.img.equals(img)).toBe(true);
    r.img.set(0, 0, [1, 2, 3, 4]);
    expect(img.hashRGBA()).toBe(before);
    expect(code(() => rotateAbout(img, { x: 9, y: 0 }, 0, 'none'))).toBe('BAD_VALUE');
    expect(code(() => rotateAbout(img, { x: 0, y: 0 }, 0.3, 'none'))).toBe('BAD_VALUE');
  });

  it('never modifies its input', () => {
    const img = subjectImage(TORSO);
    const before = img.hashRGBA();
    const version = img.version;
    for (const algo of ['rotsprite', 'nearest', 'none'] as const)
      rotateAbout(img, TORSO.pivot, 30, algo);
    prepareRotSprite(img);
    expect(img.hashRGBA()).toBe(before);
    expect(img.version).toBe(version);
  });
});

describe('rotateAbout: validation', () => {
  const img = bar(4);
  it('typed errors', () => {
    expect(code(() => rotateAbout(img, { x: 0.5, y: 0 }, 0))).toBe('NON_INTEGER');
    expect(code(() => rotateAbout(img, { x: 4, y: 0 }, 10))).toBe('BAD_VALUE');
    expect(code(() => rotateAbout(img, { x: -1, y: 0 }, 10, 'nearest'))).toBe('BAD_VALUE');
    expect(code(() => rotateAbout(img, { x: 0, y: 1 }, 10))).toBe('BAD_VALUE');
    expect(code(() => rotateAbout(img, { x: 0, y: 0 }, 10.1))).toBe('BAD_VALUE');
    expect(code(() => rotateAbout(img, { x: 0, y: 0 }, Number.NaN))).toBe('BAD_VALUE');
    expect(code(() => rotateAbout(img, { x: 0, y: 0 }, 10, 'bicubic' as RotationAlgo))).toBe(
      'BAD_VALUE',
    );
    const notAnImage = Object.create(null) as TiledImage;
    expect(code(() => rotateAbout(notAnImage, { x: 0, y: 0 }, 10))).toBe('MISMATCH');
    expect(code(() => prepareRotSprite(notAnImage))).toBe('MISMATCH');
  });

  it('RotSprite refuses sources above ROTSPRITE_MAX_AREA at every angle; nearest and none still work', () => {
    const big = new TiledImage(520, 520);
    big.set(0, 0, R);
    big.set(519, 519, R);
    expect(520 * 520).toBeGreaterThan(ROTSPRITE_MAX_AREA);
    const pivot = { x: 0, y: 0 };
    // Angle-independent, quarter turns included, on an image and on a prepared handle.
    for (const deg of [0, 10, 90, 180, 270, -90, 360, 45]) {
      expect(
        code(() => rotateAbout(big, pivot, deg)),
        `${String(deg)}°`,
      ).toBe('BAD_SIZE');
      expect(code(() => rotateAbout(big, pivot, deg, 'rotsprite'))).toBe('BAD_SIZE');
      expect(code(() => rotateAbout(prepareRotSprite(big), pivot, deg))).toBe('BAD_SIZE');
    }
    // The limit is on the opaque box, not the canvas: a big canvas with a small box is fine.
    const sparse = new TiledImage(520, 520);
    sparse.set(3, 3, R);
    expect(opaqueCount(rotateAbout(sparse, { x: 3, y: 3 }, 90).img)).toBe(1);
    // nearest / none never build the ×8 image and have no limit, with the same handle.
    const prep = prepareRotSprite(big); // does not throw, builds nothing
    expect(prep.byteSize).toBe(4 * 520 * 520);
    for (const deg of [0, 30, 90]) {
      expect(opaqueCount(rotateAbout(prep, pivot, deg, 'nearest').img)).toBe(2);
    }
    expect(rotateAbout(prep, pivot, 30, 'none').img.equals(big)).toBe(true);
    expect(prep.byteSize).toBe(4 * 520 * 520);
  });

  it('the area limit is on the opaque box: exactly ROTSPRITE_MAX_AREA is accepted', () => {
    const edge = new TiledImage(1024, 256);
    edge.set(0, 0, R);
    edge.set(1023, 255, R);
    expect(1024 * 256).toBe(ROTSPRITE_MAX_AREA);
    expect(code(() => rotateAbout(edge, { x: 0, y: 0 }, 90))).toBeUndefined();
    const over = new TiledImage(1025, 256);
    over.set(0, 0, R);
    over.set(1024, 255, R);
    expect(code(() => rotateAbout(over, { x: 0, y: 0 }, 90))).toBe('BAD_SIZE');
  });
});

describe('exact quarter turns', () => {
  const cases: [number, (img: TiledImage | IndexedImage) => TiledImage | IndexedImage][] = [
    [0, (i) => i.clone()],
    [90, (i) => rot90(i)],
    [180, (i) => rot180(i)],
    [270, (i) => rot270(i)],
    [360, (i) => i.clone()],
    [-90, (i) => rot270(i)],
    [450, (i) => rot90(i)],
    [-180, (i) => rot180(i)],
  ];
  /** Where the pivot pixel goes under the matching transform of `transform.ts`. */
  const mapPivot = (deg: number, p: Pivot, w: number, h: number): Pivot => {
    const q = (((deg / 90) % 4) + 4) % 4;
    if (q === 1) return { x: h - 1 - p.y, y: p.x }; // rot90: (x, y) -> (h-1-y, x)
    if (q === 2) return { x: w - 1 - p.x, y: h - 1 - p.y };
    if (q === 3) return { x: p.y, y: w - 1 - p.x }; // rot270: (x, y) -> (y, w-1-x)
    return p;
  };
  const images: RotatableImage[] = [
    randomImage(7, 5, 11),
    randomImage(13, 6, 12, 0.6),
    paletteImage(9, 9, 13, TRIO),
    indexedImage(6, 11, 14, 4, 7),
    ...SUBJECTS.map(subjectImage),
  ];

  it('equal rot90 / rot180 / rot270 / identity exactly (content, pivot and trimmed canvas)', () => {
    const r = rng(99);
    for (const img of images) {
      for (let t = 0; t < 4; t++) {
        const pivot = { x: Math.floor(r() * img.width), y: Math.floor(r() * img.height) };
        for (const [deg, transform] of cases) {
          const want = transform(img);
          const wantPivot = mapPivot(deg, pivot, img.width, img.height);
          // The documented canvas: the transform's opaque bounds plus the pivot pixel.
          const b = want.bounds() ?? { x: wantPivot.x, y: wantPivot.y, w: 1, h: 1 };
          const x0 = Math.min(b.x, wantPivot.x);
          const y0 = Math.min(b.y, wantPivot.y);
          const rect = {
            x: x0,
            y: y0,
            w: Math.max(b.x + b.w, wantPivot.x + 1) - x0,
            h: Math.max(b.y + b.h, wantPivot.y + 1) - y0,
          };
          for (const algo of ALGOS) {
            const got = rotateAbout(img, pivot, deg, algo);
            expect(got.pivotOut).toEqual({ x: wantPivot.x - rect.x, y: wantPivot.y - rect.y });
            expect(got.img.equals(crop(want, rect))).toBe(true);
            expect(relMap(got.img, got.pivotOut)).toEqual(relMap(want, wantPivot));
          }
        }
      }
    }
  });

  it('the general formula at multiples of 90° gives the same pixels (exact path is a shortcut)', () => {
    for (const img of images) {
      const prep = new PreparedRotSprite(img);
      const pivot = { x: Math.floor(img.width / 2), y: Math.floor(img.height / 2) };
      for (const deg of [0, 90, 180, 270]) {
        for (const algo of ALGOS) {
          const exact = rotateWindow(prep, pivot, deg, algo);
          const formula = rotateWindow(prep, pivot, deg, algo, { exactQuarterTurns: false });
          expect(relMap(windowImage(img, formula), formula.pivotOut)).toEqual(
            relMap(windowImage(img, exact), exact.pivotOut),
          );
        }
      }
    }
  });
});

describe('sentinel: the pivot pixel lands exactly on pivotOut', () => {
  const withSentinel = (img: TiledImage, p: Pivot): TiledImage => {
    const c = img.clone();
    c.set(p.x, p.y, SENTINEL);
    return c;
  };
  const key = SENTINEL.join(',');

  it('every 1° from 0° to 359° on all four subjects, without the pivot pin (sampling alone)', () => {
    for (const s of SUBJECTS) {
      const img = withSentinel(subjectImage(s), s.pivot);
      const prep = prepareRotSprite(img);
      for (const deg of DEGREES) {
        for (const algo of ALGOS) {
          const win = rotateWindow(prep, s.pivot, deg, algo, { pin: false });
          const out = windowImage(img, win);
          expect(relMap(out, win.pivotOut).get('0,0'), `${s.name} ${algo} ${String(deg)}°`).toBe(
            key,
          );
          // ... and with the public API (pin on) too.
          const pub = rotateAbout(prep, s.pivot, deg, algo);
          expect(pub.img.get(pub.pivotOut.x, pub.pivotOut.y)).toEqual(SENTINEL);
        }
      }
    }
  });

  it('stress: every opaque pixel of the limbs (and every 9th of the torso) as the pivot, every 7.25°', () => {
    let runs = 0;
    for (const s of SUBJECTS) {
      const base = subjectImage(s);
      const pivots: Pivot[] = [];
      for (const k of relMap(base, { x: 0, y: 0 }).keys()) {
        const [x = 0, y = 0] = k.split(',').map(Number);
        pivots.push({ x, y });
      }
      pivots.forEach((p, i) => {
        if (s === TORSO && i % 9 !== 0) return;
        const img = withSentinel(base, p);
        const prep = prepareRotSprite(img);
        for (let deg = 0; deg < 360; deg += 7.25) {
          for (const algo of ALGOS) {
            const win = rotateWindow(prep, p, deg, algo, { pin: false });
            expect(relMap(windowImage(img, win), win.pivotOut).get('0,0')).toBe(key);
            runs++;
          }
        }
      });
    }
    expect(runs).toBeGreaterThan(10_000);
  }, 20_000);
});

describe('colours: output colours ⊆ input colours', () => {
  const colourSet = (img: RotatableImage): Set<string> =>
    new Set(relMap(img, { x: 0, y: 0 }).values());

  it('property over seeded random RGBA images (partial alpha, invisible garbage under alpha 0)', () => {
    const r = rng(2024);
    for (let n = 0; n < 40; n++) {
      const w = 2 + Math.floor(r() * 14);
      const h = 2 + Math.floor(r() * 14);
      const img = n % 2 === 0 ? randomImage(w, h, 500 + n, 0.5) : paletteImage(w, h, 500 + n, TRIO);
      img.set(0, 0, [9, 8, 7, 0]); // alpha 0 with non-zero RGB: invisible, must not leak
      const allowed = colourSet(img);
      const prep = prepareRotSprite(img);
      for (let t = 0; t < 12; t++) {
        const deg = Math.floor(r() * 1440) / 4;
        const pivot = { x: Math.floor(r() * w), y: Math.floor(r() * h) };
        for (const algo of ALGOS) {
          const out = rotateAbout(prep, pivot, deg, algo).img;
          for (const c of colourSet(out)) expect(allowed.has(c)).toBe(true);
          const d = out.toRGBA().data;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] === 0) expect([d[i], d[i + 1], d[i + 2]]).toEqual([0, 0, 0]);
          }
        }
      }
    }
  });

  it('indexed images keep their transparent index and only use input indices', () => {
    for (let n = 0; n < 12; n++) {
      const img = indexedImage(3 + n, 4 + (n % 5), 900 + n, 4, 7);
      const allowed = colourSet(img);
      for (const deg of [12.5, 45, 77.75, 200, 311]) {
        for (const algo of ALGOS) {
          const out = rotateAbout(img, { x: 1, y: 2 }, deg, algo).img;
          expect(out).toBeInstanceOf(IndexedImage);
          expect(out.transparentIndex).toBe(7);
          for (const c of colourSet(out)) expect(allowed.has(c)).toBe(true);
        }
      }
    }
  });
});

describe('mirror symmetry: flipH(rotate(I, θ)) ≡ rotate(flipH(I), −θ)', () => {
  const mirrorPair = (
    img: TiledImage,
    p: Pivot,
    deg: number,
    algo: 'rotsprite' | 'nearest',
    centreTie: 'symmetric' | 'spike' = 'symmetric',
    preps: [PreparedRotSprite<TiledImage>, PreparedRotSprite<TiledImage>] = [
      new PreparedRotSprite(img),
      new PreparedRotSprite(flipH(img)),
    ],
  ): [Map<string, string>, Map<string, string>] => {
    const a = rotateWindow(preps[0], p, deg, algo, { centreTie });
    const b = rotateWindow(preps[1], { x: img.width - 1 - p.x, y: p.y }, -deg, algo, { centreTie });
    return [relMap(windowImage(img, a), a.pivotOut, true), relMap(windowImage(img, b), b.pivotOut)];
  };

  it('exact (colours and mask, IoU 1.0) at all 1440 table angles on the four subjects', () => {
    for (const s of SUBJECTS) {
      const img = subjectImage(s);
      const preps: [PreparedRotSprite<TiledImage>, PreparedRotSprite<TiledImage>] = [
        prepareRotSprite(img),
        prepareRotSprite(flipH(img)),
      ];
      for (let k = 0; k < 1440; k++) {
        for (const algo of ALGOS) {
          const [a, b] = mirrorPair(img, s.pivot, k / 4, algo, 'symmetric', preps);
          expect(a, `${s.name} ${algo} ${String(k / 4)}°`).toEqual(b);
        }
      }
    }
  }, 20_000);

  it('exact on seeded random palette images at every 1° (public API)', () => {
    for (let n = 0; n < 16; n++) {
      const img = paletteImage(3 + (n % 9), 3 + ((n * 3) % 8), 100 + n, TRIO);
      const p = { x: n % img.width, y: (n * 5) % img.height };
      const m = flipH(img);
      const mp = { x: img.width - 1 - p.x, y: p.y };
      const pa = prepareRotSprite(img);
      const pb = prepareRotSprite(m);
      for (const deg of DEGREES) {
        const a = rotateAbout(pa, p, deg);
        const b = rotateAbout(pb, mp, -deg);
        expect(relMap(a.img, a.pivotOut, true)).toEqual(relMap(b.img, b.pivotOut));
      }
    }
  });

  it('the centre-line tie rule is symmetric in its two candidates and prefers own, then opaque', () => {
    const values = [0, 1, 2, 3, 7];
    for (const a of values) {
      for (const b of values) {
        for (const own of values) {
          for (const empty of [0, 7]) {
            const pick = centreTie(a, b, own, empty);
            expect(pick).toBe(centreTie(b, a, own, empty));
            expect([a, b]).toContain(pick);
          }
        }
      }
    }
    expect(centreTie(1, 2, 2, 0)).toBe(2); // the source pixel's own colour
    expect(centreTie(0, 2, 3, 0)).toBe(2); // neither is own: the opaque one
    expect(centreTie(5, 0, 3, 0)).toBe(5);
    expect(centreTie(5, 4, 3, 0)).toBe(4); // both opaque, neither own: the smaller value
  });

  it("the spike's tie rule (+x side on the pivot's centre line) is not mirror-symmetric at 45°", () => {
    // Why `centreTie: 'symmetric'` exists: at 45° + k·90°, C = ±S, so C·dx + S·dy = 0 on a diagonal
    // through the pivot and those samples fall exactly between two ×8 pixels of one source column.
    let breaks = 0;
    let worstIoU = 1;
    let worstProductionIoU = 1;
    for (let n = 0; n < 60; n++) {
      const img = paletteImage(3 + (n % 9), 3 + ((n * 3) % 8), 100 + n, TRIO);
      const p = { x: n % img.width, y: (n * 5) % img.height };
      for (const deg of [45, 135, 225, 315]) {
        const [a, b] = mirrorPair(img, p, deg, 'rotsprite', 'spike');
        if (JSON.stringify([...a].sort()) !== JSON.stringify([...b].sort())) breaks++;
        worstIoU = Math.min(worstIoU, iou(a, b));
        const [c, d] = mirrorPair(img, p, deg, 'rotsprite', 'symmetric');
        expect(c).toEqual(d);
        worstProductionIoU = Math.min(worstProductionIoU, iou(c, d));
      }
    }
    // The card requires mirror IoU >= 0.95. The production rule gives exactly 1 (colours and mask).
    // The spike's rule breaks colours in `breaks` of the 240 cases and sometimes the mask: measured
    // worst IoU 0.9375 (15/16) on these random palette images, i.e. below the card's threshold, which
    // is why the symmetric rule exists (the spike measured 1.000 only on its own art).
    expect(worstProductionIoU).toBeGreaterThanOrEqual(0.95);
    expect(worstProductionIoU).toBe(1);
    expect(breaks).toBeGreaterThan(0);
    expect(worstIoU).toBeLessThan(0.95);
    expect(worstIoU).toBeGreaterThanOrEqual(0.93);
  });
});

describe('alpha area', () => {
  /**
   * Measured over every 1° (RotSprite, production transparent-edge Scale2x), area change vs the
   * source's opaque count. `max` is the largest |change|, `loss` / `gain` the extreme signed changes,
   * `sumAbs` the sum of |change| over the 360 angles. They are exact bounds, not tolerances: eroding
   * thin limbs (a regression) pushes at least one of them up and fails. The spike's edge-replicating
   * Scale2x gives the same worst case on the two thin limbs (3 px; see the reference test), so the 3-px
   * swing is inherent to 2-px-wide art, not a cost of the transparent edge.
   */
  const EXPECTED: Record<
    string,
    { n0: number; max: number; loss: number; gain: number; sumAbs: number }
  > = {
    'upper-arm': { n0: 12, max: 3, loss: -3, gain: 0, sumAbs: 440 },
    forearm: { n0: 9, max: 2, loss: -2, gain: 2, sumAbs: 268 },
    shin: { n0: 37, max: 3, loss: -3, gain: 1, sumAbs: 496 },
    torso: { n0: 552, max: 10, loss: -10, gain: 3, sumAbs: 1208 },
  };

  it('RotSprite area change stays within the measured per-subject bounds', () => {
    for (const s of SUBJECTS) {
      const want = EXPECTED[s.name];
      if (want === undefined) throw new Error(`no expectation for ${s.name}`);
      const img = subjectImage(s);
      const n0 = opaqueCount(img);
      expect(n0, s.name).toBe(want.n0);
      const prep = prepareRotSprite(img);
      let sumAbs = 0;
      let loss = 0;
      let gain = 0;
      for (const deg of DEGREES) {
        const delta = opaqueCount(rotateAbout(prep, s.pivot, deg).img) - n0;
        sumAbs += Math.abs(delta);
        loss = Math.min(loss, delta);
        gain = Math.max(gain, delta);
      }
      expect(Math.max(-loss, gain), `${s.name} max`).toBeLessThanOrEqual(want.max);
      expect(loss, `${s.name} loss`).toBeGreaterThanOrEqual(want.loss);
      expect(gain, `${s.name} gain`).toBeLessThanOrEqual(want.gain);
      expect(sumAbs, `${s.name} sumAbs`).toBeLessThanOrEqual(want.sumAbs);
      if (n0 >= 30) expect(Math.max(-loss, gain), s.name).toBeLessThanOrEqual(0.1 * n0); // ±10 %
    }
  });
});

describe('pivot placement: independent float64 oracles', () => {
  it('nearest equals a float64 nearest-neighbour rotation except at documented near-ties', () => {
    const rha = (v: number): number => (v >= 0 ? Math.floor(v + 0.5) : -Math.floor(0.5 - v));
    for (const s of SUBJECTS) {
      const img = subjectImage(s);
      const prep = new PreparedRotSprite(img);
      const { x: px, y: py } = s.pivot;
      let disagreements = 0;
      let scanned = 0;
      for (const deg of DEGREES) {
        const { img: out, pivotOut } = rotateAbout(prep, s.pivot, deg, 'nearest');
        const t = (deg * Math.PI) / 180;
        const co = Math.cos(t);
        const si = Math.sin(t);
        // Scan a window larger than the output so missing content outside it would be caught too.
        for (let y = -3; y < out.height + 3; y++) {
          for (let x = -3; x < out.width + 3; x++) {
            const dx = x - pivotOut.x;
            const dy = y - pivotOut.y;
            const ux = dx * co + dy * si; // inverse rotation of the output pixel centre
            const uy = -dx * si + dy * co;
            const want = img.get(px + rha(ux), py + rha(uy));
            const got = out.get(x, y);
            scanned++;
            if (want[3] === 0 && got[3] === 0) continue;
            if (want.join() === got.join()) continue;
            disagreements++;
            const tol = (Math.abs(dx) + Math.abs(dy)) / 131072 + 1e-12;
            const nearTie = (v: number): boolean =>
              Math.abs(Math.abs(v - Math.trunc(v)) - 0.5) <= tol;
            expect(
              nearTie(ux) || nearTie(uy),
              `${s.name} ${String(deg)}° (${String(dx)},${String(dy)})`,
            ).toBe(true);
          }
        }
      }
      expect(disagreements).toBeLessThanOrEqual(scanned / 1000);
    }
  });

  it('RotSprite output centroid matches the float64-rotated input centroid', () => {
    const centroid = (img: RotatableImage, p: Pivot): [number, number] => {
      let sx = 0;
      let sy = 0;
      const m = relMap(img, p);
      for (const k of m.keys()) {
        const [x = 0, y = 0] = k.split(',').map(Number);
        sx += x;
        sy += y;
      }
      return [sx / m.size, sy / m.size];
    };
    for (const s of SUBJECTS) {
      const img = subjectImage(s);
      const [cx, cy] = centroid(img, s.pivot);
      const prep = prepareRotSprite(img);
      let worst = 0;
      for (const deg of DEGREES) {
        const r = rotateAbout(prep, s.pivot, deg);
        const [ox, oy] = centroid(r.img, r.pivotOut);
        const t = (deg * Math.PI) / 180;
        const ex = cx * Math.cos(t) - cy * Math.sin(t);
        const ey = cx * Math.sin(t) + cy * Math.cos(t);
        worst = Math.max(worst, Math.hypot(ox - ex, oy - ey));
      }
      // Measured: 0.62 / 0.41 / 0.34 px on the limbs, 0.18 px on the 552-px torso.
      expect(worst, s.name).toBeLessThanOrEqual(s === TORSO ? 0.25 : 0.75);
    }
  });

  it('the output canvas is tight and the computed range is conservative', () => {
    for (const s of SUBJECTS) {
      const img = subjectImage(s);
      const prep = prepareRotSprite(img);
      for (let deg = 0; deg < 360; deg += 3.25) {
        for (const algo of ALGOS) {
          const win = rotateWindow(prep, s.pivot, deg, algo);
          const wide = rotateWindow(prep, s.pivot, deg, algo, { extraMargin: 6 });
          expect([win.w, win.h, win.pivotOut]).toEqual([wide.w, wide.h, wide.pivotOut]);
          const out = windowImage(img, win);
          expect(relMap(out, win.pivotOut)).toEqual(relMap(windowImage(img, wide), wide.pivotOut));
          // Tight: each edge row / column holds content or the pivot.
          const b = out.bounds() ?? { x: win.pivotOut.x, y: win.pivotOut.y, w: 1, h: 1 };
          const x0 = Math.min(b.x, win.pivotOut.x);
          const y0 = Math.min(b.y, win.pivotOut.y);
          expect([x0, y0]).toEqual([0, 0]);
          expect(Math.max(b.x + b.w, win.pivotOut.x + 1)).toBe(out.width);
          expect(Math.max(b.y + b.h, win.pivotOut.y + 1)).toBe(out.height);
        }
      }
    }
  });
});

describe('PreparedRotSprite handle', () => {
  it('gives the same result as rotating the image directly', () => {
    const img = subjectImage(TORSO);
    const prep = prepareRotSprite(img);
    for (const deg of [0, 7.5, 30, 45, 90, 123.25, 200, 333]) {
      for (const algo of ALGOS) {
        const a = rotateAbout(prep, TORSO.pivot, deg, algo);
        const b = rotateAbout(img, TORSO.pivot, deg, algo);
        expect(a.pivotOut).toEqual(b.pivotOut);
        expect(a.img.equals(b.img)).toBe(true);
      }
    }
  });

  it('is a snapshot: later edits of the source do not leak into it', () => {
    const img = subjectImage(UPPER_ARM);
    const prep = prepareRotSprite(img);
    const before = rotateAbout(prep, UPPER_ARM.pivot, 30);
    img.set(5, 0, R);
    img.set(0, 3, R);
    const after = rotateAbout(prep, UPPER_ARM.pivot, 30);
    expect(after.img.equals(before.img)).toBe(true);
    expect(rotateAbout(prep, UPPER_ARM.pivot, 0, 'none').img.equals(subjectImage(UPPER_ARM))).toBe(
      true,
    );
    expect(rotateAbout(img, UPPER_ARM.pivot, 30).img.equals(before.img)).toBe(false);
  });

  it('caches the ×8 image and reports its size', () => {
    const img = subjectImage(TORSO);
    const b = img.bounds();
    const area = (b?.w ?? 0) * (b?.h ?? 0);
    const lazy = new PreparedRotSprite(img);
    expect(lazy.byteSize).toBe(4 * area);
    const prep = prepareRotSprite(img);
    expect(prep.byteSize).toBe(4 * area); // lazy: nothing built yet
    rotateAbout(prep, TORSO.pivot, 90); // an exact quarter turn does not need it either
    rotateAbout(prep, TORSO.pivot, 30, 'nearest');
    expect(prep.byteSize).toBe(4 * area);
    rotateAbout(prep, TORSO.pivot, 30); // first non-quarter RotSprite use builds and caches it
    expect(prep.byteSize).toBe(4 * area * 65);
    expect(prep.big()).toBe(prep.big());
    expect(prep.source.equals(img)).toBe(true);
  });

  it('works for indexed images with a non-zero transparent index', () => {
    const img = indexedImage(10, 8, 77, 3, 5);
    const prep = prepareRotSprite(img);
    const r = rotateAbout(prep, { x: 4, y: 4 }, 30);
    expect(r.img).toBeInstanceOf(IndexedImage);
    expect(r.img.transparentIndex).toBe(5);
    expect(r.img.get(r.pivotOut.x, r.pivotOut.y)).toBe(img.get(4, 4));
  });
});

describe('determinism', () => {
  const goldenUrl = new URL('./rotsprite-hashes.json', import.meta.url);
  const GOLDEN_ANGLES = [0.25, 5, 13.75, 30, 45, 67.5, 90, 135, 222.25, 315];
  const GOLDEN_NOTE =
    'Golden SHA-256 (hashRGBA of the decoded RGBA, ADR-010) of rotateAbout outputs plus pivotOut, ' +
    'for the four synthetic subjects in rotsprite-fixtures.ts. Value: "<hash> <pivotOut.x>,<pivotOut.y>". ' +
    'Do not edit by hand: regenerate with UPDATE_GOLDEN=1 (pnpm exec vitest run --project raster ' +
    'packages/raster/test/rotsprite.test.ts), review the diff and the review sheet (rotsprite-sheet.test.ts), ' +
    'and record "golden reviewed" in a card note (AGENTS.md, Oracles and goldens).';

  /** `subject/algo/deg` -> `"<sha256> px,py"` for every golden case, computed with the current code. */
  const compute = (): Record<string, string> => {
    const table: Record<string, string> = {};
    for (const s of SUBJECTS) {
      const prep = prepareRotSprite(subjectImage(s));
      for (const algo of ALGOS) {
        for (const deg of GOLDEN_ANGLES) {
          const r = rotateAbout(prep, s.pivot, deg, algo);
          table[`${s.name}/${algo}/${String(deg)}`] =
            `${r.img.hashRGBA()} ${String(r.pivotOut.x)},${String(r.pivotOut.y)}`;
        }
      }
    }
    return table;
  };

  it('matches the committed golden hashes (rotsprite-hashes.json) at every golden angle', () => {
    const actual = compute();
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(
        goldenUrl,
        JSON.stringify({ _note: GOLDEN_NOTE, hashes: actual }, null, 2) + '\n',
      );
    }
    const golden = JSON.parse(readFileSync(goldenUrl, 'utf8')) as {
      _note: string;
      hashes: Record<string, string>;
    };
    expect(Object.keys(golden.hashes).sort()).toEqual(Object.keys(actual).sort());
    for (const [key, value] of Object.entries(actual)) {
      expect(value, key).toBe(golden.hashes[key]);
    }
    expect(Object.keys(actual)).toHaveLength(SUBJECTS.length * ALGOS.length * GOLDEN_ANGLES.length);
  });

  it('is a pure function of its inputs: image vs prepared handle vs fresh copy', () => {
    const img = subjectImage(TORSO);
    for (const deg of [13.75, 222]) {
      const a = rotateAbout(img, TORSO.pivot, deg);
      const b = rotateAbout(prepareRotSprite(subjectImage(TORSO)), TORSO.pivot, deg);
      expect(a.img.hashRGBA()).toBe(b.img.hashRGBA());
      expect(a.pivotOut).toEqual(b.pivotOut);
    }
  });

  it('never calls Math.sin / cos / tan / atan2 (...): only the committed table is used', () => {
    const names = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh'];
    const spies = names.map((n) =>
      vi.spyOn(Math, n as 'sin').mockImplementation(() => {
        throw new Error(`Math.${n} called in the render path`);
      }),
    );
    try {
      for (const s of SUBJECTS) {
        const img = subjectImage(s);
        for (let k = 0; k < 1440; k += 7) {
          for (const algo of ALGOS) {
            expect(() => rotateAbout(img, s.pivot, k / 4, algo)).not.toThrow();
          }
        }
      }
      expect(() => rotatePoint(7, -3, 33.25)).not.toThrow();
      expect(() => sinQ16(12.25)).not.toThrow();
      // The stubs really are armed.
      expect(() => Math.sin(1)).toThrow('Math.sin');
      expect(() => Math.atan2(1, 1)).toThrow('Math.atan2');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(Math.sin(0)).toBe(0);
  });

  it('sampling direction: a pixel right of the pivot at 90° lands below it (table angle convention)', () => {
    const img = new TiledImage(3, 1);
    img.set(1, 0, R);
    img.set(2, 0, [0, 0, 255, 255]);
    const r = rotateAbout(img, { x: 1, y: 0 }, 90);
    expect(r.img.get(r.pivotOut.x, r.pivotOut.y + 1)).toEqual([0, 0, 255, 255]);
    expect([cosQ16(90), sinQ16(90)]).toEqual([0, 65536]);
  });
});
