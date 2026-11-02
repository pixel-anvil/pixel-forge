// T3.5: splitRegion (rect / lasso / flood selections, binding, links, indexed images) and the W2b
// scenario: the split parts recomposite to the source frame by hash.
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import type { Rgba } from '@pixel-forge/raster';
import { rotatePoint } from '@pixel-forge/raster';
import { humanoidSide, jointCheck, overlapMasks, snapSkeleton } from '@pixel-forge/rig';
import { SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type { BoneId, Document, FrameId, ImageId, LayerId } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import {
  CoreError,
  DocumentStore,
  applySkeletonTemplate,
  createRigRenderer,
  documentHash,
  paintOverlapTx,
  setColorMode,
  renderFrame,
  splitRegion,
  validate,
} from '../src/index.js';
import type { SplitRegionOptions, SplitSelection, StoredImage } from '../src/index.js';

const gen = createIdGenerator({ seed: 21, next: 0 });
const I = {
  doc: gen.next('doc'),
  pal: gen.next('palette'),
  anim: gen.next('animation'),
  f0: gen.next('frame'),
  f1: gen.next('frame'),
  f2: gen.next('frame'),
  flat: gen.next('layer'),
  group: gen.next('layer'),
  inner: gen.next('layer'),
  img: gen.next('image'),
  imgInner: gen.next('image'),
};
const A = { id: I.anim } as const;
const ORIGIN = { x: 20, y: 48 };

const SKIN: Rgba = [230, 180, 140, 255];
const SHIRT: Rgba = [200, 30, 30, 255];
const BLUE: Rgba = [30, 30, 200, 255];
const OUTLINE: Rgba = [10, 10, 10, 255];
const GREEN: Rgba = [30, 160, 30, 255];

function rect(img: TiledImage, x0: number, y0: number, w: number, h: number, c: Rgba): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.set(x, y, c);
}

/** A flat 40×50 figure: head, outlined torso, arm, two legs. Colours are the "regions". */
function figure(): TiledImage {
  const img = new TiledImage(40, 50);
  rect(img, 17, 4, 6, 6, SKIN); // head 17..22 x 4..9
  rect(img, 16, 10, 8, 12, OUTLINE); // torso outline 16..23 x 10..21
  rect(img, 17, 11, 6, 10, SHIRT); // torso fill 17..22 x 11..20
  rect(img, 24, 11, 3, 8, GREEN); // arm 24..26 x 11..18 (touches the torso outline)
  rect(img, 17, 22, 3, 14, BLUE); // leg 17..19 x 22..35
  rect(img, 20, 22, 3, 14, BLUE); // leg 20..22 x 22..35
  return img;
}

interface Opts {
  /** `figure` (default), `blank` (nothing drawn) or `diag` (two shirt pixels touching at a corner). */
  art?: 'figure' | 'blank' | 'diag';
  indexed?: boolean;
  celOpacity?: number;
  layerOpacity?: number;
  /** f1 links to f0 (default), is its own copy, or is absent. */
  f1?: 'link' | 'own' | 'none';
  hidden?: boolean;
}

function makeStore(o: Opts = {}): DocumentStore {
  const g = createIdGenerator({ seed: 3, next: 0 });
  const images: [ImageId, StoredImage][] = [];
  let main: StoredImage = figure();
  if (o.art === 'blank') main = new TiledImage(40, 50);
  if (o.art === 'diag') {
    const d = new TiledImage(40, 50);
    d.set(18, 12, SHIRT);
    d.set(19, 13, SHIRT);
    main = d;
  }
  if (o.indexed === true) {
    const pal: Rgba[] = [[0, 0, 0, 0], SKIN, SHIRT, BLUE, OUTLINE, GREEN];
    const idx = new Uint8Array(40 * 50);
    const src = figure();
    for (let y = 0; y < 50; y++) {
      for (let x = 0; x < 40; x++) {
        const c = src.get(x, y);
        const k = pal.findIndex((p, i) => i > 0 && p.every((v, j) => v === c[j]));
        idx[y * 40 + x] = c[3] === 0 ? 0 : k;
      }
    }
    main = IndexedImage.fromIndices(40, 50, idx, 0);
  }
  images.push([I.img, main]);
  const f1 = o.f1 ?? 'link';
  const cels: Record<string, unknown> = {
    [I.f0]: { imageId: I.img, offset: { x: 0, y: 0 }, opacity: o.celOpacity ?? 255 },
  };
  if (f1 === 'link') cels[I.f1] = { linkTo: I.f0 };
  if (f1 === 'own') {
    const other = main.clone();
    if (other instanceof TiledImage) other.set(0, 0, [1, 2, 3, 255]);
    images.push([I.imgInner, other]);
    cels[I.f1] = { imageId: I.imgInner, offset: { x: 0, y: 0 }, opacity: 255 };
  }
  const frame = (id: FrameId) => ({
    id,
    durationMs: 100,
    markers: {},
    events: [],
    rootMotion: { dx: 0, dy: 0 },
    boneKeys: {},
    partKeys: {},
  });
  const doc: Document = {
    meta: {
      id: I.doc,
      name: 'split',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w: 40, h: 50 },
      origin: ORIGIN,
      pixelsPerUnit: 16,
      colorMode: o.indexed === true ? 'indexed' : 'rgba',
      paletteLocked: false,
      ids: { ...g.state() },
    },
    palettes: [
      {
        id: I.pal,
        name: 'Base',
        colors: (o.indexed === true
          ? [[0, 0, 0, 0], SKIN, SHIRT, BLUE, OUTLINE, GREEN]
          : [[0, 0, 0, 0]]) as [number, number, number, number][],
        ramps: [],
      },
    ],
    activePaletteId: I.pal,
    skins: [],
    layers: [
      {
        kind: 'group',
        id: I.group,
        name: 'art',
        visible: true,
        opacity: 255,
        export: true,
        children: [
          {
            kind: 'pixel',
            id: I.flat,
            name: 'flat',
            visible: o.hidden !== true,
            opacity: o.layerOpacity ?? 255,
            export: true,
            cels: cels as never,
          },
        ],
      },
    ],
    animations: [
      {
        id: I.anim,
        group: 'idle',
        loop: 'loop',
        frames: f1 === 'none' ? [frame(I.f0)] : [frame(I.f0), frame(I.f1), frame(I.f2)],
        overrides: [],
      },
    ],
    directionFallback: {},
    markerDefs: [],
    eventDefs: [],
  };
  const store = new DocumentStore(doc, { images });
  store.transact('rig', (tx) =>
    applySkeletonTemplate(tx, humanoidSide({ height: 48, origin: ORIGIN })),
  );
  return store;
}

