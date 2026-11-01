// T3.5: overlapMask / overlapMasks / checkOverlapPaint against the hand-computed worked examples of
// docs/contracts/JOINT_CHECK.md section 7, the real RotSprite sweep, and the "rest composite unchanged"
// property.
import { TiledImage } from '@pixel-forge/raster';
import type { RgbaImage } from '@pixel-forge/raster';
import { asciiToImage } from '@pixel-forge/testkit';
import type { Legend } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import {
  JointCheckError,
  checkOverlapPaint,
  jointCheck,
  overlapMask,
  overlapMasks,
} from '../src/index.js';
import type { JointGapResult, JointRig, Px } from '../src/index.js';
import { prng } from './helpers.js';
import { B, IMG, Images, LAY, P, VIEW, need, variant } from './render-fixture.js';

const PARENT: Legend = { P: [255, 0, 0, 255], C: [0, 0, 0, 0], '.': [0, 0, 0, 0] };
const CHILD: Legend = { C: [0, 0, 255, 255], P: [0, 0, 0, 0], '.': [0, 0, 0, 0] };

const ELBOW = `
..............
..............
..............
..............
PPPPPPPCCCCCCC
PPPPPPPCCCCCCC
PPPPPPPCCCCCCC
PPPPPPPCCCCCCC
..............
..............
..............
..............`;

const KNEE = `
...............
...............
.....PPPPP.....
.....PPPPP.....
.....PPPPP.....
.....CCCCC.....
.....CCCCC.....
.....CCCCC.....
.....CCCCC.....
.....CCCCC.....
.....CCCCC.....
...............`;

interface Setup {
  rig: JointRig;
  images: Images;
  canvas: { w: number; h: number };
  parent: RgbaImage;
  child: RgbaImage;
}

/** Two bones `upper` (root) and `lower` whose parts are the ASCII art; `childUnder` draws `lower` first. */
function setup(
  art: string,
  pivot: Px,
  childDir: number,
  opts: { childUnder?: boolean; drawnAngle?: number } = {},
): Setup {
  const parent = asciiToImage(art, PARENT);
  const child = asciiToImage(art, CHILD);
  const images = new Images();
  images.map.set(IMG('upper'), TiledImage.fromRGBA(parent));
  images.map.set(IMG('lower'), TiledImage.fromRGBA(child));
  const rig: JointRig = {
    bones: [
      { id: B('upper'), name: 'upper' },
      { id: B('lower'), name: 'lower', parentId: B('upper') },
    ],
    parts: [
      {
        id: P('upper'),
        boneId: B('upper'),
        layerId: LAY('upper'),
        variants: [variant('upper', 'upper', { x: 0, y: 0 })],
      },
      {
        id: P('lower'),
        boneId: B('lower'),
        layerId: LAY('lower'),
        variants: [
          variant(
            'lower',
            'lower',
            { x: pivot[0], y: pivot[1] },
            opts.drawnAngle === undefined ? {} : { drawnAngle: opts.drawnAngle },
          ),
        ],
      },
    ],
    views: [
      {
        id: VIEW,
        name: 'side',
        directions: ['side'],
        rest: {
          [B('upper')]: { x: 0, y: 0, angle: 0 },
          [B('lower')]: { x: pivot[0], y: pivot[1], angle: childDir },
        },
        partVisibility: {},
        defaultZ: opts.childUnder === true ? { [P('lower')]: -1 } : {},
      },
    ],
  };
  return { rig, images, canvas: { w: parent.width, h: parent.height }, parent, child };
}

const elbow = (opts: { childUnder?: boolean } = {}): Setup => setup(ELBOW, [7, 5], 0, opts);
const knee = (opts: { childUnder?: boolean } = {}): Setup => setup(KNEE, [7, 5], 90, opts);

const alpha = (img: RgbaImage, x: number, y: number): boolean =>
  (img.data[(y * img.width + x) * 4 + 3] ?? 0) > 0;

/** A copy of the child art with `pixels` (canvas = image coordinates here) painted opaque. */
function paintChild(s: Setup, pixels: readonly Px[]): TiledImage {
  const img = TiledImage.fromRGBA(s.child);
  for (const [x, y] of pixels) img.set(x, y, [0, 0, 255, 255]);
  return img;
}

/** The rest composite of two alpha masks, `upper` drawn over `lower`: `U`, `L` or `.` per pixel. */
function composite(upper: RgbaImage, lower: RgbaImage): string {
  const out: string[] = [];
  for (let y = 0; y < upper.height; y++) {
    let row = '';
    for (let x = 0; x < upper.width; x++) {
      row += alpha(upper, x, y) ? 'U' : alpha(lower, x, y) ? 'L' : '.';
    }
    out.push(row);
  }
  return out.join('\n');
}

