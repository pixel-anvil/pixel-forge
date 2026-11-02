import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import type { RotatableImage } from '@pixel-forge/raster';
import { expectAscii } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import { baseHash, checkOverride, createPartCache, partTarget, renderParts } from '../src/index.js';
import type { FrameOverride, PartRender, RenderPartsInput } from '../src/index.js';
import { errorCode, prng } from './helpers.js';
import {
  B,
  IMG,
  Images,
  LAY,
  P,
  V,
  VIEW,
  VIEW2,
  anim,
  compose,
  fixtureImages,
  fixtureRig,
  indexed,
  legend,
  need,
  partOverride,
  rgba,
  variant,
} from './render-fixture.js';

const targetIn = (parts: readonly PartRender[], o: FrameOverride) => {
  if (o.target === 'final') return undefined;
  const id = o.target.partId;
  const p = parts.find((x) => x.partId === id);
  return p === undefined ? undefined : partTarget(p);
};

/** Records each override's baseHash under `parts` (what an editor stroke would write). */
const hashed = (
  parts: readonly PartRender[],
  overrides: FrameOverride[],
  images: Images,
): FrameOverride[] =>
  overrides.map((o) => {
    const t = targetIn(parts, o);
    if (t === undefined) throw new Error('no target');
    return { ...o, baseHash: baseHash(o, t, images) };
  });

describe('renderParts: W4 part overrides follow, go stale, stay valid', () => {
  const images = fixtureImages();
  const rig = fixtureRig();
  const raw = [
    partOverride('arm', 'arm', { x: 3, y: 0 }, { set: 'dot' }),
    partOverride('leg', 'leg', { x: 1, y: 1 }, { set: 'dot' }),
  ];
  const restParts = renderParts({ rig, animation: anim([{}], raw), frame: 0, images });
  const overrides = hashed(restParts, raw, images);
  const render = (keys: Parameters<typeof anim>[0][number]) =>
    renderParts({ rig, animation: anim([keys], overrides), frame: 0, images });
  const stale = (parts: readonly PartRender[]) =>
    overrides.map((o) => checkOverride(o, targetIn(parts, o), images).stale);

  it('at rest: both overrides drawn at pivot + anchor, both valid', () => {
    const parts = render({});
    expectAscii(
      compose(parts).toRGBA(),
      `
      ..........
      .......B..
      ..RRBY.BY.
      ..R....G..
      ..........
      ..........`,
      legend,
    );
    expect(stale(parts)).toEqual([false, false]);
    expect(parts.map((p) => p.overrides)).toEqual([[raw[1]?.id], [raw[0]?.id]]); // z: leg 0, arm 1
  });

  it('a translated part carries its override along and the override stays valid', () => {
    const parts = render({ bones: { [B('arm')]: { offset: { x: 1, y: 2 } } } });
    expectAscii(
      compose(parts).toRGBA(),
      `
      ..........
      .......B..
      .......BY.
      .......G..
      ...RRBY...
      ...R......`,
      legend,
    );
    expect(stale(parts)).toEqual([false, false]);
  });

  it('a rotated part: its override stays at pivot + anchor (not rotated, not dropped) and goes stale', () => {
    const parts = render({ bones: { [B('arm')]: { angle: 90 } } });
    // the arm turns 90° clockwise about its pivot (2, 2): (dx, dy) -> (-dy, dx)
    expectAscii(
      compose(parts).toRGBA(),
      `
      ..........
      .......B..
      .RR..Y.BY.
      ..R....G..
      ..B.......
      ..........`,
      legend,
    );
    const arm = checkOverride(need(overrides[0]), targetIn(parts, need(raw[0])), images);
    expect(arm).toMatchObject({ stale: true, reason: 'hash' });
    // the untouched leg's override stays valid although another part moved
    expect(stale(parts)).toEqual([true, false]);
  });

  it('an untouched part keeps a valid override while the other part rotates and translates', () => {
    const parts = render({ bones: { [B('arm')]: { angle: 45, offset: { x: 0, y: 1 } } } });
    expect(stale(parts)[1]).toBe(false);
  });

  it('a variant switch makes the override stale; switching back makes it valid again', () => {
    const switched = render({ parts: { [P('arm')]: { variant: V('arm2') } } });
    expect(stale(switched)).toEqual([true, false]);
    expect(stale(render({ parts: { [P('arm')]: { variant: V('arm') } } }))).toEqual([false, false]);
  });

  it('a stale override is no-target when its part is hidden, and the hidden part is not drawn', () => {
    const parts = render({ parts: { [P('leg')]: { visible: false } } });
    expect(parts.map((p) => p.partId)).toEqual([P('arm')]);
    const leg = need(overrides[1]);
    expect(checkOverride(leg, targetIn(parts, leg), images)).toEqual({
      id: leg.id,
      stale: true,
      reason: 'no-target',
    });
  });

  it('a full turn (360°) is the rest render, so the override is valid again', () => {
    expect(stale(render({ bones: { [B('arm')]: { angle: 360 } } }))).toEqual([false, false]);
  });
});