const rig = createRigRenderer();
const hashOf = (s: DocumentStore, frame = 0): string =>
  renderFrame(s, A, frame, { rig }).hashRGBA();

function split(
  s: DocumentStore,
  sel: SplitSelection,
  opts: SplitRegionOptions = {},
  layer: LayerId = I.flat,
  frame: FrameId = I.f0,
) {
  return s.transact('split', (tx) => splitRegion(tx, layer, frame, sel, opts));
}

const errorsOf = (s: DocumentStore) => validate(s).filter((f) => f.severity === 'error');

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof CoreError)
      return typeof e.details?.reason === 'string' ? e.details.reason : e.code;
    return 'other';
  }
  return undefined;
}

/** The canvas pixels of a selection result as `x,y` strings, read from its image. */
function pixelsOf(s: DocumentStore, id: ImageId, at: { x: number; y: number }): string[] {
  const img = s.image(id);
  if (!(img instanceof TiledImage)) throw new Error('expected RGBA');
  const out: string[] = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.get(x, y)[3] !== 0) out.push(`${String(x + at.x)},${String(y + at.y)}`);
    }
  }
  return out;
}

describe('W2b: the split parts recomposite to the source frame', () => {
  it('rect, lasso and flood splits into named parts leave the frame hash unchanged', () => {
    const s = makeStore();
    const before = hashOf(s);
    expect(before).toBe(renderFrame(s, A, 0, { layers: [I.flat] }).hashRGBA());

    const head = split(s, { kind: 'rect', x: 17, y: 4, w: 6, h: 6 }, { partName: 'part:head' });
    expect(head.bound?.how).toBe('name');
    const torso = split(
      s,
      {
        kind: 'lasso',
        // a polygon through the torso's corner pixels (outline included): 16..23 x 10..21
        points: [
          [16, 10],
          [23, 10],
          [23, 21],
          [16, 21],
        ],
      },
      { partName: 'part:torso' },
    );
    const arm = split(
      s,
      { kind: 'flood', x: 25, y: 12, boundary: [OUTLINE] },
      { partName: 'part:upper_arm_r' },
    );
    const leg = split(s, { kind: 'rect', x: 17, y: 22, w: 3, h: 14 }, { partName: 'part:thigh_l' });
    expect([head.pixels, torso.pixels, arm.pixels, leg.pixels]).toEqual([36, 8 * 12, 24, 42]);
    expect(hashOf(s)).toBe(before);
    expect(errorsOf(s)).toEqual([]);

    // The parts are bound and the source has lost exactly those pixels.
    const parts = s.doc.rig?.parts ?? [];
    for (const r of [head, torso, arm, leg]) {
      expect(parts.some((p) => p.layerId === r.layerId)).toBe(true);
    }
    const rest = renderFrame(s, A, 0, { layers: [I.flat] });
    expect(rest.get(17, 4)[3]).toBe(0); // head: gone without the rig
    expect(rest.get(20, 25)[3]).toBe(255); // second leg: still flat
  });

  it('is undone by one undo', () => {
    const s = makeStore();
    const h0 = documentHash(s);
    split(s, { kind: 'rect', x: 17, y: 4, w: 6, h: 6 }, { partName: 'part:head' });
    expect(documentHash(s)).not.toBe(h0);
    s.undo();
    expect(documentHash(s)).toBe(h0);
    s.redo();
    expect(errorsOf(s)).toEqual([]);
  });

  it('a variant split folds into the existing part and the hash still matches', () => {
    const s = makeStore();
    const before = hashOf(s);
    split(s, { kind: 'rect', x: 17, y: 4, w: 6, h: 3 }, { partName: 'part:head' });
    const r = split(s, { kind: 'rect', x: 17, y: 7, w: 6, h: 3 }, { partName: 'part:head@chin' });
    expect(r.bound?.merged).toBe(true);
    const head = s.doc.rig?.parts.find((p) => p.layerId === r.layerId);
    expect(head?.variants.map((v) => v.name)).toEqual(['default', 'chin']);
    // The variant is not drawn by default: the chin rows are missing until it is selected.
    expect(hashOf(s)).not.toBe(before);
    expect(errorsOf(s)).toEqual([]);
  });

  it('keeps the cel opacity: it moves to the new layer when the layer is opaque', () => {
    const s = makeStore({ celOpacity: 128 });
    const before = hashOf(s);
    const r = split(s, { kind: 'rect', x: 17, y: 4, w: 6, h: 6 }, { partName: 'part:head' });
    const layer = s.doc.layers
      .flatMap((l) => (l.kind === 'group' ? l.children : [l]))
      .find((l) => l.id === r.layerId);
    expect(layer?.opacity).toBe(128);
    expect(hashOf(s)).toBe(before);
  });

  it('an indexed document splits indexed images and recomposites', () => {
    const s = makeStore({ indexed: true });
    const before = hashOf(s);
    const r = split(
      s,
      { kind: 'flood', x: 25, y: 12, boundary: [OUTLINE] }, // an Rgba boundary resolved through the palette
      { partName: 'part:upper_arm_r' },
    );
    expect(s.image(r.imageId)).toBeInstanceOf(IndexedImage);
    expect((s.image(r.imageId) as IndexedImage).transparentIndex).toBe(0);
    const byIndex = makeStore({ indexed: true });
    const r2 = split(byIndex, { kind: 'flood', x: 25, y: 12, boundary: [4] });
    expect(r2.pixels).toBe(r.pixels);
    expect(hashOf(s)).toBe(before);
    expect(errorsOf(s)).toEqual([]);
  });
});