describe('overlapMask: the worked examples of the contract (section 7)', () => {
  it('gappy_elbow, child under the parent: the hand-computed mask, nothing uncovered', () => {
    const s = elbow({ childUnder: true });
    const r = overlapMasks(s);
    expect(r.skipped).toEqual([]);
    const j = need(r.joints[0]);
    expect([j.bone, j.parent, j.paint]).toEqual(['lower', 'upper', 'child']);
    expect(j.mask).toEqual([
      [5, 4],
      [6, 4],
      [5, 5],
      [6, 5],
      [5, 6],
      [6, 6],
      [5, 7],
      [6, 7],
    ]);
    expect(j.uncovered).toEqual([]);
    // The image is a full-canvas layer at (0, 0): local equals canvas.
    expect(j.local).toEqual(j.mask);
    expect([j.layerId, j.partId, j.boneId]).toEqual([LAY('lower'), P('lower'), B('lower')]);
  });

  it('gappy_knee: the 3×3 dilation finds the two hidden pixels above the corner', () => {
    const s = knee({ childUnder: true });
    // The contract's fixture holds only the +10 frame (the real sweep also has a mirrored gap at -10).
    const all = need(jointCheck({ ...s, radius: 2, rangeDeg: 10, stepDeg: 10 }).joints[0]);
    expect(all.union).toEqual([
      [5, 5],
      [9, 5],
    ]);
    const plus10 = all.angles.filter((a) => a.angle === 10);
    const r = overlapMask({
      gaps: { pivot: all.pivot, angles: plus10, gapCount: 1, union: [[9, 5]] },
      parent: s.parent,
      childRest: s.child,
      paint: 'child',
      imageOrigin: [0, 0],
    });
    expect(r.mask).toEqual([
      [8, 4],
      [9, 4],
    ]);
    expect(r.uncovered).toEqual([]);
  });

  it('is the same function as the images-level overlapMask', () => {
    const s = elbow({ childUnder: true });
    const report = jointCheck(s);
    const gaps = need(report.joints[0]);
    const direct = overlapMask({
      gaps,
      parent: s.parent,
      childRest: s.child,
      paint: 'child',
      imageOrigin: [0, 0],
    });
    expect(direct).toEqual({
      paint: 'child',
      mask: need(overlapMasks(s).joints[0]).mask,
      local: need(overlapMasks(s).joints[0]).local,
      uncovered: [],
    });
  });
});

describe('overlapMask: painting inside the mask', () => {
  it('leaves the composite at rest unchanged, and closes the elbow gaps (real RotSprite)', () => {
    const s = elbow({ childUnder: true });
    const before = composite(s.parent, s.child);
    const j = need(overlapMasks(s).joints[0]);
    const painted = paintChild(s, j.mask);
    // The rest composite is bit-identical...
    expect(composite(s.parent, painted.toRGBA())).toBe(before);
    // ...and the joint check on the repainted art finds no gap any more.
    s.images.map.set(IMG('lower'), painted);
    expect(jointCheck(s).summary.gapCount).toBe(0);
  });

  it('closes the knee gap too', () => {
    const s = knee({ childUnder: true });
    const j = need(overlapMasks({ ...s, radius: 2 }).joints[0]);
    s.images.map.set(IMG('lower'), paintChild(s, j.mask));
    expect(jointCheck({ ...s, radius: 2 }).summary.gapCount).toBe(0);
  });

  it('holds for any random subset of the mask (seeded)', () => {
    const rand = prng(35);
    for (const s of [elbow({ childUnder: true }), knee({ childUnder: true })]) {
      const before = composite(s.parent, s.child);
      const j = need(overlapMasks({ ...s, radius: 4 }).joints[0]);
      expect(j.mask.length).toBeGreaterThan(0);
      for (let n = 0; n < 25; n++) {
        const subset = j.mask.filter(() => rand() < 0.5);
        expect(composite(s.parent, paintChild(s, subset).toRGBA())).toBe(before);
      }
    }
  });

  it('every mask pixel is parent-covered and not drawn by the child (child under)', () => {
    for (const s of [elbow({ childUnder: true }), knee({ childUnder: true })]) {
      const j = need(overlapMasks({ ...s, radius: 4 }).joints[0]);
      for (const [x, y] of j.mask) {
        expect(alpha(s.parent, x, y)).toBe(true);
        expect(alpha(s.child, x, y)).toBe(false);
      }
    }
  });
});

