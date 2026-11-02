import { IndexedImage, TiledImage, hashRGBA, sha256Hex } from '@pixel-forge/raster';
import { describe, expect, it } from 'vitest';
import {
  baseHash,
  checkOverride,
  discard,
  hashRegion,
  maskAt,
  overrideBox,
  overrideRegion,
  paintOverride,
  rebase,
  staleOverrides,
  unionRect,
} from '../src/index.js';
import type { FrameOverride, OverrideTargetRender } from '../src/index.js';
import { errorCode } from './helpers.js';
import { IMG, Images, OV, indexed, need, partOverride, rgba } from './render-fixture.js';

const images = new Images({
  dot: rgba('Y'),
  wide: rgba('..\n.Y\n..'), // content only at (1, 1)
  mask: rgba('RR'),
  empty: new TiledImage(2, 2),
});

describe('overrideBox / overrideRegion: the bbox of what an override touches, ±1', () => {
  it('uses the non-empty pixels of set and erase at the anchor', () => {
    const o = partOverride('a', 'arm', { x: 3, y: -2 }, { set: 'wide', erase: 'mask' });
    expect(overrideBox(o, images)).toEqual({ x: 3, y: -2, w: 2, h: 2 }); // mask (3..4, -2) ∪ set (4, -1)
    expect(overrideRegion(o, images)).toEqual({ x: 2, y: -3, w: 4, h: 4 });
  });

  it('an empty override covers the empty region at its anchor', () => {
    const o = partOverride('a', 'arm', { x: 1, y: 1 }, { set: 'empty' });
    expect(overrideBox(o, images)).toBeUndefined();
    expect(overrideRegion(o, images)).toEqual({ x: 1, y: 1, w: 0, h: 0 });
  });

  it('a missing image is IMAGE_MISSING', () => {
    const o = partOverride('a', 'arm', { x: 0, y: 0 }, { set: 'gone' });
    expect(errorCode(() => overrideBox(o, images))).toBe('IMAGE_MISSING');
  });
});

describe('hashRegion: SHA-256 of the decoded RGBA under a rectangle (spec 3.4.10)', () => {
  it('is the testkit-layout hash of the region, outside the image transparent', () => {
    const target: OverrideTargetRender = { image: rgba('RG\nBY'), offset: { x: 5, y: 5 } };
    // region (4..5, 5): outside then R
    const expected = hashRGBA({
      width: 2,
      height: 1,
      data: Uint8Array.from([0, 0, 0, 0, 255, 0, 0, 255]),
    });
    expect(hashRegion(target, { x: 4, y: 5, w: 2, h: 1 })).toBe(expected);
    expect(hashRegion(target, { x: 0, y: 0, w: 0, h: 0 })).toBe(
      sha256Hex(new Uint8Array(8)), // the 0×0 header alone
    );
  });

  it('hashes every alpha-0 pixel as (0, 0, 0, 0)', () => {
    const junk = new TiledImage(1, 1);
    junk.set(0, 0, [9, 9, 9, 0]);
    const clean = new TiledImage(1, 1);
    const rect = { x: 0, y: 0, w: 1, h: 1 };
    expect(hashRegion({ image: junk, offset: { x: 0, y: 0 } }, rect)).toBe(
      hashRegion({ image: clean, offset: { x: 0, y: 0 } }, rect),
    );
  });

  it('decodes indexed images through the palette, the transparent index transparent', () => {
    const palette: [number, number, number, number][] = [
      [1, 2, 3, 255], // not transparent by value: only transparentIndex is
      [255, 0, 0, 255],
      [0, 0, 0, 0],
    ];
    const idx = indexed('12\n..', 0);
    const rgb = new TiledImage(2, 2);
    rgb.set(0, 0, [255, 0, 0, 255]);
    const rect = { x: 0, y: 0, w: 2, h: 2 };
    const at = { x: 0, y: 0 };
    expect(hashRegion({ image: idx, offset: at }, rect, palette)).toBe(
      hashRegion({ image: rgb, offset: at }, rect),
    );
    expect(errorCode(() => hashRegion({ image: idx, offset: at }, rect))).toBe('BAD_VALUE');
    const outOfPalette = new IndexedImage(1, 1, 0);
    outOfPalette.set(0, 0, 7);
    expect(errorCode(() => hashRegion({ image: outOfPalette, offset: at }, rect, palette))).toBe(
      'BAD_VALUE',
    );
  });
});

