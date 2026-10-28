// T3.4: jointCheck / jointGaps against the hand-written T3.0 oracles in fixtures/joint/.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import type { Palette } from '@pixel-forge/raster';
import { asciiToImage } from '@pixel-forge/testkit';
import type { Legend } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import {
  JOINT_RADIUS_DEFAULT,
  JointCheckError,
  RigError,
  jointCheck,
  jointGaps,
} from '../src/index.js';
import type { JointGapInput, JointRig, Px } from '../src/index.js';
import { B, IMG, Images, LAY, P, VIEW, need, variant } from './render-fixture.js';

const dir = fileURLToPath(new URL('../../../fixtures/joint/', import.meta.url));
const PARENT: Legend = { P: [255, 0, 0, 255], B: [255, 0, 0, 255], C: [0, 0, 0, 0] };
const CHILD: Legend = { C: [0, 0, 255, 255], B: [0, 0, 255, 255], P: [0, 0, 0, 0] };

/** Parses `fixtures/joint/<name>.txt` (format in fixtures/joint/README.md). */
function load(name: string): JointGapInput {
  const head: Record<string, number[]> = {};
  const grids = new Map<number, string>();
  let cur: string[] | undefined;
  let frame = 0;
  const flush = (): void => {
    if (cur !== undefined && cur.length > 0) grids.set(frame, cur.join('\n'));
    cur = undefined;
  };
  for (const raw of readFileSync(`${dir}${name}.txt`, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    if (line === '') {
      flush();
      continue;
    }
    const m = /^(pivot|childDir|radius|frame)\s+(.*)$/.exec(line);
    if (m === null) {
      need(cur).push(line);
      continue;
    }
    const nums = need(m[2]).split(/\s+/).map(Number);
    if (m[1] === 'frame') {
      flush();
      frame = need(nums[0]);
      cur = [];
    } else head[need(m[1])] = nums;
  }
  flush();
  const rest = need(grids.get(0));
  return {
    parent: asciiToImage(rest, PARENT),
    childRest: asciiToImage(rest, CHILD),
    frames: [...grids]
      .filter(([a]) => a !== 0)
      .map(([angle, g]) => ({ angle, child: asciiToImage(g, CHILD) })),
    pivot: need(head.pivot) as unknown as Px,
    childDir: need(head.childDir?.[0]),
    radius: need(head.radius?.[0]),
  };
}

const names = readdirSync(dir)
  .filter((f) => f.endsWith('.txt'))
  .map((f) => f.slice(0, -4))
  .sort();

describe('jointGaps: the T3.0 hand-written fixtures', () => {
  it('finds all six fixtures', () => {
    expect(names).toHaveLength(6);
  });
  for (const name of names) {
    it(`${name} equals its expected.json exactly (deep equality and key order)`, () => {
      const expected: unknown = JSON.parse(readFileSync(`${dir}${name}.expected.json`, 'utf8'));
      const got = jointGaps(load(name));
      expect(got).toEqual(expected);
      expect(JSON.stringify(got)).toBe(JSON.stringify(expected));
    });
    it(`${name}: frame order does not matter`, () => {
      const f = load(name);
      expect(jointGaps({ ...f, frames: [...f.frames].reverse() })).toEqual(jointGaps(f));
    });
  }
  it('the gappy set has exactly 3 gaps, one angle each; every clean fixture has 0', () => {
    const gappy = names.filter((n) => n.startsWith('gappy_')).map((n) => jointGaps(load(n)));
    expect(gappy.reduce((n, r) => n + r.union.length, 0)).toBe(3);
    expect(gappy.every((r) => r.gapCount === r.union.length)).toBe(true);
    const clean = names.filter((n) => n.startsWith('clean_'));
    expect(clean).toHaveLength(4);
    expect(clean.map((n) => jointGaps(load(n)).gapCount)).toEqual([0, 0, 0, 0]);
  });
});

describe('jointGaps: window and radius (not pinned by the fixtures)', () => {
  const knee = load('gappy_knee');
  it('uses the radius argument', () => {
    expect(jointGaps(knee).union).toEqual([[9, 5]]);
    expect(jointGaps({ ...knee, radius: 5 }).union).toEqual([[9, 5]]);
    expect(jointGaps({ ...knee, radius: 1 }).gapCount).toBe(0);
  });
  it('rays do not leave the window', () => {
    // (9,5) is pinched by the parent end (9,4). Without that pixel the ray goes on to (9,3) and
    // (9,2), which are outside the window of radius 2 around (7,5), so no parent end is found.
    const data = new Uint8Array(knee.parent.data);
    data[(4 * knee.parent.width + 9) * 4 + 3] = 0;
    expect(jointGaps({ ...knee, parent: { ...knee.parent, data } }).gapCount).toBe(0);
  });
  it('allows a pivot off the canvas', () => {
    expect(jointGaps({ ...knee, pivot: [-50, -50] }).gapCount).toBe(0);
  });
});

describe('jointGaps: errors', () => {
  const f = load('gappy_elbow');
  const frame = need(f.frames[0]);
  const small = asciiToImage('P', PARENT);
  const code = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      return e instanceof JointCheckError ? e.code : `other:${String(e)}`;
    }
    return undefined;
  };
  it('reports the typed code', () => {
    expect(code(() => jointGaps({ ...f, childRest: small }))).toBe('SIZE_MISMATCH');
    expect(code(() => jointGaps({ ...f, frames: [{ angle: 5, child: small }] }))).toBe(
      'SIZE_MISMATCH',
    );
    expect(code(() => jointGaps({ ...f, parent: { ...f.parent, data: new Uint8Array(4) } }))).toBe(
      'SIZE_MISMATCH',
    );
    for (const angle of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(code(() => jointGaps({ ...f, frames: [{ ...frame, angle }] }))).toBe('BAD_ANGLE');
    }
    expect(code(() => jointGaps({ ...f, frames: [frame, frame] }))).toBe('BAD_ANGLE');
    expect(code(() => jointGaps({ ...f, childDir: 0.1 }))).toBe('BAD_ANGLE');
    for (const radius of [0, -1, 1.5, Number.NaN]) {
      expect(code(() => jointGaps({ ...f, radius }))).toBe('BAD_RADIUS');
    }
    expect(code(() => jointGaps({ ...f, pivot: [1.5, 2] }))).toBe('BAD_PIVOT');
    expect(code(() => jointGaps({ ...f, pivot: [1, Number.NaN] }))).toBe('BAD_PIVOT');
  });
  it('does not change its inputs', () => {
    const before = Array.from(frame.child.data).join();
    jointGaps(f);
    expect(Array.from(frame.child.data).join()).toBe(before);
  });
});

