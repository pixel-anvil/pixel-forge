// Synthetic oracle for the two T5.8 defects: a foot lost at the canvas edge (pixels.clipped) and
// speckle in rotated parts (rig.partHole). The numbers are worked out by hand from the geometry.
import { createRigRenderer, renderFrame } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { lint } from '../src/index.js';
import type { LintFinding, RuleId } from '../src/index.js';
import { pixelStore } from './fixtures.js';
import { partStore } from './part-fixture.js';

const only = (rule: RuleId, f: LintFinding[]): LintFinding[] => f.filter((x) => x.rule === rule);
const first = (f: LintFinding[]): LintFinding => {
  const x = f[0];
  if (x === undefined) throw new Error('no finding');
  return x;
};

const N = 12;
const picture = (on: (x: number, y: number) => boolean): string =>
  Array.from({ length: N }, (_, y) =>
    Array.from({ length: N }, (_, x) => (on(x, y) ? 'R' : '.')).join(''),
  ).join('\n');
const SOLID = picture(() => true);
const STRIPES = picture((_x, y) => y % 2 === 0);
const base = { w: 30, h: 30, pivot: { x: 6, y: 6 }, angles: [0] };

describe('pixels.clipped', () => {
  it('does not trigger inside the canvas or on an exact fit', () => {
    expect(lint(partStore({ ...base, art: SOLID, at: { x: 15, y: 15 } }))).toEqual([]);
    // The 12x12 part spans x 0..11, y 18..29: touching the edges is not a loss.
    expect(lint(partStore({ ...base, art: SOLID, at: { x: 6, y: 24 } }))).toEqual([]);
  });

  it('counts the pixels lost at one edge', () => {
    // at x 3: columns -3..8, so 3 columns of 12 rows are outside, on the left.
    const f = only('pixels.clipped', lint(partStore({ ...base, art: SOLID, at: { x: 3, y: 15 } })));
    expect(f).toHaveLength(1);
    const x = first(f);
    expect(x.severity).toBe('warning');
    expect(x.data).toMatchObject({
      count: 36,
      sides: { left: 36, right: 0, top: 0, bottom: 0 },
      bones: { b: 36 },
    });
    expect(x.location).toMatchObject({ frameIndex: 0, pixel: { x: -3, y: 9 } });
  });

  it('counts a corner once, and the sides separately', () => {
    // at (3, 27): columns -3..8, rows 21..32. Outside: 36 left + 36 bottom - 9 shared = 63.
    const f = only('pixels.clipped', lint(partStore({ ...base, art: SOLID, at: { x: 3, y: 27 } })));
    expect(first(f).data).toMatchObject({
      count: 63,
      sides: { left: 36, right: 0, top: 0, bottom: 36 },
    });
  });

  it('is per frame', () => {
    const ok = partStore({ ...base, art: SOLID, at: { x: 15, y: 15 }, angles: [0, 0] });
    expect(lint(ok)).toEqual([]);
    const bad = partStore({ ...base, art: SOLID, at: { x: 3, y: 15 }, angles: [0, 0] });
    expect(only('pixels.clipped', lint(bad)).map((x) => x.location.frameIndex)).toEqual([0, 1]);
  });

  it('ignores a hidden part layer', () => {
    const s = partStore({ ...base, art: SOLID, at: { x: 3, y: 15 }, hidden: true });
    expect(only('pixels.clipped', lint(s))).toEqual([]);
  });

  it('checks a mirror after the flip', () => {
    // Origin column 20, part at x 9..20: flipped (x' = 40 - x) it spans 20..31, so 2 columns of
    // 12 rows leave the canvas on the right. The authored animation fits.
    const s = partStore({ ...base, art: SOLID, at: { x: 15, y: 15 }, originX: 20, mirror: true });
    const f = only('pixels.clipped', lint(s));
    expect(f).toHaveLength(1);
    expect(first(f).location.animationId).toBe(s.doc.animations[1]?.id);
    expect(first(f).data).toMatchObject({ count: 24, sides: { right: 24 } });
  });

  it('loses a mirror pixel the renderer clipped before the flip', () => {
    // Part columns -3..8 (3 outside on the left), origin column 10: flipped (x' = 20 - x) they
    // span 12..23, inside. The renderer clips the source first, so 36 pixels are still lost.
    const s = partStore({ ...base, art: SOLID, at: { x: 3, y: 15 }, originX: 10, mirror: true });
    const mirrorId = s.doc.animations[1]?.id;
    const f = only('pixels.clipped', lint(s)).filter((x) => x.location.animationId === mirrorId);
    expect(f).toHaveLength(1);
    expect(first(f).data).toMatchObject({ count: 36, sides: { left: 36, right: 0 } });
    expect(first(f).location).toMatchObject({ pixel: { x: -3, y: 9 } });
  });

  it('caps the listed pixels with maxPixels, and has nothing to say without a rig', () => {
    const s = partStore({ ...base, art: SOLID, at: { x: 3, y: 15 } });
    const f = only('pixels.clipped', lint(s, { maxPixels: 2 }));
    expect(first(f).data).toMatchObject({
      count: 36,
      pixels: [
        [-3, 9],
        [-2, 9],
      ],
    });
    expect(only('pixels.clipped', lint(pixelStore({ frames: ['RR....'] })))).toEqual([]);
  });
});