describe('overlapMask: child drawn over the parent', () => {
  it('paints the parent at the gap pixels, which stay hidden under the child', () => {
    const s = elbow();
    const r = overlapMasks(s);
    const j = need(r.joints[0]);
    expect(j.paint).toBe('parent');
    expect([j.layerId, j.partId, j.boneId]).toEqual([LAY('upper'), P('upper'), B('upper')]);
    const gaps = need(jointCheck(s).joints[0]);
    expect(j.mask).toEqual(gaps.union);
    expect(j.uncovered).toEqual([]);
    // Painting them on the parent leaves the rest composite alone: the child covers them.
    const parentPainted = TiledImage.fromRGBA(s.parent);
    for (const [x, y] of j.mask) parentPainted.set(x, y, [255, 0, 0, 255]);
    expect(composite(s.child, parentPainted.toRGBA())).toBe(composite(s.child, s.parent));
    for (const [x, y] of j.mask) expect(alpha(s.child, x, y)).toBe(true);
  });

  it('local = mask − (pivot − variant pivot) for a parent whose variant pivot is not the origin', () => {
    const s = elbow();
    // Shift the parent's variant pivot: the part now renders 3 px right and 1 px down of its pivot.
    const part = need(s.rig.parts.find((p) => p.id === P('upper')));
    const moved = {
      ...s.rig,
      parts: s.rig.parts.map((p) =>
        p === part ? { ...p, variants: [variant('upper', 'upper', { x: -3, y: -1 })] } : p,
      ),
    } satisfies JointRig;
    const j = need(overlapMasks({ ...s, rig: moved }).joints[0]);
    // The upper bone's pivot is (0, 0), so the image origin is (3, 1).
    expect(j.local).toEqual(j.mask.map(([x, y]) => [x - 3, y - 1]));
  });
});

describe('overlapMask: uncovered gaps and errors', () => {
  const gaps: JointGapResult = {
    pivot: [7, 5],
    angles: [{ angle: -30, gaps: [[7, 6]] }],
    gapCount: 1,
    union: [[7, 6]],
  };
  const legend = { P: [255, 0, 0, 255], C: [0, 0, 255, 255], '.': [0, 0, 0, 0] } as const;
  const img = (art: string): RgbaImage => asciiToImage(art, legend);

  it('reports a gap that no hidden pixel can serve', () => {
    // The parent ends three pixels short of the source block around (6, 6): nothing to paint under.
    const art = `
..............
..............
..............
..............
PPP....CCCCCCC
PPP....CCCCCCC
PPP....CCCCCCC
PPP....CCCCCCC
..............`;
    const parentArt = art.replaceAll('C', '.');
    const childArt = art.replaceAll('P', '.');
    const r = overlapMask({
      gaps,
      parent: img(parentArt),
      childRest: img(childArt),
      paint: 'child',
      imageOrigin: [0, 0],
    });
    expect(r.mask).toEqual([]);
    expect(r.uncovered).toEqual([[7, 6]]);
  });

  it('applies imageOrigin to local and not to mask', () => {
    const s = elbow({ childUnder: true });
    const g = need(jointCheck(s).joints[0]);
    const r = overlapMask({
      gaps: g,
      parent: s.parent,
      childRest: s.child,
      paint: 'child',
      imageOrigin: [-2, 3],
    });
    expect(r.local).toEqual(r.mask.map(([x, y]) => [x + 2, y - 3]));
  });

  it('does not change its inputs and is deterministic', () => {
    const s = elbow({ childUnder: true });
    const g = need(jointCheck(s).joints[0]);
    const snapshot = JSON.stringify(g);
    const parentBytes = Array.from(s.parent.data).join();
    const run = (): string =>
      JSON.stringify(
        overlapMask({
          gaps: g,
          parent: s.parent,
          childRest: s.child,
          paint: 'child',
          imageOrigin: [0, 0],
        }),
      );
    expect(run()).toBe(run());
    expect(JSON.stringify(g)).toBe(snapshot);
    expect(Array.from(s.parent.data).join()).toBe(parentBytes);
  });

  it('reports typed errors', () => {
    const s = elbow({ childUnder: true });
    const g = need(jointCheck(s).joints[0]);
    const base = {
      gaps: g,
      parent: s.parent,
      childRest: s.child,
      paint: 'child' as const,
      imageOrigin: [0, 0] as Px,
    };
    const code = (fn: () => unknown): string | undefined => {
      try {
        fn();
      } catch (e) {
        return e instanceof JointCheckError ? e.code : `other:${String(e)}`;
      }
      return undefined;
    };
    expect(code(() => overlapMask({ ...base, childRest: img('P') }))).toBe('SIZE_MISMATCH');
    expect(code(() => overlapMask({ ...base, imageOrigin: [0.5, 0] }))).toBe('BAD_PIVOT');
    expect(
      code(() =>
        overlapMask({
          ...base,
          gaps: { ...gaps, angles: [{ angle: 7.3, gaps: [[7, 6]] }] },
        }),
      ),
    ).toBe('BAD_ANGLE');
  });
});

