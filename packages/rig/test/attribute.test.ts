import { IndexedImage, TiledImage, composite } from '@pixel-forge/raster';
import type { Rgba, RotatableImage } from '@pixel-forge/raster';
import type { BoneKey, PartId } from '@pixel-forge/schema';
import { asciiToImage, expectAscii } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import {
  RigError,
  attributeEdit,
  checkOverride,
  paintOverride,
  partTarget,
  renderParts,
} from '../src/index.js';
import type {
  AttributedOverride,
  EditContext,
  EditRender,
  FrameOverride,
  PartRender,
  PartRig,
} from '../src/index.js';
import { errorCode } from './helpers.js';
import type { Images } from './render-fixture.js';
import {
  B,
  F,
  IMG,
  LAY,
  OV,
  P,
  anim,
  fixtureImages,
  fixtureRig,
  indexed,
  legend,
  need,
  variant,
} from './render-fixture.js';

/** The fixture legend plus `W`, the white of an erase mask, and `c`, a translucent cyan. */
const L = { ...legend, W: [255, 255, 255, 255], c: [0, 255, 255, 100] } as const;
const img = (ascii: string): TiledImage => TiledImage.fromRGBA(asciiToImage(ascii, L));
const got = (i: RotatableImage | undefined): RotatableImage => need(i);

const PALETTE: Rgba[] = [
  [0, 0, 0, 0],
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [255, 255, 0, 255],
  [255, 0, 255, 255],
  [9, 9, 9, 0], // 6: a second alpha-0 entry
  [7, 7, 7, 0], // 7: a third
];

const toRgba = (i: RotatableImage): TiledImage => {
  if (i instanceof TiledImage) return i;
  const lut = PALETTE.slice();
  lut[i.transparentIndex] = [0, 0, 0, 0];
  return TiledImage.fromRGBA(i.toRGBA(lut));
};

/**
 * A miniature core: the parts composited in order on a 10×6 canvas, then `above` (a pixel layer over
 * the rig block), then the final overrides.
 */
function compose(
  parts: readonly PartRender[],
  finals: readonly { o: FrameOverride; set?: RotatableImage; erase?: RotatableImage }[] = [],
  above?: TiledImage,
): EditRender {
  const canvas = new TiledImage(10, 6);
  for (const p of parts) composite(canvas, toRgba(p.image), { x: p.offset.x, y: p.offset.y });
  if (above !== undefined) composite(canvas, above);
  const result = canvas.clone();
  for (const f of finals) {
    paintOverride(result, f.o.anchor, {
      erase: f.erase,
      set: f.set === undefined ? undefined : toRgba(f.set),
    });
  }
  return { finalTarget: canvas, result };
}

interface Scene {
  rig: PartRig;
  images: Images;
  overrides: FrameOverride[];
  above?: TiledImage;
}

const scene = (rig: PartRig = fixtureRig(), images = fixtureImages()): Scene => ({
  rig,
  images,
  overrides: [],
});

const partsOf = (s: Scene, bones: Partial<Record<string, BoneKey>> = {}): PartRender[] =>
  renderParts({
    rig: s.rig,
    animation: anim([{ bones }], s.overrides),
    frame: 0,
    images: s.images,
  });

const finalsOf = (s: Scene) =>
  s.overrides
    .filter((o) => o.target === 'final')
    .map((o) => ({
      o,
      ...(o.set === undefined ? {} : { set: need(s.images.image(o.set)) }),
      ...(o.erase === undefined ? {} : { erase: need(s.images.image(o.erase)) }),
    }));

const renderOf = (s: Scene, bones: Partial<Record<string, BoneKey>> = {}): EditRender =>
  compose(partsOf(s, bones), finalsOf(s), s.above);

function ctxOf(
  s: Scene,
  bones: Partial<Record<string, BoneKey>> = {},
  extra: Partial<EditContext> = {},
): EditContext {
  const finals = finalsOf(s);
  return {
    parts: partsOf(s, bones),
    render: (parts) => compose(parts, finals, s.above),
    palette: PALETTE,
    ...extra,
  };
}