describe('selections', () => {
  it('rect is clipped to the cel, moves only opaque pixels and trims to their box', () => {
    const s = makeStore();
    const r = split(s, { kind: 'rect', x: 14, y: 2, w: 12, h: 10 }, { bind: false });
    // Selected: x 14..25, y 2..11. Opaque there: the head (36), the torso outline row 10 (8), and in
    // row 11 two outline pixels, six shirt pixels and the arm's first two columns (24, 25): 10.
    expect(r.bounds).toEqual({ x: 16, y: 4, w: 10, h: 8 });
    expect(r.pixels).toBe(36 + 8 + 10);
  });

  it('lasso includes pixels on the outline and inside, exactly (hand-computed triangle)', () => {
    const s = makeStore();
    // Triangle (17,4) (22,4) (17,9): the head's upper-left half, diagonal x + y = 26 included.
    const r = split(
      s,
      {
        kind: 'lasso',
        points: [
          [17, 4],
          [22, 4],
          [17, 9],
        ],
      },
      { bind: false },
    );
    const want: string[] = [];
    for (let y = 4; y <= 9; y++) {
      for (let x = 17; x <= 22; x++) if (x + y <= 26) want.push(`${String(x)},${String(y)}`);
    }
    expect(pixelsOf(s, r.imageId, r.bounds).sort()).toEqual(want.sort());
  });

  it('lasso handles a concave polygon (even-odd)', () => {
    const s = makeStore();
    // A "U" around the head: left bar x 17..18, right bar x 21..22, bottom bar y 8..9; the notch is empty.
    const r = split(
      s,
      {
        kind: 'lasso',
        points: [
          [17, 4],
          [18, 4],
          [18, 7],
          [21, 7],
          [21, 4],
          [22, 4],
          [22, 9],
          [17, 9],
        ],
      },
      { bind: false },
    );
    const got = new Set(pixelsOf(s, r.imageId, r.bounds));
    expect(got.has('19,5')).toBe(false);
    expect(got.has('20,6')).toBe(false);
    expect(got.has('17,5')).toBe(true);
    expect(got.has('22,6')).toBe(true);
    expect(got.has('19,8')).toBe(true);
    expect(r.pixels).toBe(36 - 6); // the notch: x 19..20, y 4..6 (the edge row y = 7 is inside)
  });

  it('flood without a boundary selects the seed colour only', () => {
    const s = makeStore();
    const r = split(s, { kind: 'flood', x: 18, y: 12 }, { bind: false });
    expect(r.pixels).toBe(60); // the 6×10 shirt, not the outline
    expect(r.bounds).toEqual({ x: 17, y: 11, w: 6, h: 10 });
  });

  it('flood with a boundary spreads over everything not on the boundary, and can include the rim', () => {
    const s = makeStore();
    const wide = split(s, { kind: 'flood', x: 25, y: 12, boundary: [OUTLINE] }, { bind: false });
    // the arm only: the outline separates it from the torso
    expect(wide.pixels).toBe(24);
    const t = makeStore();
    const rim = split(
      t,
      { kind: 'flood', x: 18, y: 12, boundary: [OUTLINE], includeBoundary: true },
      { bind: false },
    );
    // shirt 60 + the outline ring pixels that touch it by an edge (36 − 4 corners = 32); the arm is a
    // separate flood region and is not reached
    expect(rim.pixels).toBe(60 + 32);
    const rim8 = split(
      makeStore(),
      { kind: 'flood', x: 18, y: 12, boundary: [OUTLINE], includeBoundary: true, connectivity: 8 },
      { bind: false },
    );
    expect(rim8.pixels).toBe(60 + 36);
  });

  it('4-connected flood does not cross a diagonal gap, 8-connected does', () => {
    const four = split(
      makeStore({ art: 'diag' }),
      { kind: 'flood', x: 18, y: 12 },
      { bind: false },
    );
    expect(four.pixels).toBe(1);
    const eight = split(
      makeStore({ art: 'diag' }),
      { kind: 'flood', x: 18, y: 12, connectivity: 8 },
      { bind: false },
    );
    expect(eight.pixels).toBe(2);
  });

  it('rejects malformed selections and empty ones before any change', () => {
    const s = makeStore();
    const h = documentHash(s);
    const bad: SplitSelection[] = [
      { kind: 'rect', x: 0.5, y: 0, w: 2, h: 2 },
      { kind: 'rect', x: 0, y: 0, w: 0, h: 2 },
      {
        kind: 'lasso',
        points: [
          [0, 0],
          [1, 1],
        ],
      },
      {
        kind: 'lasso',
        points: [
          [0, 0],
          [1, 1],
          [1.5, 0],
        ],
      },
      { kind: 'flood', x: 1.5, y: 2 },
      { kind: 'flood', x: 18, y: 12, connectivity: 6 as never },
      { kind: 'flood', x: 18, y: 12, boundary: [3] }, // an index in an RGBA document
      { kind: 'flood', x: 18, y: 12, boundary: [[1, 2, 3] as never] },
    ];
    for (const sel of bad) expect(reason(() => split(s, sel))).toBe('bad-selection');
    expect(reason(() => split(s, { kind: 'rect', x: 0, y: 0, w: 5, h: 5 }))).toBe(
      'empty-selection',
    );
    expect(reason(() => split(s, { kind: 'rect', x: 100, y: 100, w: 5, h: 5 }))).toBe(
      'empty-selection',
    );
    expect(reason(() => split(s, { kind: 'flood', x: 0, y: 0 }))).toBe('empty-selection');
    expect(reason(() => split(s, { kind: 'flood', x: 18, y: 12, boundary: [SHIRT] }))).toBe(
      'empty-selection',
    );
    expect(documentHash(s)).toBe(h);
  });
});