describe('overlapMasks: preconditions and report shape', () => {
  it('leaves out joints without gaps', () => {
    const s = setup(
      `
..............
..............
..............
..............
PPPPPPPCCCCCCC
PPPPPPPCCCCCCC
PPPPPPPCCCCCCC
PPPPPPPCCCCCCC
..............`,
      [7, 5],
      0,
      { childUnder: true },
    );
    // Cap the end column of the parent into the child (clean_capped_elbow): no gaps, nothing to do.
    const capped = TiledImage.fromRGBA(s.child);
    for (let y = 4; y <= 7; y++) capped.set(6, y, [0, 0, 255, 255]);
    s.images.map.set(IMG('lower'), capped);
    const r = overlapMasks(s);
    expect(r.joints).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.params).toEqual({ rangeDeg: 30, stepDeg: 5, radius: 4 });
    expect(r.view).toBe('side');
  });

  it('skips a joint whose bone has two visible parts (ambiguous-parts)', () => {
    const s = elbow({ childUnder: true });
    const extra = {
      id: P('extra'),
      boneId: B('lower'),
      layerId: LAY('extra'),
      variants: [variant('extra', 'lower', { x: 7, y: 5 })],
    };
    const rig: JointRig = { ...s.rig, parts: [...s.rig.parts, extra] };
    const r = overlapMasks({ ...s, rig });
    expect(r.joints).toEqual([]);
    expect(r.skipped).toEqual([{ bone: 'lower', parent: 'upper', reason: 'ambiguous-parts' }]);
  });

  it('skips a joint whose painted part is drawn rotated at rest (rotated-rest)', () => {
    // drawnAngle 10 against a rest angle of 0: the child renders with a 350° residual at rest.
    const s = setup(ELBOW, [7, 5], 0, { childUnder: true, drawnAngle: 10 });
    const r = overlapMasks(s);
    expect(r.joints).toEqual([]);
    expect(r.skipped.map((k) => k.reason)).toEqual(['rotated-rest']);
  });
});

describe('checkOverlapPaint: painting outside the mask is reported', () => {
  const s = elbow({ childUnder: true });
  const j = need(overlapMasks(s).joints[0]);

  it('splits painted pixels into inside, outside-hidden and outside-visible', () => {
    const report = checkOverlapPaint({
      mask: j.mask,
      upper: s.parent,
      painted: [
        [6, 5], // in the mask
        [2, 5], // under the parent but not in the mask
        [11, 2], // open canvas: visible
        [6, 5], // duplicate
        [-1, 0], // off the canvas: visible
      ],
    });
    expect(report.inside).toEqual([[6, 5]]);
    expect(report.outsideHidden).toEqual([[2, 5]]);
    expect(report.outsideVisible).toEqual([
      [-1, 0],
      [11, 2],
    ]);
  });

  it('reports exactly the paint that changes the composite at rest', () => {
    const rand = prng(7);
    for (let n = 0; n < 20; n++) {
      // Newly painted pixels only: re-painting a pixel the child already draws changes nothing.
      const painted: Px[] = [];
      for (let i = 0; i < 12; i++) {
        const p: Px = [Math.floor(rand() * 14), Math.floor(rand() * 12)];
        if (!alpha(s.child, p[0], p[1])) painted.push(p);
      }
      const rep = checkOverlapPaint({ mask: j.mask, upper: s.parent, painted });
      const img = paintChild(s, painted);
      const after = composite(s.parent, img.toRGBA()).split('\n');
      const before = composite(s.parent, s.child).split('\n');
      const changed = new Set(
        painted
          .filter(([x, y]) => after[y]?.[x] !== before[y]?.[x])
          .map(([x, y]) => `${String(x)},${String(y)}`),
      );
      const visible = new Set(rep.outsideVisible.map(([x, y]) => `${String(x)},${String(y)}`));
      expect(visible).toEqual(changed);
      // Inside-mask paint never changes the composite.
      for (const [x, y] of rep.inside) expect(alpha(s.parent, x, y)).toBe(true);
    }
  });

  it('is clean when everything painted lies in the mask', () => {
    const report = checkOverlapPaint({ mask: j.mask, upper: s.parent, painted: j.mask });
    expect(report.inside).toEqual(j.mask);
    expect(report.outsideHidden).toEqual([]);
    expect(report.outsideVisible).toEqual([]);
  });

  it('rejects an upper image whose buffer does not match its size', () => {
    expect(() =>
      checkOverlapPaint({
        mask: [],
        upper: { ...s.parent, data: new Uint8Array(4) },
        painted: [],
      }),
    ).toThrow(JointCheckError);
  });
});