describe('rig.partHole', () => {
  const holesIn = (s: ReturnType<typeof partStore>, frame: number): LintFinding[] =>
    only('rig.partHole', lint(s)).filter((x) => x.location.frameIndex === frame);

  it('finds the holes that rotating a striped part opens', () => {
    const s = partStore({ ...base, art: STRIPES, at: { x: 15, y: 15 }, angles: [0, 45] });
    expect(holesIn(s, 0)).toEqual([]); // not rotated, and the stripes have no 1 px holes
    const f = holesIn(s, 1);
    expect(f).toHaveLength(1);
    const x = first(f);
    expect(x.severity).toBe('warning');
    // Independent count on the render: a hole is a transparent pixel with four opaque neighbours.
    const img = renderFrame(s, { id: s.doc.animations[0]?.id ?? ('' as never) }, 1, {
      exportOnly: true,
      rig: createRigRenderer(),
    });
    const { data, width, height } = img.toRGBA();
    const a = (px: number, py: number): number => data[(py * width + px) * 4 + 3] ?? 0;
    const isHole = (px: number, py: number): boolean =>
      a(px, py) === 0 &&
      a(px - 1, py) > 0 &&
      a(px + 1, py) > 0 &&
      a(px, py - 1) > 0 &&
      a(px, py + 1) > 0;
    let n = 0;
    for (let py = 1; py < height - 1; py++)
      for (let px = 1; px < width - 1; px++) if (isHole(px, py)) n++;
    expect(n).toBeGreaterThan(0);
    expect(x.data).toMatchObject({ count: n, bones: { b: n } });
    for (const [px, py] of x.data.pixels as [number, number][]) expect(isHole(px, py)).toBe(true);
  });

  it('does not trigger on a solid part, rotated or not', () => {
    const s = partStore({ ...base, art: SOLID, at: { x: 15, y: 15 }, angles: [0, 20, 45, 90] });
    expect(only('rig.partHole', lint(s))).toEqual([]);
  });

  it('does not report a hole the drawn art already has', () => {
    const art = picture((x, y) => !(x === 6 && y === 6));
    const s = partStore({ ...base, art, at: { x: 15, y: 15 }, angles: [0, 45] });
    expect(only('rig.partHole', lint(s))).toEqual([]);
  });

  it('does not repeat itself on a mirror, and needs a rig', () => {
    const s = partStore({
      ...base,
      art: STRIPES,
      at: { x: 15, y: 15 },
      angles: [45],
      mirror: true,
    });
    expect(only('rig.partHole', lint(s)).map((x) => x.location.animationId)).toEqual([
      s.doc.animations[0]?.id,
    ]);
    expect(only('rig.partHole', lint(pixelStore({ frames: ['RR....'] })))).toEqual([]);
  });
});