describe('the source layer, links and the new layer', () => {
  it('puts the new layer directly above the source, in the same group, with its flags', () => {
    const s = makeStore({ hidden: true });
    const r = split(
      s,
      { kind: 'rect', x: 17, y: 4, w: 6, h: 6 },
      { name: 'head_art', bind: false },
    );
    const group = s.doc.layers[0];
    if (group?.kind !== 'group') throw new Error('group');
    expect(group.children.map((l) => l.name)).toEqual(['flat', 'head_art']);
    const made = group.children[1];
    expect(made).toMatchObject({
      kind: 'pixel',
      id: r.layerId,
      visible: false,
      export: true,
      opacity: 255,
    });
    if (made?.kind !== 'pixel') throw new Error('pixel');
    expect(made.cels[I.f0]).toEqual({ imageId: r.imageId, offset: { x: 17, y: 4 }, opacity: 255 });
  });

  it('names the layer split, split_2... and refuses a taken or invalid name', () => {
    const s = makeStore();
    const a = split(s, { kind: 'rect', x: 17, y: 4, w: 6, h: 6 }, { bind: false });
    const b = split(s, { kind: 'rect', x: 17, y: 22, w: 3, h: 14 }, { bind: false });
    const names = s.doc.layers
      .flatMap((l) => (l.kind === 'group' ? l.children : [l]))
      .map((l) => l.name);
    expect(names).toEqual(['flat', 'split_2', 'split']); // each new layer goes directly above the source
    expect([a.layerId, b.layerId]).not.toContain(I.flat);
    expect(
      reason(() => split(s, { kind: 'rect', x: 20, y: 22, w: 3, h: 14 }, { name: 'flat' })),
    ).toBe('name-taken');
    expect(
      reason(() => split(s, { kind: 'rect', x: 20, y: 22, w: 3, h: 14 }, { name: 'Bad Name' })),
    ).toBe('bad-name');
  });

  it('a linked frame keeps the original drawing: the split changes one frame only', () => {
    const s = makeStore();
    const original = s.image(I.img)?.clone();
    const r = split(s, { kind: 'rect', x: 17, y: 4, w: 6, h: 6 }, { bind: false });
    expect(r.unlinked).toEqual([I.f1]);
    const flat = s.doc.layers[0];
    if (flat?.kind !== 'group') throw new Error('group');
    const layer = flat.children[0];
    if (layer?.kind !== 'pixel') throw new Error('pixel');
    const c0 = layer.cels[I.f0];
    const c1 = layer.cels[I.f1];
    if (c0 === undefined || c1 === undefined || 'linkTo' in c0 || 'linkTo' in c1)
      throw new Error('cels');
    expect(c1.imageId).toBe(I.img); // the original stays with the linker
    expect((s.image(I.img) as TiledImage).equals(original as TiledImage)).toBe(true);
    expect((s.image(c0.imageId) as TiledImage).get(17, 4)[3]).toBe(0);
    expect(errorsOf(s)).toEqual([]);
    // frame f1 still shows the head
    expect(renderFrame(s, A, 1, { layers: [I.flat] }).get(17, 4)[3]).toBe(255);
    expect(renderFrame(s, A, 0, { layers: [I.flat] }).get(17, 4)[3]).toBe(0);
  });

  it('several linkers: the first owns the drawing, the others link to it', () => {
    const s = makeStore();
    s.transact('link', (tx) => {
      tx.update((d) => {
        const g = d.layers[0];
        if (g?.kind !== 'group') return;
        const l = g.children[0];
        if (l?.kind !== 'pixel') return;
        l.cels[I.f2] = { linkTo: I.f0 };
      });
    });
    const r = split(s, { kind: 'rect', x: 17, y: 4, w: 6, h: 6 }, { bind: false });
    expect(r.unlinked).toEqual([I.f1, I.f2].sort());
    expect(errorsOf(s)).toEqual([]);
    const g = s.doc.layers[0];
    if (g?.kind !== 'group' || g.children[0]?.kind !== 'pixel') throw new Error('x');
    const cels = g.children[0].cels;
    const [first, second] = [I.f1, I.f2].sort() as [FrameId, FrameId];
    expect('imageId' in (cels[first] ?? {})).toBe(true);
    expect(cels[second]).toEqual({ linkTo: first });
  });

  it('splitting a linked cel makes it independent and leaves the target alone', () => {
    const s = makeStore();
    const original = s.image(I.img)?.clone();
    const r = split(s, { kind: 'rect', x: 17, y: 4, w: 6, h: 6 }, { bind: false }, I.flat, I.f1);
    expect(r.unlinked).toEqual([]);
    expect((s.image(I.img) as TiledImage).equals(original as TiledImage)).toBe(true);
    const g = s.doc.layers[0];
    if (g?.kind !== 'group' || g.children[0]?.kind !== 'pixel') throw new Error('x');
    const c1 = g.children[0].cels[I.f1];
    expect(c1 !== undefined && 'imageId' in c1 && c1.imageId !== I.img).toBe(true);
    expect(errorsOf(s)).toEqual([]);
  });

  it('deletes the original image when nothing references it any more', () => {
    const s = makeStore({ f1: 'own' });
    split(s, { kind: 'rect', x: 17, y: 4, w: 6, h: 6 }, { bind: false });
    expect(s.imageIds()).not.toContain(I.img);
    expect(errorsOf(s)).toEqual([]);
  });

  it('refuses a layer that is partly transparent twice over, and folds a single factor', () => {
    const s = makeStore({ celOpacity: 100, layerOpacity: 200 });
    expect(reason(() => split(s, { kind: 'rect', x: 17, y: 4, w: 6, h: 6 }))).toBe('translucent');
    const t = makeStore({ layerOpacity: 90 });
    const r = split(t, { kind: 'rect', x: 17, y: 4, w: 6, h: 6 }, { bind: false });
    const made = (t.doc.layers[0]?.kind === 'group' ? t.doc.layers[0].children : []).find(
      (l) => l.id === r.layerId,
    );
    expect(made?.opacity).toBe(90);
  });

  it('refuses an unknown layer, a non-pixel layer and a missing cel', () => {
    const s = makeStore();
    const sel: SplitSelection = { kind: 'rect', x: 17, y: 4, w: 6, h: 6 };
    expect(reason(() => split(s, sel, {}, 'lay_nope' as LayerId))).toBe('unknown-layer');
    expect(reason(() => split(s, sel, {}, I.group))).toBe('not-pixel-layer');
    expect(reason(() => split(s, sel, {}, I.flat, I.f2))).toBe('no-cel');
  });
});