describe('renderParts: rotation and pivot alignment (FR-RIG-20 step 3)', () => {
  it('the variant pivot pixel lands exactly on the snapped pivot at every 7°, RotSprite', () => {
    // a child bone, so the pivot itself moves: shoulder (4, 4), elbow rest offset (5, 0)
    const images = new Images({ fore: rgba('RRMRR\nRRRRG\n.RRR.') });
    const rig = {
      bones: [{ id: B('sh') }, { id: B('el'), parentId: B('sh') }],
      parts: [
        {
          id: P('fore'),
          boneId: B('el'),
          layerId: LAY('fore'),
          variants: [variant('fore', 'fore', { x: 2, y: 0 })],
        },
      ],
      views: [
        {
          id: VIEW,
          directions: ['side'],
          rest: { [B('sh')]: { x: 4, y: 4, angle: 0 }, [B('el')]: { x: 5, y: 0, angle: 0 } },
          partVisibility: {},
          defaultZ: {},
        },
      ],
    };
    for (let a = 0; a < 360; a += 7) {
      const animation = anim([{ bones: { [B('sh')]: { angle: 30 }, [B('el')]: { angle: a } } }]);
      const [part] = renderParts({ rig, animation, frame: 0, images });
      if (part === undefined) throw new Error('no part');
      const px = part.pivot.x - part.offset.x;
      const py = part.pivot.y - part.offset.y;
      expect((part.image as TiledImage).get(px, py)).toEqual([255, 0, 255, 255]);
      expect(part.angle).toBe((30 + a) % 360);
    }
  });

  it('a pivot outside the drawing (a floating pixel) is honoured', () => {
    const images = new Images({ px: rgba('R') });
    const rig = fixtureRig();
    rig.parts = [
      {
        id: P('f'),
        boneId: B('arm'),
        layerId: LAY('f'),
        variants: [variant('f', 'px', { x: -2, y: 0 })],
      },
    ];
    const at = (angle: number) =>
      compose(
        renderParts({
          rig,
          animation: anim([{ bones: { [B('arm')]: { angle } } }]),
          frame: 0,
          images,
        }),
      );
    // the pixel sits 2 px right of the pivot (2, 2); at 90° it is 2 px below
    expectAscii(
      at(0).toRGBA(),
      '..........\n..........\n....R.....\n..........\n..........\n..........',
      legend,
    );
    expectAscii(
      at(90).toRGBA(),
      '..........\n..........\n..........\n..........\n..R.......\n..........',
      legend,
    );
  });

  it('flipX mirrors the part about its pivot column; its children are unaffected', () => {
    const images = fixtureImages();
    const parts = renderParts({
      rig: fixtureRig(),
      animation: anim([{ bones: { [B('arm')]: { flipX: true } } }]),
      frame: 0,
      images,
    });
    expect(parts.find((p) => p.partId === P('arm'))?.flipX).toBe(true);
    expectAscii(
      compose(parts).toRGBA(),
      `
      ..........
      .......B..
      BRR....B..
      ..R....G..
      ..........
      ..........`,
      legend,
    );
  });

  it("algorithm 'none' never rotates; 'nearest' agrees with RotSprite at quarter turns", () => {
    const images = fixtureImages();
    const rig = fixtureRig();
    const animation = anim([{ bones: { [B('arm')]: { angle: 90 } } }]);
    const draw = (rotation: 'none' | 'nearest' | 'rotsprite') => {
      const r = fixtureRig();
      r.parts = r.parts.map((p) => ({ ...p, rotation }));
      return compose(renderParts({ rig: r, animation, frame: 0, images })).toRGBA();
    };
    expectAscii(
      draw('none'),
      '..........\n.......B..\n..RRB..B..\n..R....G..\n..........\n..........',
      legend,
    );
    expect(draw('nearest')).toEqual(draw('rotsprite'));
    expect(rig.parts[0]?.rotation).toBeUndefined();
  });

  it('drawnAngle: the residual is worldAngle − drawnAngle, quantised exactly, in [0, 360)', () => {
    const images = fixtureImages();
    const rig = fixtureRig();
    const arm = rig.parts[0];
    if (arm === undefined) throw new Error('fixture');
    arm.variants = [variant('arm', 'arm', { x: 0, y: 0 }, { drawnAngle: 45.4 })];
    const view = rig.views[0];
    if (view === undefined) throw new Error('fixture');
    view.rest[B('arm')] = { x: 2, y: 2, angle: 90 };
    const residual = (key: number, q?: number) =>
      renderParts({
        rig,
        animation: anim([{ bones: { [B('arm')]: { angle: key } } }], [], 'once', q),
        frame: 0,
        images,
      }).find((p) => p.partId === P('arm'))?.angle;
    expect(residual(0)).toBe(45); // 90 − 45.4 = 44.6 → 45
    expect(residual(-90)).toBe(315); // 0 − 45.4 = −45.4 → −45 → 315
    expect(residual(0, 5)).toBe(45);
    expect(residual(0, 0.25)).toBe(44.5); // 44.6 → 44.5
  });
});