/** Writes the attributed overrides into the scene, as core's `attributeEditTx` does. */
function apply(s: Scene, list: readonly AttributedOverride[]): void {
  list.forEach((a, i) => {
    const tag = `att${String(s.overrides.length)}_${String(i)}`;
    if (a.set !== undefined) s.images.map.set(IMG(`${tag}s`), a.set);
    if (a.erase !== undefined) s.images.map.set(IMG(`${tag}e`), a.erase);
    s.overrides.push({
      id: OV(tag),
      frameId: F(0),
      target: a.target,
      anchor: a.anchor,
      ...(a.set === undefined ? {} : { set: IMG(`${tag}s`) }),
      ...(a.erase === undefined ? {} : { erase: IMG(`${tag}e`) }),
      baseHash: a.baseHash,
    });
  });
}

/** Each override of the scene checked against its target in the pose `bones`. */
function checks(s: Scene, bones: Partial<Record<string, BoneKey>> = {}): (string | false)[] {
  const parts = partsOf(s, bones);
  const finalTarget = compose(parts, [], s.above).finalTarget;
  return s.overrides.map((o) => {
    const target =
      o.target === 'final'
        ? { image: finalTarget, offset: { x: 0, y: 0 } }
        : (() => {
            const partId: PartId = o.target.partId;
            const p = parts.find((x) => x.partId === partId);
            return p === undefined ? undefined : partTarget(p);
          })();
    const c = checkOverride(o, target, s.images, PALETTE);
    return c.stale ? (c.reason ?? 'stale') : false;
  });
}

/** Attributes `edited` against the scene's current render and applies it; returns the overrides. */
function edit(
  s: Scene,
  edited: TiledImage,
  bones: Partial<Record<string, BoneKey>> = {},
  extra: Partial<EditContext> = {},
): AttributedOverride[] {
  const before = renderOf(s, bones).result;
  const list = attributeEdit(ctxOf(s, bones, extra), before, edited);
  apply(s, list);
  // round trip: the render with the overrides is `edited`, and every new override is valid
  expect(renderOf(s, bones).result.hashRGBA()).toBe(edited.hashRGBA());
  expect(checks(s, bones).slice(s.overrides.length - list.length)).toEqual(list.map(() => false));
  return list;
}