describe('binding', () => {
  it('refuses a bad part name, an unknown bone or view, or no rig, before changing anything', () => {
    const s = makeStore();
    const h = documentHash(s);
    const sel: SplitSelection = { kind: 'rect', x: 17, y: 4, w: 6, h: 6 };
    expect(reason(() => split(s, sel, { partName: 'Head!' }))).toBe('bad-name');
    expect(reason(() => split(s, sel, { partName: 'part:ghost' }))).toBe('unknown-bone');
    expect(reason(() => split(s, sel, { partName: 'part:head#nope' }))).toBe('unknown-view');
    expect(reason(() => split(s, sel, { partName: 'part:head', viewId: 'viw_x' as never }))).toBe(
      'unknown-view',
    );
    expect(documentHash(s)).toBe(h);
  });

  it('accepts a plain bone name as the part name', () => {
    const s = makeStore();
    const r = split(s, { kind: 'rect', x: 17, y: 4, w: 6, h: 6 }, { partName: 'head' });
    expect(r.bound?.how).toBe('name');
  });

  it('a bind that cannot happen undoes the whole split', () => {
    const s = makeStore();
    split(s, { kind: 'rect', x: 17, y: 4, w: 6, h: 3 }, { partName: 'part:head' });
    const h = documentHash(s);
    const images = s.imageIds();
    let failed: unknown;
    try {
      split(s, { kind: 'rect', x: 17, y: 7, w: 6, h: 3 }, { partName: 'part:head' }); // same variant
    } catch (e) {
      failed = e;
    }
    expect(failed).toBeInstanceOf(CoreError);
    expect((failed as CoreError).details).toMatchObject({
      reason: 'bind-failed',
      skipped: 'duplicate-variant',
    });
    expect(documentHash(s)).toBe(h);
    expect(s.imageIds()).toEqual(images); // no leaked images
  });

  /** Paints a one-pixel line along `bone`'s rest segment into the flat image; returns a seed on it. */
  function paintAlong(s: DocumentStore, bone: string): { x: number; y: number } {
    const r = s.doc.rig;
    const view = r?.views[0];
    const b = r?.bones.find((x) => x.name === bone);
    if (r === undefined || view === undefined || b === undefined) throw new Error('rig');
    const sb = snapSkeleton(r, view, new Map()).bones.get(b.id);
    if (sb === undefined) throw new Error('bone');
    const [dx, dy] = rotatePoint(b.length, 0, sb.restAngle);
    const n = Math.max(Math.abs(dx), Math.abs(dy), 1);
    s.transact('paint', (tx) => {
      tx.writeImage(I.img, (im) => {
        for (let k = 0; k <= n; k++) {
          (im as TiledImage).set(
            sb.pivot.x + Math.round((dx * k) / n),
            sb.pivot.y + Math.round((dy * k) / n),
            SHIRT,
          );
        }
      });
    });
    return { x: sb.pivot.x, y: sb.pivot.y };
  }

  it('without a part name, a clear overlap winner binds', () => {
    const s = makeStore({ art: 'blank' });
    const seed = paintAlong(s, 'head');
    const r = split(s, { kind: 'flood', x: seed.x, y: seed.y, connectivity: 8 });
    expect(r.bound?.how).toBe('overlap');
    const head = s.doc.rig?.bones.find((b) => b.name === 'head');
    expect(r.bound?.boneId).toBe(head?.id);
    expect(errorsOf(s)).toEqual([]);
  });

  it('an ambiguous overlap leaves a pixel layer and lists the candidates (both thighs share a segment)', () => {
    const s = makeStore({ art: 'blank' });
    const seed = paintAlong(s, 'thigh_l');
    const r = split(s, { kind: 'flood', x: seed.x, y: seed.y, connectivity: 8 });
    expect(r.bound).toBeUndefined();
    expect(r.ambiguous?.length).toBe(2);
    const layer = s.doc.layers[0]?.kind === 'group' ? s.doc.layers[0].children[1] : undefined;
    expect(layer?.kind).toBe('pixel');
    expect(layer?.id).toBe(r.layerId);
  });

  it('a region far from every bone stays a pixel layer, reported as no-overlap', () => {
    const s = makeStore({ art: 'blank' });
    s.transact('paint', (tx) => {
      tx.writeImage(I.img, (im) => {
        (im as TiledImage).set(1, 1, SHIRT);
      });
    });
    const r = split(s, { kind: 'rect', x: 0, y: 0, w: 3, h: 3 });
    expect(r.skipped).toBe('no-overlap');
    expect(r.bound).toBeUndefined();
  });

  it('bind: false never binds, even with a rig', () => {
    const s = makeStore({ art: 'blank' });
    const seed = paintAlong(s, 'head');
    const r = split(s, { kind: 'flood', x: seed.x, y: seed.y, connectivity: 8 }, { bind: false });
    expect(r.bound).toBeUndefined();
    expect(s.doc.rig?.parts).toEqual([]);
  });

  it('a document without a rig simply splits into a pixel layer', () => {
    const s = makeStore();
    s.transact('strip', (tx) => {
      tx.update((d) => {
        delete d.rig;
      });
    });
    const r = split(s, { kind: 'rect', x: 17, y: 4, w: 6, h: 6 });
    expect(r.bound).toBeUndefined();
    expect(r.skipped).toBeUndefined();
    expect(errorsOf(s)).toEqual([]);
  });
});

/** The W2b scene: a flat two-segment limb split into upper and lower arm parts, with a gap at the elbow. */
/** `z`: the forearm's default z; `null` leaves it unset, so both parts tie on z. */
function w2bSplit(z: number | null = -1): {
  s: DocumentStore;
  before: string;
  lowerId: BoneId | undefined;
} {
  const s = makeStore({ art: 'blank' });
  const r0 = s.doc.rig;
  const view = r0?.views[0];
  const lower = r0?.bones.find((b) => b.name === 'lower_arm_r');
  if (r0 === undefined || view === undefined || lower === undefined) throw new Error('rig');
  const elbow = snapSkeleton(r0, view, new Map()).bones.get(lower.id);
  if (elbow === undefined) throw new Error('elbow');
  expect(elbow.restAngle).toBe(90); // the side-view arm hangs straight down
  const { x, y } = elbow.pivot;
  s.transact('draw', (tx) => {
    tx.writeImage(I.img, (im) => {
      const t = im as TiledImage;
      rect(t, x - 2, y - 8, 4, 8, GREEN); // upper arm, ends just above the elbow
      rect(t, x - 2, y, 4, 8, BLUE); // forearm, starts at the elbow row
    });
  });
  const before = hashOf(s);
  split(s, { kind: 'rect', x: x - 2, y: y - 8, w: 4, h: 8 }, { partName: 'part:upper_arm_r' });
  split(
    s,
    { kind: 'rect', x: x - 2, y, w: 4, h: 8 },
    { partName: 'part:lower_arm_r', ...(z === null ? {} : { zByBone: { lower_arm_r: z } }) },
  );
  expect(hashOf(s)).toBe(before); // W2b: the parts recomposite the source frame

  return { s, before, lowerId: lower.id };
}