describe('renderParts: variants, visibility, z and part keys', () => {
  const images = fixtureImages();
  const ids = (parts: readonly PartRender[]) => parts.map((p) => p.partId);
  const variantAt = (animation: ReturnType<typeof anim>, frame: number) =>
    renderParts({ rig: fixtureRig(), animation, frame, images }).find((p) => p.partId === P('arm'))
      ?.variantId;

  it('sorts by z (part key, else view default, else 0); equal z keeps rig order or the layers order', () => {
    const rig = fixtureRig();
    expect(ids(renderParts({ rig, animation: anim([{}]), frame: 0, images }))).toEqual([
      P('leg'),
      P('arm'),
    ]);
    const raised = anim([{ parts: { [P('leg')]: { z: 5 } } }]);
    expect(ids(renderParts({ rig, animation: raised, frame: 0, images }))).toEqual([
      P('arm'),
      P('leg'),
    ]);
    const view = rig.views[0];
    if (view === undefined) throw new Error('fixture');
    view.defaultZ = {};
    expect(ids(renderParts({ rig, animation: anim([{}]), frame: 0, images }))).toEqual([
      P('arm'),
      P('leg'),
    ]);
    expect(
      ids(
        renderParts({
          rig,
          animation: anim([{}]),
          frame: 0,
          images,
          layers: [LAY('leg'), LAY('arm')],
        }),
      ),
    ).toEqual([P('leg'), P('arm')]);
  });

  it('the layers filter renders only the listed part layers', () => {
    const parts = renderParts({
      rig: fixtureRig(),
      animation: anim([{}]),
      frame: 0,
      images,
      layers: [LAY('arm')],
    });
    expect(ids(parts)).toEqual([P('arm')]);
  });

  it('visibility: part key, else the view, else visible; bones without a rest entry hide their parts', () => {
    const rig = fixtureRig();
    const view = rig.views[0];
    if (view === undefined) throw new Error('fixture');
    view.partVisibility = { [P('leg')]: false };
    expect(ids(renderParts({ rig, animation: anim([{}]), frame: 0, images }))).toEqual([P('arm')]);
    const shown = anim([{ parts: { [P('leg')]: { visible: true } } }]);
    expect(ids(renderParts({ rig, animation: shown, frame: 0, images }))).toEqual([
      P('leg'),
      P('arm'),
    ]);
    view.partVisibility = {};
    Reflect.deleteProperty(view.rest, B('leg'));
    expect(ids(renderParts({ rig, animation: anim([{}]), frame: 0, images }))).toEqual([P('arm')]);
  });

  it("variant: an explicit key wins, 'auto' is the view default until M1b, a part without a variant in the view is hidden", () => {
    expect(variantAt(anim([{ parts: { [P('arm')]: { variant: V('arm2') } } }]), 0)).toBe(V('arm2'));
    expect(variantAt(anim([{ parts: { [P('arm')]: { variant: 'auto' } } }]), 0)).toBe(V('arm'));
    const rig = fixtureRig();
    const leg = rig.parts[1];
    if (leg === undefined) throw new Error('fixture');
    leg.variants = [{ ...variant('leg', 'leg', { x: 0, y: 0 }), viewId: VIEW2 }];
    expect(ids(renderParts({ rig, animation: anim([{}]), frame: 0, images }))).toEqual([P('arm')]);
    // an explicit key may still pick a variant of another view
    const keyed = anim([{ parts: { [P('leg')]: { variant: V('leg') } } }]);
    expect(ids(renderParts({ rig, animation: keyed, frame: 0, images }))).toEqual([
      P('leg'),
      P('arm'),
    ]);
  });

  it('part keys step and hold like the bone channels: hold before the first key; a loop wraps', () => {
    const keys = [
      {},
      { parts: { [P('arm')]: { variant: V('arm2') } } },
      {},
      { parts: { [P('arm')]: { variant: V('arm') } } },
      {},
    ];
    const once = anim(keys);
    expect([0, 1, 2, 3, 4].map((f) => variantAt(once, f))).toEqual([
      V('arm2'),
      V('arm2'),
      V('arm2'),
      V('arm'),
      V('arm'),
    ]);
    const loop = anim(keys, [], 'loop');
    expect([0, 1, 2, 3, 4].map((f) => variantAt(loop, f))).toEqual([
      V('arm'),
      V('arm2'),
      V('arm2'),
      V('arm'),
      V('arm'),
    ]);
  });

  it('refuses unknown variants, missing images, unknown bones and non-integer pivots', () => {
    const rig = fixtureRig();
    expect(
      errorCode(() =>
        renderParts({
          rig,
          animation: anim([{ parts: { [P('arm')]: { variant: V('nope') } } }]),
          frame: 0,
          images,
        }),
      ),
    ).toBe('UNKNOWN_VARIANT');
    expect(
      errorCode(() => renderParts({ rig, animation: anim([{}]), frame: 0, images: new Images() })),
    ).toBe('IMAGE_MISSING');
    const missingOverride = anim([{}], [partOverride('x', 'arm', { x: 0, y: 0 }, { set: 'gone' })]);
    expect(
      errorCode(() => renderParts({ rig, animation: missingOverride, frame: 0, images })),
    ).toBe('IMAGE_MISSING');
    const orphan = fixtureRig();
    orphan.parts = [{ ...need(orphan.parts[0]), boneId: B('ghost') }];
    expect(
      errorCode(() => renderParts({ rig: orphan, animation: anim([{}]), frame: 0, images })),
    ).toBe('UNKNOWN_BONE');
    const frac = fixtureRig();
    frac.parts = [
      {
        ...need(frac.parts[0]),
        variants: [variant('arm', 'arm', { x: 0.5, y: 0 })],
      },
    ];
    expect(
      errorCode(() => renderParts({ rig: frac, animation: anim([{}]), frame: 0, images })),
    ).toBe('BAD_VALUE');
    expect(errorCode(() => renderParts({ rig, animation: anim([{}]), frame: 3, images }))).toBe(
      'UNKNOWN_FRAME',
    );
  });
});