describe('attributeEdit: hand-written cases (FR-RIG-22, FR-RIG-24)', () => {
  it('the fixture renders the arm at pivot (2, 2) and the leg at (7, 1)', () => {
    expectAscii(
      renderOf(scene()).result.toRGBA(),
      `
      ..........
      .......B..
      ..RRB..B..
      ..R....G..
      ..........
      ..........`,
      L,
    );
  });

  it('an edit inside one part becomes a part override anchored to its pivot', () => {
    const s = scene();
    const list = edit(
      s,
      img(`
      ..........
      .......B..
      ..RYB..B..
      ..M....G..
      ..........
      ..........`),
    );
    expect(list).toHaveLength(1);
    const [o] = list as [AttributedOverride];
    expect(o.target).toEqual({ partId: P('arm') });
    expect(o.anchor).toEqual({ x: 0, y: 0 }); // bbox (2..3, 2..3) minus the pivot (2, 2)
    expectAscii(toRgba(got(o.set)).toRGBA(), '.Y\nM.', L);
    expect(o.erase).toBeUndefined();
  });

  it('an edit straddling two parts becomes one final override in canvas coordinates', () => {
    const s = scene();
    const bones = { [B('arm')]: { offset: { x: 2, y: 0 } } }; // the arm's tip now touches the leg
    expectAscii(
      renderOf(s, bones).result.toRGBA(),
      `
      ..........
      .......B..
      ....RRBB..
      ....R..G..
      ..........
      ..........`,
      L,
    );
    const list = edit(
      s,
      img(`
      ..........
      .......B..
      ....RRYY..
      ....R..G..
      ..........
      ..........`),
      bones,
    );
    expect(list.map((o) => o.target)).toEqual(['final']);
    expect(list[0]?.anchor).toEqual({ x: 6, y: 2 });
    expectAscii(toRgba(got(list[0]?.set)).toRGBA(), 'YY', L);
  });

  it('an erase at the silhouette becomes a part erase mask (255 where it clears)', () => {
    const s = scene();
    const list = edit(
      s,
      img(`
      ..........
      .......B..
      ..RR...B..
      .......G..
      ..........
      ..........`),
    );
    expect(list).toHaveLength(1);
    const [o] = list as [AttributedOverride];
    expect(o.target).toEqual({ partId: P('arm') });
    expect(o.anchor).toEqual({ x: 0, y: 0 });
    expect(o.set).toBeUndefined();
    // two components (not 8-connected), one part: merged into one mask over their bbox
    expect(o.erase).toBeInstanceOf(IndexedImage); // an 8-bit mask, not RGBA (clarification 8)
    expect([o.erase?.width, o.erase?.height]).toEqual([3, 2]);
    expect(Array.from(need(o.erase).toIndices())).toEqual([0, 0, 255, 255, 0, 0]);
  });

  it('an addition just outside a silhouette is final; separate edits of two parts are two part overrides', () => {
    const s = scene();
    const list = edit(
      s,
      img(`
      ..........
      .......B..
      ..RRBY.M..
      ..G....G..
      ..........
      ..........`),
    );
    // (5, 2) touches the arm's B but lies outside every part; (2, 3) and (7, 2) lie inside one each
    expect(list.map((o) => o.target)).toEqual([
      { partId: P('leg') },
      { partId: P('arm') },
      'final',
    ]);
    expect(list.map((o) => o.anchor)).toEqual([
      { x: 0, y: 1 }, // (7, 2) − leg pivot (7, 1)
      { x: 0, y: 1 }, // (2, 3) − arm pivot (2, 2)
      { x: 5, y: 2 }, // canvas
    ]);
    expectAscii(toRgba(got(list[2]?.set)).toRGBA(), 'Y', L);
  });

  it('then a re-pose (W4): the part override follows a translation and goes stale on rotation', () => {
    const s = scene();
    edit(
      s,
      img(`
      ..........
      .......B..
      ..RYB..B..
      ..R....G..
      ..........
      ..........`),
    );
    const moved = { [B('arm')]: { offset: { x: 1, y: 2 } } };
    expectAscii(
      renderOf(s, moved).result.toRGBA(),
      `
      ..........
      .......B..
      .......B..
      .......G..
      ...RYB....
      ...R......`,
      L,
    );
    expect(checks(s, moved)).toEqual([false]);
    const turned = { [B('arm')]: { angle: 90 } };
    expect(checks(s, turned)).toEqual(['hash']);
    // stale overrides are still applied at pivot + anchor
    expect(renderOf(s, turned).result.toRGBA().data).not.toEqual(
      renderOf(scene(), turned).result.toRGBA().data,
    );
  });
});