describe('checkOverride / staleOverrides / rebase / discard', () => {
  const before: OverrideTargetRender = { image: rgba('RR\nR.'), offset: { x: 0, y: 0 } };
  const moved: OverrideTargetRender = { image: rgba('R.\nRR'), offset: { x: 0, y: 0 } };
  const o1 = partOverride('a', 'arm', { x: 1, y: 1 }, { set: 'dot' });
  const o2 = partOverride('b', 'arm', { x: 5, y: 5 }, { set: 'dot' });
  const list: FrameOverride[] = [o1, o2].map((o) => ({
    ...o,
    baseHash: baseHash(o, before, images),
  }));

  it('valid under the same pixels, stale (hash) under changed pixels inside the region', () => {
    const [a, b] = list as [FrameOverride, FrameOverride];
    expect(checkOverride(a, before, images)).toEqual({
      id: a.id,
      stale: false,
      currentHash: a.baseHash,
    });
    expect(checkOverride(a, moved, images)).toMatchObject({ stale: true, reason: 'hash' });
    // the change lies outside b's region (4..6, 4..6), so b stays valid
    expect(checkOverride(b, moved, images).stale).toBe(false);
    expect(staleOverrides(list, () => moved, images).map((c) => c.id)).toEqual([a.id]);
    expect(staleOverrides(list, () => undefined, images).map((c) => c.reason)).toEqual([
      'no-target',
      'no-target',
    ]);
  });

  it('rebase recaptures the listed hashes only; unknown ids and missing targets are refused', () => {
    const out = rebase(list, [OV('a')], () => moved, images);
    expect(out[1]).toBe(list[1]);
    expect(checkOverride(need(out[0]), moved, images).stale).toBe(false);
    expect(list[0]?.baseHash).not.toBe(out[0]?.baseHash); // input untouched
    expect(errorCode(() => rebase(list, [OV('zz')], () => moved, images))).toBe('BAD_VALUE');
    expect(errorCode(() => rebase(list, [OV('a')], () => undefined, images))).toBe('BAD_VALUE');
  });

  it('discard removes the listed overrides and releases images no remaining override uses', () => {
    const shared = partOverride('c', 'arm', { x: 0, y: 0 }, { set: 'dot', erase: 'mask' });
    const { overrides, released } = discard([...list, shared], [OV('a'), OV('c')]);
    expect(overrides.map((o) => o.id)).toEqual([OV('b')]);
    expect(released).toEqual([IMG('mask')]); // 'dot' is still used by b
    expect(discard(list, [OV('a'), OV('b')]).released).toEqual([IMG('dot')]);
    expect(errorCode(() => discard(list, [OV('zz')]))).toBe('BAD_VALUE');
  });
});

describe('shared helpers: unionRect, maskAt, paintOverride (review fix 9)', () => {
  it('unionRect is the bounding rectangle and ignores a missing side', () => {
    expect(unionRect({ x: 0, y: 0, w: 2, h: 2 }, { x: 3, y: -1, w: 1, h: 2 })).toEqual({
      x: 0,
      y: -1,
      w: 4,
      h: 3,
    });
    const r = { x: 1, y: 1, w: 1, h: 1 };
    expect(unionRect(r, undefined)).toBe(r);
    expect(unionRect(undefined, r)).toBe(r);
    expect(unionRect(undefined, undefined)).toBeUndefined();
  });

  it('maskAt is the alpha (RGBA) or the index (indexed)', () => {
    expect(maskAt(rgba('R.'), 0, 0)).toBe(255);
    expect(maskAt(rgba('R.'), 1, 0)).toBe(0);
    expect(maskAt(rgba('h'), 0, 0)).toBe(128);
    expect(maskAt(indexed('25'), 1, 0)).toBe(5);
  });

  it('paintOverride erases only where the mask is 255, then paints set over the result', () => {
    const out = rgba('RRR\nRRR');
    // mask: alpha 255 at (0,0) and (2,0); alpha 128 at (1,0) does not clear
    paintOverride(out, { x: 0, y: 0 }, { erase: rgba('Rh R'.replace(' ', '')), set: rgba('Y') });
    expect(Array.from(out.toRGBA().data)).toEqual([
      ...[255, 255, 0, 255], // (0,0) erased, then set Y over it
      ...[255, 0, 0, 255], // (1,0) mask 128: kept
      ...[0, 0, 0, 0], // (2,0) erased
      ...[255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255],
    ]);
  });

  it('indexed: erase writes the transparent index, set skips its own transparent index', () => {
    const out = indexed('123\n123');
    const mask = IndexedImage.fromIndices(3, 2, Uint8Array.from([255, 7, 255, 0, 0, 0]), 0);
    paintOverride(out, { x: 0, y: 0 }, { erase: mask, set: indexed('.9\n..', 0) });
    // (0,0) and (2,0) cleared (255 only; 7 does not), then the 9 painted at (1,0)
    expect(Array.from(out.toIndices())).toEqual([0, 9, 0, 1, 2, 3]);
  });

  it('indexed: an opaque set pixel equal to the target transparent index is refused, as is a colour-mode mismatch', () => {
    const out = indexed('123');
    expect(
      errorCode(() => {
        paintOverride(out, { x: 0, y: 0 }, { set: indexed('0', 5) });
      }),
    ).toBe('BAD_VALUE');
    expect(
      errorCode(() => {
        paintOverride(out, { x: 0, y: 0 }, { set: rgba('Y') });
      }),
    ).toBe('BAD_VALUE');
  });

  it("overrideBox and hashRegion share the notion of empty: an index equal to the image's transparentIndex", () => {
    // the set's transparent index is 7: only (1, 1) is non-empty, although 0 would be the default
    const o = { ...partOverride('a', 'arm', { x: 2, y: 3 }, {}), set: IMG('s') };
    expect(overrideBox(o, new Images({ s: indexed('77\n74', 7) }))).toEqual({
      x: 3,
      y: 4,
      w: 1,
      h: 1,
    });
    // the target's transparent index is 5, whose palette colour is opaque: it still reads as empty,
    // exactly like an RGBA target with alpha 0 there
    const palette = [
      [0, 0, 0, 0],
      [1, 1, 1, 255],
      [2, 2, 2, 255],
      [3, 3, 3, 255],
      [4, 4, 4, 255],
      [5, 5, 5, 255],
    ] as const;
    const rect = { x: 0, y: 0, w: 2, h: 2 };
    const idx = { image: indexed('45\n53', 5), offset: { x: 0, y: 0 } };
    const flat = new TiledImage(2, 2);
    flat.set(0, 0, [4, 4, 4, 255]);
    flat.set(1, 1, [3, 3, 3, 255]);
    expect(hashRegion(idx, rect, palette)).toBe(
      hashRegion({ image: flat, offset: { x: 0, y: 0 } }, rect),
    );
  });
});