// ---- jointCheck on a rig built from a fixture ------------------------------------------------------

/** Two bones (`upper` root, `lower` child) whose parts are the fixture's parent and child masks at rest. */
function fixtureRig(name: string) {
  const input = load(name);
  const images = new Images();
  images.map.set(IMG('upper'), TiledImage.fromRGBA(input.parent));
  images.map.set(IMG('lower'), TiledImage.fromRGBA(input.childRest));
  const [px, py] = input.pivot;
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
        // The variant pivot is the canvas pivot: the image is a full-canvas layer at offset (0, 0).
        variants: [variant('lower', 'lower', { x: px, y: py })],
      },
    ],
    views: [
      {
        id: VIEW,
        name: 'side',
        directions: ['side'],
        rest: {
          [B('upper')]: { x: 0, y: 0, angle: 0 },
          [B('lower')]: { x: px, y: py, angle: input.childDir },
        },
        partVisibility: {},
        defaultZ: {},
      },
    ],
  };
  return { rig, images, input, canvas: { w: input.parent.width, h: input.parent.height } };
}

describe('jointCheck', () => {
  it('reports pivot, defaults, sweep order and summary of a one-joint rig', () => {
    const { rig, images, canvas } = fixtureRig('clean_capped_elbow');
    const r = jointCheck({ rig, images, canvas });
    expect(r.view).toBe('side');
    expect(r.params).toEqual({ rangeDeg: 30, stepDeg: 5, radius: JOINT_RADIUS_DEFAULT });
    expect(r.joints).toHaveLength(1);
    const j = need(r.joints[0]);
    expect([j.bone, j.parent, j.pivot]).toEqual(['lower', 'upper', [7, 5]]);
    expect(j.angles.map((a) => a.angle)).toEqual([
      -30, -25, -20, -15, -10, -5, 5, 10, 15, 20, 25, 30,
    ]);
    expect(Object.keys(j)).toEqual(['bone', 'parent', 'pivot', 'angles', 'gapCount', 'union']);
    expect(r.summary).toEqual({ joints: 1, jointsWithGaps: 0, gapCount: 0, unionCount: 0 });
  });

  it('finds the seeded elbow gaps through the real RotSprite render', () => {
    const { rig, images, canvas } = fixtureRig('gappy_elbow');
    const r = jointCheck({ rig, images, canvas });
    const j = need(r.joints[0]);
    const at = (a: number): Px[] => need(j.angles.find((x) => x.angle === a)).gaps;
    // The fixture's -30 and +30 frames came from the same RotSprite.
    expect(at(-30)).toEqual([[7, 6]]);
    expect(at(30)).toEqual([[7, 4]]);
    expect(r.summary.jointsWithGaps).toBe(1);
  });

  it('is deterministic, with or without a cache', () => {
    const { rig, images, canvas } = fixtureRig('gappy_elbow');
    const a = jointCheck({ rig, images, canvas });
    const b = jointCheck({ rig, images, canvas, radius: 4, rangeDeg: 30, stepDeg: 5 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('honours rangeDeg, stepDeg and radius', () => {
    const { rig, images, canvas } = fixtureRig('gappy_elbow');
    const r = jointCheck({ rig, images, canvas, rangeDeg: 12, stepDeg: 4, radius: 2 });
    expect(r.params).toEqual({ rangeDeg: 12, stepDeg: 4, radius: 2 });
    expect(need(r.joints[0]).angles.map((a) => a.angle)).toEqual([-12, -8, -4, 4, 8, 12]);
    // A step larger than the range leaves no angle to check.
    const none = jointCheck({ rig, images, canvas, rangeDeg: 3, stepDeg: 5 });
    expect(need(none.joints[0]).angles).toEqual([]);
  });

  it('rejects a bad sweep, radius and canvas', () => {
    const { rig, images, canvas } = fixtureRig('gappy_elbow');
    const bads = [
      { rangeDeg: 0 },
      { rangeDeg: Number.NaN },
      { stepDeg: 0 },
      { stepDeg: -5 },
      { stepDeg: 1e-9 },
    ];
    for (const bad of bads) {
      expect(() => jointCheck({ rig, images, canvas, ...bad })).toThrow(RigError);
    }
    expect(() => jointCheck({ rig, images, canvas, radius: 0 })).toThrow(JointCheckError);
    expect(() => jointCheck({ rig, images, canvas: { w: 0, h: 4 } })).toThrow(RigError);
  });

  it('skips bones without visible parts and does not re-attach their children', () => {
    const { rig, images, canvas } = fixtureRig('gappy_elbow');
    const hidden = { [P('lower')]: { visible: false } };
    expect(jointCheck({ rig, images, canvas, partKeys: hidden }).joints).toEqual([]);
    const three: JointRig = {
      ...rig,
      bones: [...rig.bones, { id: B('tip'), name: 'tip', parentId: B('lower') }],
      parts: [
        ...rig.parts,
        {
          id: P('tip'),
          boneId: B('tip'),
          layerId: LAY('tip'),
          variants: [variant('tip', 'lower', { x: 0, y: 0 })],
        },
      ],
      views: rig.views.map((v) => ({
        ...v,
        rest: { ...v.rest, [B('tip')]: { x: 0, y: 0, angle: 0 } },
      })),
    };
    // 'lower' has no visible part: 'tip' is not attached to 'upper', and 'lower' is no joint either.
    expect(jointCheck({ rig: three, images, canvas, partKeys: hidden }).joints).toEqual([]);
    const all = jointCheck({ rig: three, images, canvas }).joints.map(
      (j) => `${j.parent}>${j.bone}`,
    );
    // Sorted by the child's name: lower, then tip.
    expect(all).toEqual(['upper>lower', 'lower>tip']);
  });

  it('selects the view by direction and fails for an unknown one', () => {
    const { rig, images, canvas } = fixtureRig('clean_capped_elbow');
    expect(jointCheck({ rig, images, canvas, direction: 'side' }).view).toBe('side');
    expect(() => jointCheck({ rig, images, canvas, direction: 'up' })).toThrow(RigError);
  });

  it('reads indexed variants: transparent index, or alpha through a palette', () => {
    const { rig, images, canvas } = fixtureRig('gappy_elbow');
    const toIndexed = (img: TiledImage, alphaIdx: number): IndexedImage => {
      const rgba = img.toRGBA();
      const idx = new Uint8Array(rgba.width * rgba.height);
      for (let i = 0; i < idx.length; i++) idx[i] = (rgba.data[i * 4 + 3] ?? 0) > 0 ? alphaIdx : 0;
      return IndexedImage.fromIndices(rgba.width, rgba.height, idx, 0);
    };
    const idxImages = new Images();
    for (const k of ['upper', 'lower'] as const) {
      idxImages.map.set(IMG(k), toIndexed(need(images.map.get(IMG(k))) as TiledImage, 1));
    }
    const want = JSON.stringify(jointCheck({ rig, images, canvas }));
    expect(JSON.stringify(jointCheck({ rig, images: idxImages, canvas }))).toBe(want);
    const palette: Palette = [
      [0, 0, 0, 0],
      [9, 9, 9, 255],
    ];
    expect(JSON.stringify(jointCheck({ rig, images: idxImages, canvas, palette }))).toBe(want);
    // Index 1 is fully transparent in the palette: the parts are still visible parts (so there is a
    // joint), but they cover nothing, so there is nothing to report.
    const clear: Palette = [
      [0, 0, 0, 0],
      [9, 9, 9, 0],
    ];
    const none = jointCheck({ rig, images: idxImages, canvas, palette: clear });
    expect(none.summary).toEqual({ joints: 1, jointsWithGaps: 0, gapCount: 0, unionCount: 0 });
    expect(() => jointCheck({ rig, images: idxImages, canvas, palette: [[0, 0, 0, 0]] })).toThrow(
      RigError,
    );
  });
});