describe('W2b end to end: split, find the gaps, paint the overlap, composite unchanged', () => {
  it('splits a flat two-segment limb, paints the hidden overlap and closes the joint', () => {
    const { s, before } = w2bSplit();
    const check = (): ReturnType<typeof jointCheck> => {
      const rig = s.doc.rig;
      if (rig === undefined) throw new Error('rig');
      return jointCheck({ rig, images: s, canvas: s.doc.meta.canvas });
    };
    expect(check().summary.gapCount).toBeGreaterThan(0);

    const rig = s.doc.rig;
    if (rig === undefined) throw new Error('rig');
    const report = overlapMasks({ rig, images: s, canvas: s.doc.meta.canvas });
    const j = report.joints[0];
    if (j === undefined) throw new Error('no joint with gaps');
    expect([j.bone, j.paint]).toEqual(['lower_arm_r', 'child']);
    expect(j.mask.length).toBeGreaterThan(0);

    // Paint the mask onto the forearm's variant (grows the image, shifts the pivot).
    const lowerId = rig.bones.find((b) => b.name === 'lower_arm_r')?.id;
    const done = s.transact('paint overlap', (tx) =>
      paintOverlapTx(tx, { color: BLUE, ...(lowerId === undefined ? {} : { bones: [lowerId] }) }),
    );
    expect(done.painted.map((p) => [p.partId, p.variantId, p.bones])).toEqual([
      [j.partId, j.variantId, ['lower_arm_r']],
    ]);
    expect(done.painted[0]?.pixels).toBe(j.local.length);
    expect(hashOf(s)).toBe(before); // painting inside the mask leaves the composite at rest unchanged
    expect(errorsOf(s)).toEqual([]);
    expect(check().summary.gapCount).toBe(0); // and the joint is closed
  });
  it('keeps the composite when the two parts tie on z: the render breaks ties by layer order (SCN-03)', () => {
    const { s, before } = w2bSplit(null);
    // A colour the art does not use: a paint in the forearm's own colour could not show.
    const done = s.transact('paint', (tx) => paintOverlapTx(tx, { color: [255, 0, 255, 255] }));
    expect(done.painted.length).toBeGreaterThan(0);
    expect(hashOf(s)).toBe(before);
  });

  it('paints nothing under an upper part whose layer is translucent (G1-fix 8)', () => {
    const { s } = w2bSplit();
    const rig = s.doc.rig;
    const upperBone = rig?.bones.find((b) => b.name === 'upper_arm_r');
    const upper = rig?.parts.find((p) => p.boneId === upperBone?.id);
    if (upper === undefined) throw new Error('upper arm part');
    const setOpacity = (layerId: LayerId, opacity: number): void => {
      s.transact('opacity', (tx) => {
        tx.update((d) => {
          const walk = (ls: typeof d.layers): void => {
            for (const l of ls) {
              if (l.id === layerId) l.opacity = opacity;
              if (l.kind === 'group') walk(l.children);
            }
          };
          walk(d.layers);
        });
      });
    };
    setOpacity(upper.layerId, 254);
    const before = hashOf(s);
    const none = s.transact('paint', (tx) => paintOverlapTx(tx, { color: BLUE }));
    expect(none.painted).toEqual([]);
    expect(none.uncovered.map((u) => u.bone)).toEqual(['lower_arm_r']);
    expect(hashOf(s)).toBe(before);
    // Back at full opacity the same call paints.
    setOpacity(upper.layerId, 255);
    const done = s.transact('paint', (tx) => paintOverlapTx(tx, { color: BLUE }));
    expect(done.painted).toHaveLength(1);
    expect(done.uncovered).toEqual([]);
  });

  it('paints in an indexed document (palette index colour) and converts both ways without changing the render', () => {
    const { s, before } = w2bSplit();
    s.transact('palette', (tx) => {
      tx.update((d) => {
        const p = d.palettes[0];
        if (p !== undefined) p.colors = [[0, 0, 0, 0], [...GREEN], [...BLUE]];
      });
    });
    const out = s.transact('to indexed', (tx) =>
      setColorMode(tx, { colorMode: 'indexed', paletteLocked: true }),
    );
    expect(out).toMatchObject({ colorMode: 'indexed', paletteLocked: true });
    expect(out.converted).toBeGreaterThan(1);
    expect(hashOf(s)).toBe(before);
    expect(errorsOf(s)).toEqual([]);
    const wrong = () => s.transact('x', (tx) => paintOverlapTx(tx, { color: BLUE }));
    expect(wrong).toThrow(/palette index/);
    const done = s.transact('paint', (tx) => paintOverlapTx(tx, { color: 2 }));
    expect(done.painted).toHaveLength(1);
    expect(hashOf(s)).toBe(before);
    const rig = s.doc.rig;
    if (rig === undefined) throw new Error('rig');
    expect(
      jointCheck({
        rig,
        images: s,
        canvas: s.doc.meta.canvas,
        palette: [[0, 0, 0, 0], GREEN, BLUE],
      }).summary.gapCount,
    ).toBe(0);
    expect(errorsOf(s)).toEqual([]);
    s.transact('back', (tx) => setColorMode(tx, { colorMode: 'rgba' }));
    expect(s.doc.meta.colorMode).toBe('rgba');
    expect(hashOf(s)).toBe(before);
  });

  it('refuses without a rig, with unknown views and bones, and with a colour of the wrong kind', () => {
    const s = makeStore({ art: 'blank' });
    const noGap = s.transact('none', (tx) => paintOverlapTx(tx));
    expect(noGap).toEqual({ painted: [], uncovered: [], skipped: [] });
    const reason = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (e) {
        return (e as CoreError).details?.reason;
      }
      return undefined;
    };
    expect(
      reason(() => s.transact('x', (tx) => paintOverlapTx(tx, { viewId: 'viw_nope00' as never }))),
    ).toBe('unknown-view');
    expect(
      reason(() => s.transact('x', (tx) => paintOverlapTx(tx, { bones: ['bon_nope00' as never] }))),
    ).toBe('unknown-bone');
    const { s: gap } = w2bSplit();
    expect(reason(() => gap.transact('x', (tx) => paintOverlapTx(tx, { color: 3 })))).toBe(
      'bad-color',
    );
    s.transact('strip', (tx) => {
      tx.update((d) => {
        delete d.rig;
      });
    });
    expect(reason(() => s.transact('x', (tx) => paintOverlapTx(tx)))).toBe('no-rig');
  });

  it('refuses a colour mode change without a palette or a transparent entry, or with a colour it lacks', () => {
    const { s } = w2bSplit();
    const reason = (opts: Parameters<typeof setColorMode>[1]): unknown => {
      try {
        s.transact('x', (tx) => setColorMode(tx, opts));
      } catch (e) {
        return (e as CoreError).details?.reason;
      }
      return undefined;
    };
    expect(reason({ colorMode: 'indexed' })).toBe('not-indexable'); // the palette lacks GREEN and BLUE
    s.transact('palette', (tx) => {
      tx.update((d) => {
        const p = d.palettes[0];
        if (p !== undefined) p.colors = [[...GREEN], [...BLUE]];
      });
    });
    expect(reason({ colorMode: 'indexed' })).toBe('bad-palette');
    s.transact('no palette', (tx) => {
      tx.update((d) => {
        delete d.activePaletteId;
      });
    });
    expect(reason({ colorMode: 'indexed' })).toBe('no-palette');
    expect(reason({ paletteLocked: true })).toBe('no-palette');
    expect(reason({})).toBeUndefined(); // nothing to change
  });
});