describe('renderParts: part overrides (FR-RIG-20 step 4, clarification 11)', () => {
  it('erase (only mask 255 clears) runs before set, both at pivot + anchor, in array order', () => {
    const images = fixtureImages();
    // RGBA mask: alpha 255 clears, alpha 128 does not
    images.map.set(IMG('mask'), rgba('R\nh'));
    const mask255 = new IndexedImage(2, 1, 0);
    mask255.set(0, 0, 255);
    mask255.set(1, 0, 128);
    images.map.set(IMG('imask'), mask255);
    const overrides = [
      // clears (0,0) [255] but keeps (0,1) [alpha 128], then paints yellow on (0,0)
      partOverride('a', 'arm', { x: 0, y: 0 }, { erase: 'mask', set: 'dot' }),
      // indexed mask: clears (1,0) [255] and keeps (2,0) [128]
      partOverride('b', 'arm', { x: 1, y: 0 }, { erase: 'imask' }),
    ];
    const parts = renderParts({
      rig: fixtureRig(),
      animation: anim([{}], overrides),
      frame: 0,
      images,
    });
    expectAscii(
      compose(parts).toRGBA(),
      `
      ..........
      .......B..
      ..Y.B..B..
      ..R....G..
      ..........
      ..........`,
      legend,
    );
    // the base render is untouched by the overrides
    const arm = parts.find((p) => p.partId === P('arm'));
    expect((arm?.base.image as TiledImage).get(0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('a set that reaches past the part grows its image (above and left too)', () => {
    const images = fixtureImages();
    const parts = renderParts({
      rig: fixtureRig(),
      animation: anim([{}], [partOverride('a', 'arm', { x: -2, y: -1 }, { set: 'dot' })]),
      frame: 0,
      images,
    });
    const arm = parts.find((p) => p.partId === P('arm'));
    expect(arm?.offset).toEqual({ x: 0, y: 1 });
    expect([arm?.image.width, arm?.image.height]).toEqual([5, 3]);
    expect(arm?.base.offset).toEqual({ x: 2, y: 2 });
  });

  it('overrides of other frames, other parts and final overrides are not applied', () => {
    const images = fixtureImages();
    const other = partOverride('o', 'arm', { x: 3, y: 0 }, { set: 'dot' }, 1);
    const final: FrameOverride = {
      ...partOverride('f', 'arm', { x: 0, y: 0 }, { set: 'dot' }),
      target: 'final',
    };
    const parts = renderParts({
      rig: fixtureRig(),
      animation: anim([{}, {}], [other, final]),
      frame: 0,
      images,
    });
    expect(parts.every((p) => p.overrides.length === 0 && p.image === p.base.image)).toBe(true);
  });

  it('indexed parts: indexed overrides replace non-transparent indices; a colour-mode mismatch is refused', () => {
    const images = new Images({
      arm: indexed('112\n1..'),
      leg: indexed('3'),
      dot: indexed('4.\n.4'),
      rgb: rgba('Y'),
    });
    const rig = fixtureRig();
    rig.parts = rig.parts.map((p) => ({
      ...p,
      variants: [variant(p.id, p.id === P('arm') ? 'arm' : 'leg', { x: 0, y: 0 })],
    }));
    const parts = renderParts({
      rig,
      animation: anim([{}], [partOverride('a', 'arm', { x: 1, y: 0 }, { set: 'dot' })]),
      frame: 0,
      images,
    });
    const arm = parts.find((p) => p.partId === P('arm'))?.image as IndexedImage;
    expect(arm).toBeInstanceOf(IndexedImage);
    expect(Array.from(arm.toIndices())).toEqual([1, 4, 2, 1, 0, 4]);
    expect(
      errorCode(() =>
        renderParts({
          rig,
          animation: anim([{}], [partOverride('a', 'arm', { x: 0, y: 0 }, { set: 'rgb' })]),
          frame: 0,
          images,
        }),
      ),
    ).toBe('BAD_VALUE');
  });
});

describe('renderParts: the (variant, angle) cache', () => {
  it('hits for the same variant and angle, misses for a new angle, a new image or a new variant object', () => {
    const images = fixtureImages();
    const rig = fixtureRig();
    const cache = createPartCache();
    const run = (angle: number, r = rig) =>
      renderParts({
        rig: r,
        animation: anim([{ bones: { [B('arm')]: { angle } } }]),
        frame: 0,
        images,
        cache,
      });
    const a = run(30);
    expect(cache.stats).toEqual({ hits: 0, misses: 2 });
    const b = run(30);
    expect(cache.stats).toEqual({ hits: 2, misses: 2 });
    expect(b[1]?.image).toBe(a[1]?.image); // shared, never mutated
    run(31);
    expect(cache.stats).toEqual({ hits: 3, misses: 3 }); // the leg (rest) hits
    images.map.set(IMG('arm'), rgba('RRB\nR..')); // a new image instance
    run(31);
    expect(cache.stats).toEqual({ hits: 4, misses: 4 });
    const moved = fixtureRig(); // new variant objects, e.g. after a pivot edit
    run(31, moved);
    expect(cache.stats).toEqual({ hits: 4, misses: 6 });
    cache.clear();
    expect(cache.stats).toEqual({ hits: 0, misses: 0 });
  });

  it('a cached render equals an uncached one (the cache only saves work)', () => {
    const images = fixtureImages();
    const cache = createPartCache();
    for (const angle of [0, 13, 45, 90, 200, 13]) {
      const input: RenderPartsInput = {
        rig: fixtureRig(),
        animation: anim([{ bones: { [B('arm')]: { angle }, [B('leg')]: { flipX: true } } }]),
        frame: 0,
        images,
      };
      expect(compose(renderParts({ ...input, cache })).toRGBA()).toEqual(
        compose(renderParts(input)).toRGBA(),
      );
    }
  });
});

describe('renderParts: no new colours (FR-RIG-21)', () => {
  it('the parts of random images at random angles only use their variant colours', () => {
    const r = prng(33);
    const palette: [number, number, number, number][] = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [9, 8, 7, 200],
    ];
    const colours = (img: RotatableImage): Set<string> => {
      const out = new Set<string>();
      const d = (img as TiledImage).toRGBA().data;
      for (let p = 0; p < d.length; p += 4) if (d[p + 3] !== 0) out.add(d.slice(p, p + 4).join());
      return out;
    };
    for (let n = 0; n < 40; n++) {
      const w = 1 + Math.floor(r() * 7);
      const h = 1 + Math.floor(r() * 7);
      const img = new TiledImage(w, h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (r() < 0.6) img.set(x, y, palette[Math.floor(r() * 4)] ?? [0, 0, 0, 0]);
      const images = new Images({ arm: img, leg: rgba('B'), dot: rgba('Y') });
      const angle = Math.floor(r() * 360);
      const [, arm] = renderParts({
        rig: fixtureRig(),
        animation: anim([{ bones: { [B('arm')]: { angle } } }]),
        frame: 0,
        images,
      });
      if (arm === undefined) throw new Error('no arm');
      const src = colours(img);
      for (const c of colours(arm.image)) expect(src.has(c)).toBe(true);
    }
  });
});

describe('renderParts: indexed set with another transparent index (review fix 4)', () => {
  const setup = () => {
    const rig = fixtureRig();
    rig.parts = rig.parts.map((p) => ({
      ...p,
      variants: [variant(p.id, p.id === P('arm') ? 'arm' : 'leg', { x: 0, y: 0 })],
    }));
    const render = (images: Images) =>
      renderParts({
        rig,
        animation: anim([{}], [partOverride('a', 'arm', { x: 1, y: 0 }, { set: 'dot' })]),
        frame: 0,
        images,
      }).find((p) => p.partId === P('arm'))?.image as IndexedImage;
    return render;
  };

  it("skips the set's own transparent index, whatever the part's", () => {
    // part: transparent index 0; set: transparent index 7, so a 0 in the set is opaque but 7 is empty
    const render = setup();
    const arm = render(
      new Images({ arm: indexed('112\n1..'), leg: indexed('3'), dot: indexed('47\n73', 7) }),
    );
    // (1,0)=4 painted, (2,0) and (1,1) skipped (7 is empty in the set), (2,1)=3 painted
    expect(Array.from(arm.toIndices())).toEqual([1, 4, 2, 1, 0, 3]);
  });

  it("refuses an opaque set pixel whose index is the part's transparent index (it would erase)", () => {
    const render = setup();
    const images = new Images({
      arm: indexed('112\n1..'),
      leg: indexed('3'),
      dot: indexed('40\n04', 7), // 0 is opaque in the set, but is the part's transparent index
    });
    expect(errorCode(() => render(images))).toBe('BAD_VALUE');
  });
});

describe("renderParts: rotation 'none' has one cache entry per variant and flip (review fix 5)", () => {
  it('does not add entries per angle', () => {
    const images = fixtureImages();
    const cache = createPartCache();
    const r = fixtureRig();
    r.parts = r.parts.map((p) => ({ ...p, rotation: 'none' as const }));
    const run = (angle: number, flipX: boolean) =>
      renderParts({
        rig: r,
        animation: anim([{ bones: { [B('arm')]: { angle, flipX }, [B('leg')]: { angle } } }]),
        frame: 0,
        images,
        cache,
      });
    const first = run(10, false);
    expect(cache.stats).toEqual({ hits: 0, misses: 2 }); // arm and leg
    run(20, false);
    run(333, false);
    expect(cache.stats).toEqual({ hits: 4, misses: 2 }); // every other angle hits
    run(20, true); // the arm flipped is one more entry
    expect(cache.stats).toEqual({ hits: 5, misses: 3 });
    run(77, true);
    expect(cache.stats).toEqual({ hits: 7, misses: 3 });
    // the reported residual is still the pose's angle, but the pixels never rotate
    expect(first[0]?.angle).toBe(10);
  });
});

describe('renderParts: prepared per-animation part data (review fix 6)', () => {
  it('cached renders of every frame equal uncached ones, across part keys, loops and overrides', () => {
    const images = fixtureImages();
    const rig = fixtureRig();
    const animation = anim(
      [
        { parts: { [P('arm')]: { variant: V('arm2'), z: 3 } } },
        {},
        { parts: { [P('leg')]: { visible: false } } },
        {
          parts: {
            [P('arm')]: { variant: V('arm'), z: -1, visible: true },
            [P('leg')]: { visible: true },
          },
        },
      ],
      [
        partOverride('a', 'arm', { x: 1, y: 0 }, { set: 'dot' }, 1),
        partOverride('b', 'leg', { x: 0, y: 0 }, { set: 'dot' }, 2),
        partOverride('c', 'arm', { x: 2, y: 1 }, { set: 'dot' }, 1),
      ],
      'loop',
    );
    const cache = createPartCache();
    for (let pass = 0; pass < 2; pass++) {
      for (let frame = 0; frame < 4; frame++) {
        const input: RenderPartsInput = { rig, animation, frame, images };
        const cached = renderParts({ ...input, cache });
        const plain = renderParts(input);
        expect(cached.map((p) => [p.partId, p.z, p.variantId, p.overrides])).toEqual(
          plain.map((p) => [p.partId, p.z, p.variantId, p.overrides]),
        );
        expect(compose(cached).toRGBA()).toEqual(compose(plain).toRGBA());
      }
    }
    // frame 1: the arm's overrides a and c apply in array order; the leg shows (its key at frame 3 wraps back past frame 0), the arm holds z 3 from frame 0
    const f1 = renderParts({ rig, animation, frame: 1, images, cache });
    expect(f1.find((p) => p.partId === P('arm'))?.overrides).toEqual([
      partOverride('a', 'arm', { x: 0, y: 0 }, {}).id,
      partOverride('c', 'arm', { x: 0, y: 0 }, {}).id,
    ]);
    expect(f1.map((p) => [p.partId, p.z])).toEqual([
      [P('leg'), 0],
      [P('arm'), 3],
    ]);
  });
});