describe('attributeEdit: exact round trips', () => {
  it('nothing changed: no overrides; alpha-0 colour bytes do not count as a change', () => {
    const s = scene();
    const before = renderOf(s).result;
    const edited = before.clone();
    edited.set(0, 0, [9, 9, 9, 0]);
    expect(attributeEdit(ctxOf(s), before, edited)).toEqual([]);
  });

  it('translucent edits replace instead of blending: erase then set, on parts and finals', () => {
    const s = scene();
    const list = edit(
      s,
      img(`
      c.........
      .......B..
      ..RcB..B..
      ..R....G..
      ..........
      ..........`),
    );
    expect(list.map((o) => o.target)).toEqual([{ partId: P('arm') }, 'final']);
    const [part, final] = list as [AttributedOverride, AttributedOverride];
    expect(Array.from(need(part.erase).toIndices())).toEqual([255]); // over an opaque part pixel: erase first
    expect(final.erase).toBeUndefined(); // over a transparent pixel: set alone is exact
  });

  it('a part pixel hidden under a layer above is demoted to the final override', () => {
    const s = scene();
    s.above = img(`
      ..........
      ..........
      ...M......
      ..........
      ..........
      ..........`);
    const list = edit(
      s,
      img(`
      ..........
      .......B..
      ..RYB..G..
      ..R....G..
      ..........
      ..........`),
    );
    // (3, 2) lies in the arm's footprint but the layer above covers it; (7, 2) is a clean leg edit
    expect(list.map((o) => o.target)).toEqual([{ partId: P('leg') }, 'final']);
    expect(list[1]?.anchor).toEqual({ x: 3, y: 2 });
  });

  it('builds on existing overrides: a second edit appends after the first, all valid', () => {
    const s = scene();
    edit(
      s,
      img(`
      Y.........
      .......B..
      ..RYB..B..
      ..R....G..
      ..........
      ..........`),
    );
    const second = edit(
      s,
      img(`
      YY........
      .......B..
      ..MYB..B..
      ..R....G..
      ..........
      ..........`),
    );
    expect(second.map((o) => o.target)).toEqual([{ partId: P('arm') }, 'final']);
    expect(s.overrides).toHaveLength(4);
    // a pixel under an existing final override is final again, painted over it
    const third = edit(
      s,
      img(`
      MY........
      .......B..
      ..MYB..B..
      ..R....G..
      ..........
      ..........`),
    );
    expect(third.map((o) => o.target)).toEqual(['final']);
  });

  it('indexed parts get indexed sets; a colour the palette lacks demotes to an RGBA final', () => {
    const rig = fixtureRig();
    const images = fixtureImages();
    images.map.set(IMG('arm'), indexed('113\n1..'));
    const s = scene(rig, images);
    expectAscii(
      renderOf(s).result.toRGBA(),
      `
      ..........
      .......B..
      ..RRB..B..
      ..R....G..
      ..........
      ..........`,
      L,
    );
    const list = edit(
      s,
      img(`
      ..........
      .......B..
      ..RRY..B..
      ..h....G..
      ..........
      ..........`),
    );
    expect(list.map((o) => o.target)).toEqual([{ partId: P('arm') }, 'final']);
    expect(list[0]?.anchor).toEqual({ x: 2, y: 0 });
    const set = got(list[0]?.set);
    expect(set).toBeInstanceOf(IndexedImage);
    expect(Array.from((set as IndexedImage).toIndices())).toEqual([4]);
    expect(list[1]?.set).toBeInstanceOf(TiledImage);
    // an erase on an indexed part
    expect(
      edit(
        s,
        img(`
      ..........
      .......B..
      ...RY..B..
      ..h....G..
      ..........
      ..........`),
      ).map((o) => o.target),
    ).toEqual([{ partId: P('arm') }]);
    // the erase at (2, 2) changes the canvas under the earlier final override at (2, 3) (its region
    // is the pixel ±1), so that one goes stale: a new part override can stale an existing final
    expect(checks(s)).toEqual([false, 'hash', false]);
  });

  it("colorMode 'indexed': final sets are indexed; missing colours and palettes are refused", () => {
    const s = scene();
    const list = edit(
      s,
      img(`
      Y.........
      .......B..
      ..RRB..B..
      ..R....G..
      ..........
      ..........`),
      {},
      { colorMode: 'indexed' },
    );
    expect(list[0]?.set).toBeInstanceOf(IndexedImage);
    const before = renderOf(s).result;
    const odd = before.clone();
    odd.set(9, 5, [1, 2, 3, 255]);
    expect(
      errorCode(() => attributeEdit(ctxOf(s, {}, { colorMode: 'indexed' }), before, odd)),
    ).toBe('BAD_VALUE');
    const opaque: Rgba[] = [[255, 255, 0, 255]];
    expect(
      errorCode(() =>
        attributeEdit(ctxOf(s, {}, { colorMode: 'indexed', palette: opaque }), before, odd),
      ),
    ).toBe('BAD_VALUE');
  });

  it('refuses an edited image of another size', () => {
    const s = scene();
    expect(errorCode(() => attributeEdit(ctxOf(s), renderOf(s).result, new TiledImage(3, 3)))).toBe(
      'BAD_VALUE',
    );
  });

  it('refuses a `before` that is not the render of ctx.parts (reason before-mismatch)', () => {
    const s = scene();
    const edited = renderOf(s).result.clone();
    edited.set(3, 2, [255, 255, 0, 255]);
    const reason = (before: TiledImage, ctx: EditContext = ctxOf(s)): unknown => {
      try {
        attributeEdit(ctx, before, edited);
      } catch (e) {
        expect(e).toBeInstanceOf(RigError);
        expect((e as RigError).code).toBe('BAD_ARGUMENT');
        return (e as RigError).reason;
      }
      return undefined;
    };
    // a pixel differs from the render
    const other = renderOf(s).result.clone();
    other.set(9, 5, [1, 2, 3, 255]);
    expect(reason(other)).toBe('before-mismatch');
    // the render has another size
    const small: EditContext = {
      ...ctxOf(s),
      render: () => ({ finalTarget: new TiledImage(2, 2), result: new TiledImage(2, 2) }),
    };
    expect(reason(renderOf(s).result, small)).toBe('before-mismatch');
    // a transparent pixel's colour bytes do not matter
    const bytes = renderOf(s).result.clone();
    bytes.set(0, 0, [5, 6, 7, 0]);
    expect(reason(bytes)).toBeUndefined();
  });

  it('the footprint of an indexed part treats every alpha-0 palette entry as transparent', () => {
    const images = fixtureImages();
    // entries 6 and 7 are alpha 0 but not the transparent index (0): the part draws nothing there
    images.map.set(IMG('arm'), indexed('113\n167'));
    const s = scene(fixtureRig(), images);
    expectAscii(
      renderOf(s).result.toRGBA(),
      `
      ..........
      .......B..
      ..RRB..B..
      ..R....G..
      ..........
      ..........`,
      L,
    );
    // (3,3) and (4,3) lie in the arm image's box but outside its footprint: final, not part
    const list = edit(
      s,
      img(`
      ..........
      .......B..
      ..RRB..B..
      ..RYY..G..
      ..........
      ..........`),
    );
    expect(list.map((o) => o.target)).toEqual(['final']);
    expect(list[0]?.anchor).toEqual({ x: 3, y: 3 });
    expectAscii(toRgba(got(list[0]?.set)).toRGBA(), 'YY', L);
  });

  it('ctx.finalOnly sends every edit to the final override and keeps `parts` the real list', () => {
    const s = scene();
    const seen: (readonly PartRender[])[] = [];
    const base = ctxOf(s, {}, { finalOnly: true });
    const ctx: EditContext = {
      ...base,
      render: (parts) => {
        seen.push(parts);
        return base.render(parts);
      },
    };
    const before = renderOf(s).result;
    const edited = before.clone();
    edited.set(3, 2, [255, 255, 0, 255]); // inside the arm
    const list = attributeEdit(ctx, before, edited);
    expect(list.map((o) => o.target)).toEqual(['final']);
    expect(ctx.parts.length).toBeGreaterThan(0);
    expect(seen.every((p) => p === ctx.parts)).toBe(true);
  });

  it('renders the frame once when no part candidate exists, twice for a part edit', () => {
    const s = scene();
    const count = (edited: (before: TiledImage) => TiledImage): number => {
      let calls = 0;
      const base = ctxOf(s);
      const ctx: EditContext = {
        ...base,
        render: (parts) => {
          calls++;
          return base.render(parts);
        },
      };
      const before = renderOf(s).result;
      attributeEdit(ctx, before, edited(before));
      return calls;
    };
    const paint = (x: number, y: number) => (b: TiledImage) => {
      const e = b.clone();
      e.set(x, y, [255, 255, 0, 255]);
      return e;
    };
    expect(count(paint(0, 0))).toBe(1); // outside every part: final only, the first render is reused
    expect(count(paint(3, 2))).toBe(2); // inside the arm: the initial render and one with the part changed
  });

  it('a pixel under two overlapping parts is ambiguous, so final', () => {
    const rig = fixtureRig();
    // a second part on the arm bone, drawn over the arm's tip
    rig.parts.push({
      id: P('cap'),
      boneId: B('arm'),
      layerId: LAY('cap'),
      variants: [variant('cap', 'dot', { x: -2, y: 0 })],
    });
    need(rig.views[0]).defaultZ[P('cap')] = 2;
    const s = scene(rig);
    expectAscii(
      renderOf(s).result.toRGBA(),
      `
      ..........
      .......B..
      ..RRY..B..
      ..R....G..
      ..........
      ..........`,
      L,
    );
    const list = edit(
      s,
      img(`
      ..........
      .......B..
      ..RRM..B..
      ..R....G..
      ..........
      ..........`),
    );
    expect(list.map((o) => o.target)).toEqual(['final']);
  });
});