// ---- G1-fix 9 and 7(c): the rig block position and translucent folds ---------------------------------

/** A document of flat pixel layers (bottom to top, one cel each at frame f0), with a humanoid rig. */
function layeredStore(specs: readonly { name: string; draw: (img: TiledImage) => void }[]): {
  s: DocumentStore;
  ids: (name: string) => LayerId;
} {
  const g = createIdGenerator({ seed: 8, next: 0 });
  const images: [ImageId, StoredImage][] = [];
  const byName: Record<string, LayerId> = {};
  const layers = specs.map(({ name, draw }): Document['layers'][number] => {
    const img = new TiledImage(40, 50);
    draw(img);
    const imageId = g.next('image');
    images.push([imageId, img]);
    const id = g.next('layer');
    byName[name] = id;
    return {
      kind: 'pixel',
      id,
      name,
      visible: true,
      opacity: 255,
      export: true,
      cels: { [I.f0]: { imageId, offset: { x: 0, y: 0 }, opacity: 255 } },
    };
  });
  const doc: Document = {
    meta: {
      id: I.doc,
      name: 'layered',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w: 40, h: 50 },
      origin: ORIGIN,
      pixelsPerUnit: 16,
      colorMode: 'rgba',
      paletteLocked: false,
      ids: { ...g.state() },
    },
    palettes: [{ id: I.pal, name: 'Base', colors: [[0, 0, 0, 0]], ramps: [] }],
    activePaletteId: I.pal,
    skins: [],
    layers,
    animations: [
      {
        id: I.anim,
        group: 'idle',
        loop: 'loop',
        frames: [
          {
            id: I.f0,
            durationMs: 100,
            markers: {},
            events: [],
            rootMotion: { dx: 0, dy: 0 },
            boneKeys: {},
            partKeys: {},
          },
        ],
        overrides: [],
      },
    ],
    directionFallback: {},
    markerDefs: [],
    eventDefs: [],
  };
  const s = new DocumentStore(doc, { images });
  s.transact('rig', (tx) =>
    applySkeletonTemplate(tx, humanoidSide({ height: 48, origin: ORIGIN })),
  );
  const ids = (name: string): LayerId => {
    const id = byName[name];
    if (id === undefined) throw new Error(`no layer ${name}`);
    return id;
  };
  return { s, ids };
}

const splitOf = (
  s: DocumentStore,
  layer: LayerId,
  sel: SplitSelection,
  opts: SplitRegionOptions = {},
) => s.transact('split', (tx) => splitRegion(tx, layer, I.f0, sel, opts));

function refusal(fn: () => unknown): { reason?: unknown; blocking?: unknown } {
  try {
    fn();
  } catch (e) {
    if (e instanceof CoreError) {
      return { reason: e.details?.reason, blocking: e.details?.blockingLayer };
    }
    throw e;
  }
  return {};
}

describe('splitRegion and the rig block position (G1-fix 9)', () => {
  // Bottom to top: body, shirt, jacket. The sleeve is cut from the jacket; it overlaps the shirt at x = 12.
  const clothes = [
    {
      name: 'body',
      draw: (i: TiledImage) => {
        rect(i, 10, 10, 8, 8, SKIN);
      },
    },
    {
      name: 'shirt',
      draw: (i: TiledImage) => {
        rect(i, 12, 10, 4, 8, SHIRT);
      },
    },
    {
      name: 'jacket',
      draw: (i: TiledImage) => {
        rect(i, 10, 12, 3, 6, BLUE); // sleeve, x 10..12
        rect(i, 14, 2, 2, 2, BLUE); // a pixel nothing covers
      },
    },
  ];
  const body = { kind: 'rect', x: 10, y: 10, w: 8, h: 8 } as const;
  const sleeve = { kind: 'rect', x: 10, y: 12, w: 3, h: 6 } as const;
  const narrow = { kind: 'rect', x: 10, y: 12, w: 2, h: 6 } as const;

  it('refuses a part cut from a layer above a pixel layer that covers the block (body, then jacket)', () => {
    const { s, ids } = layeredStore(clothes);
    const before = hashOf(s);
    splitOf(s, ids('body'), body, { partName: 'part:torso' });
    expect(hashOf(s)).toBe(before);
    const h = documentHash(s);
    const r = refusal(() => splitOf(s, ids('jacket'), sleeve, { partName: 'part:upper_arm_r' }));
    expect(r).toEqual({ reason: 'rig-block-order', blocking: 'shirt' });
    expect(documentHash(s)).toBe(h); // nothing changed
    // A sleeve that does not touch the shirt keeps working, and recomposites exactly.
    splitOf(s, ids('jacket'), narrow, { partName: 'part:upper_arm_r' });
    expect(hashOf(s)).toBe(before);
    expect(errorsOf(s)).toEqual([]);
    // Without a bind the layer is just a pixel layer: no part, no refusal.
    splitOf(s, ids('jacket'), { kind: 'rect', x: 12, y: 12, w: 1, h: 6 }, { bind: false });
    expect(hashOf(s)).toBe(before);
  });

  it('refuses a part cut below the block when an existing part would drop under a pixel layer (jacket, then body)', () => {
    const { s, ids } = layeredStore(clothes);
    const before = hashOf(s);
    splitOf(s, ids('jacket'), sleeve, { partName: 'part:upper_arm_r' });
    expect(hashOf(s)).toBe(before);
    const h = documentHash(s);
    expect(refusal(() => splitOf(s, ids('body'), body, { partName: 'part:torso' }))).toEqual({
      reason: 'rig-block-order',
      blocking: 'shirt',
    });
    expect(documentHash(s)).toBe(h);

    // The same with a sleeve that clears the shirt: allowed, and the frame is unchanged.
    const ok = layeredStore(clothes);
    splitOf(ok.s, ok.ids('jacket'), narrow, { partName: 'part:upper_arm_r' });
    splitOf(ok.s, ok.ids('body'), body, { partName: 'part:torso' });
    expect(hashOf(ok.s)).toBe(before);
    expect(errorsOf(ok.s)).toEqual([]);
  });

  it('a body layer and the separate outline layer above it split in either order', () => {
    const outline = (i: TiledImage): void => {
      rect(i, 9, 9, 10, 1, OUTLINE);
      rect(i, 9, 18, 10, 1, OUTLINE);
      rect(i, 9, 10, 1, 8, OUTLINE);
      rect(i, 18, 10, 1, 8, OUTLINE);
    };
    const specs = [
      {
        name: 'body',
        draw: (i: TiledImage) => {
          rect(i, 10, 10, 8, 8, SKIN);
        },
      },
      { name: 'outline', draw: outline },
    ];
    const ring = { kind: 'rect', x: 9, y: 9, w: 10, h: 10 } as const;
    for (const order of [
      ['body', 'outline'],
      ['outline', 'body'],
    ] as const) {
      const { s, ids } = layeredStore(specs);
      const before = hashOf(s);
      for (const name of order) {
        splitOf(s, ids(name), name === 'body' ? body : ring, {
          partName: name === 'body' ? 'part:torso' : 'part:head',
        });
      }
      expect(hashOf(s), order.join()).toBe(before);
      expect(errorsOf(s)).toEqual([]);
    }
  });

  it('a variant that folds into a part above a covering layer is refused; a new part below is not', () => {
    const specs = [
      {
        name: 'base',
        draw: (i: TiledImage) => {
          rect(i, 10, 10, 6, 6, SKIN);
        },
      },
      {
        name: 'shirt',
        draw: (i: TiledImage) => {
          rect(i, 12, 12, 6, 6, SHIRT);
        },
      },
      {
        name: 'cap',
        draw: (i: TiledImage) => {
          rect(i, 30, 2, 4, 4, BLUE);
        },
      },
    ];
    const base = { kind: 'rect', x: 10, y: 10, w: 6, h: 6 } as const;
    const a = layeredStore(specs);
    splitOf(
      a.s,
      a.ids('cap'),
      { kind: 'rect', x: 30, y: 2, w: 4, h: 4 },
      {
        partName: 'part:head',
      },
    );
    const h = documentHash(a.s);
    expect(refusal(() => splitOf(a.s, a.ids('base'), base, { partName: 'part:head@alt' }))).toEqual(
      { reason: 'rig-block-order', blocking: 'shirt' },
    );
    expect(documentHash(a.s)).toBe(h);
    const before = hashOf(a.s);
    splitOf(a.s, a.ids('base'), base, { partName: 'part:pelvis' });
    expect(hashOf(a.s)).toBe(before);
  });
});

describe('splitRegion folding translucent art into a part (G1-fix 7c)', () => {
  it('refuses, before anything changes, when the moved cel is translucent and would become a variant', () => {
    const s = makeStore({ celOpacity: 128 });
    split(s, { kind: 'rect', x: 17, y: 4, w: 6, h: 3 }, { partName: 'part:head' });
    const h = documentHash(s);
    expect(
      reason(() =>
        split(s, { kind: 'rect', x: 17, y: 7, w: 6, h: 3 }, { partName: 'part:head@chin' }),
      ),
    ).toBe('translucent');
    expect(documentHash(s)).toBe(h);
  });

  it('refuses the same for a translucent source layer, and still folds opaque art', () => {
    const t = makeStore({ layerOpacity: 128 });
    split(t, { kind: 'rect', x: 17, y: 4, w: 6, h: 3 }, { partName: 'part:head' });
    expect(
      reason(() =>
        split(t, { kind: 'rect', x: 17, y: 7, w: 6, h: 3 }, { partName: 'part:head@chin' }),
      ),
    ).toBe('translucent');
    const o = makeStore();
    split(o, { kind: 'rect', x: 17, y: 4, w: 6, h: 3 }, { partName: 'part:head' });
    expect(
      split(o, { kind: 'rect', x: 17, y: 7, w: 6, h: 3 }, { partName: 'part:head@chin' }).bound
        ?.merged,
    ).toBe(true);
  });
});

describe('splitRegion: the block check also applies to a bind by overlap (G1-fix 9)', () => {
  /** The pixels of a one-pixel line along `bone`'s rest segment, from a rig-only probe document. */
  function lineAlong(bone: string): [number, number][] {
    const r = layeredStore([]).s.doc.rig;
    const view = r?.views[0];
    const b = r?.bones.find((x) => x.name === bone);
    if (r === undefined || view === undefined || b === undefined) throw new Error('rig');
    const sb = snapSkeleton(r, view, new Map()).bones.get(b.id);
    if (sb === undefined) throw new Error('bone');
    const [dx, dy] = rotatePoint(b.length, 0, sb.restAngle);
    const n = Math.max(Math.abs(dx), Math.abs(dy), 1);
    const out: [number, number][] = [];
    for (let k = 0; k <= n; k++) {
      out.push([sb.pivot.x + Math.round((dx * k) / n), sb.pivot.y + Math.round((dy * k) / n)]);
    }
    return out;
  }
  const draw = (pixels: [number, number][], c: Rgba) => (i: TiledImage) => {
    for (const [x, y] of pixels) i.set(x, y, c);
  };

  it('refuses when overlap would bind the new layer above a covering pixel layer', () => {
    const neck = lineAlong('neck');
    const specs = [
      { name: 'body', draw: draw(lineAlong('head'), SKIN) },
      { name: 'shirt', draw: draw(neck, SHIRT) },
      { name: 'jacket', draw: draw(neck, BLUE) },
    ];
    const { s, ids } = layeredStore(specs);
    const all = { kind: 'rect', x: 0, y: 0, w: 40, h: 50 } as const;
    const first = splitOf(s, ids('body'), all);
    expect(first.bound?.how).toBe('overlap');
    const h = documentHash(s);
    expect(refusal(() => splitOf(s, ids('jacket'), all))).toEqual({
      reason: 'rig-block-order',
      blocking: 'shirt',
    });
    expect(documentHash(s)).toBe(h);
    // Not asked to bind: it stays a pixel layer.
    expect(splitOf(s, ids('jacket'), all, { bind: false }).bound).toBeUndefined();
  });
});
