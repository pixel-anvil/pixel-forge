import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type {
  Animation,
  AnimRef,
  BoneKey,
  Document,
  ImageId,
  Layer,
  PostPasses,
} from '@pixel-forge/schema';
import { asciiToImage, expectAscii } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import {
  DocumentStore,
  CoreError,
  attributeEditTx,
  attributeEditTxReport,
  checkOverrides,
  createRigRenderer,
  renderFrame,
  validate,
} from '../src/index.js';
import type { AttributeEditOptions, StoredImage } from '../src/index.js';
import { blankFrame, codeOf } from './helpers.js';

const legend = {
  R: [255, 0, 0, 255],
  G: [0, 255, 0, 255],
  B: [0, 0, 255, 255],
  Y: [255, 255, 0, 255],
  M: [255, 0, 255, 255],
  W: [255, 255, 255, 255],
  h: [255, 0, 0, 128],
} as const;
const rgba = (ascii: string): TiledImage => TiledImage.fromRGBA(asciiToImage(ascii, legend));

const gen = createIdGenerator({ seed: 47, next: 0 });
const I = {
  doc: gen.next('doc'),
  pal: gen.next('palette'),
  anim: gen.next('animation'),
  mirror: gen.next('animation'),
  f0: gen.next('frame'),
  layArm: gen.next('layer'),
  layLeg: gen.next('layer'),
  layFx: gen.next('layer'),
  boneArm: gen.next('bone'),
  boneLeg: gen.next('bone'),
  partArm: gen.next('part'),
  partLeg: gen.next('part'),
  view: gen.next('view'),
  varArm: gen.next('variant'),
  varLeg: gen.next('variant'),
  imgArm: gen.next('image'),
  imgLeg: gen.next('image'),
  imgFx: gen.next('image'),
};
const idState = gen.state();

const PALETTE: [number, number, number, number][] = [
  [0, 0, 0, 0],
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [255, 255, 0, 255],
  [255, 0, 255, 255],
  [255, 255, 255, 255],
];

const part = (id: Layer['id'], extra: Partial<Layer> = {}): Layer =>
  ({ kind: 'part', id, name: id, visible: true, opacity: 255, export: true, ...extra }) as Layer;

interface Opts {
  postPasses?: PostPasses;
  /** A pixel layer above the parts: `W` at (3, 2), editor-only unless `fxExport`. */
  fx?: boolean;
  fxExport?: boolean;
  indexed?: boolean;
}

/**
 * A 10×6 document: an arm (pivot (2, 2), `RRB / R..`) and a leg (pivot (7, 1), `B B G`), both root
 * bones, one frame; plus a mirror animation `act/side_l`.
 */
function makeStore(o: Opts = {}): DocumentStore {
  const anims: Animation[] = [
    {
      id: I.anim,
      group: 'act',
      direction: 'side',
      loop: 'loop',
      frames: [blankFrame(I.f0)],
      overrides: [],
      ...(o.postPasses === undefined ? {} : { postPasses: o.postPasses }),
    },
    { id: I.mirror, group: 'act', direction: 'side_l', mirrorOf: I.anim, overrides: [] },
  ];
  const layers: Layer[] = [part(I.layArm), part(I.layLeg)];
  if (o.fx === true) {
    layers.push({
      kind: 'pixel',
      id: I.layFx,
      name: 'fx',
      visible: true,
      opacity: 255,
      export: o.fxExport === true,
      cels: { [I.f0]: { imageId: I.imgFx, offset: { x: 3, y: 2 }, opacity: 255 } },
    });
  }
  const doc: Document = {
    meta: {
      id: I.doc,
      name: 'attribute',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w: 10, h: 6 },
      origin: { x: 5, y: 5 },
      pixelsPerUnit: 16,
      colorMode: o.indexed === true ? 'indexed' : 'rgba',
      paletteLocked: false,
      ids: { ...idState },
    },
    palettes: [{ id: I.pal, name: 'p', colors: PALETTE, ramps: [] }],
    activePaletteId: I.pal,
    skins: [],
    layers,
    animations: anims,
    directionFallback: {},
    markerDefs: [],
    eventDefs: [],
    rig: {
      bones: [
        { id: I.boneArm, name: 'arm', length: 3 },
        { id: I.boneLeg, name: 'leg', length: 3 },
      ],
      parts: [
        {
          id: I.partArm,
          boneId: I.boneArm,
          layerId: I.layArm,
          variants: [
            {
              id: I.varArm,
              name: 'default',
              viewId: I.view,
              imageId: I.imgArm,
              pivot: { x: 0, y: 0 },
              tags: [],
            },
          ],
        },
        {
          id: I.partLeg,
          boneId: I.boneLeg,
          layerId: I.layLeg,
          variants: [
            {
              id: I.varLeg,
              name: 'default',
              viewId: I.view,
              imageId: I.imgLeg,
              pivot: { x: 0, y: 0 },
              tags: [],
            },
          ],
        },
      ],
      views: [
        {
          id: I.view,
          name: 'side',
          directions: ['side', 'side_l'],
          rest: {
            [I.boneArm]: { x: 2, y: 2, angle: 0 },
            [I.boneLeg]: { x: 7, y: 1, angle: 0 },
          },
          partVisibility: {},
          defaultZ: { [I.partArm]: 1 },
        },
      ],
    },
  };
  const images: [ImageId, StoredImage][] =
    o.indexed === true
      ? [
          [I.imgArm, IndexedImage.fromIndices(3, 2, Uint8Array.from([1, 1, 3, 1, 0, 0]), 0)],
          [I.imgLeg, IndexedImage.fromIndices(1, 3, Uint8Array.from([3, 3, 2]), 0)],
        ]
      : [
          [I.imgArm, rgba('RRB\nR..')],
          [I.imgLeg, rgba('B\nB\nG')],
        ];
  if (o.fx === true) images.push([I.imgFx, rgba('W')]);
  return new DocumentStore(doc, { images });
}

const A: AnimRef = { group: 'act', direction: 'side' };
const MIRROR: AnimRef = { group: 'act', direction: 'side_l' };

/** Imports `edited` as overrides of frame 0, then checks the round trip and the new overrides. */
function importEdit(
  store: DocumentStore,
  edited: TiledImage,
  anim: AnimRef = A,
  opts: AttributeEditOptions = {},
): string[] {
  const ids = store.transact('override import', (tx) => attributeEditTx(tx, anim, 0, edited, opts));
  const render = { exportOnly: true, ...(opts.render ?? {}) };
  expect(renderFrame(store, anim, 0, { ...render, rig: createRigRenderer() }).hashRGBA()).toBe(
    edited.hashRGBA(),
  );
  const status = checkOverrides(store, { render });
  expect(status.filter((s) => ids.includes(s.overrideId)).map((s) => s.stale)).toEqual(
    ids.map(() => false),
  );
  expect(validate(store)).toEqual([]);
  return ids.map((id) => {
    const o = store.doc.animations.flatMap((a) => a.overrides).find((x) => x.id === id);
    return o === undefined ? '?' : o.target === 'final' ? 'final' : o.target.partId;
  });
}

function pose(store: DocumentStore, bones: Partial<Record<string, BoneKey>>): void {
  store.transact('pose', (tx) => {
    tx.update((d) => {
      const a = d.animations[0];
      const f = a !== undefined && 'frames' in a ? a.frames[0] : undefined;
      if (f !== undefined) f.boneKeys = bones as typeof f.boneKeys;
    });
  });
}

describe('attributeEditTx: pf override import (FR-RIG-24)', () => {
  it('writes a part override and a final override that reproduce the edit exactly, as one undo step', () => {
    const store = makeStore();
    expect(
      importEdit(
        store,
        rgba(`
        ..........
        .......B..
        ..RYB..BY.
        ..R....G..
        ..........
        ..........`),
      ),
    ).toEqual([I.partArm, 'final']);
    const [arm, final] = store.doc.animations[0]?.overrides ?? [];
    expect(arm).toMatchObject({ frameId: I.f0, anchor: { x: 1, y: 0 } });
    expect(final).toMatchObject({ frameId: I.f0, target: 'final', anchor: { x: 8, y: 2 } });
    const images = store.imageIds().length;
    store.undo();
    expect(store.doc.animations[0]?.overrides).toEqual([]);
    expect(store.imageIds().length).toBe(images - 2);
  });

  it('the part override follows a translation and goes stale on rotation (W4)', () => {
    const store = makeStore();
    importEdit(
      store,
      rgba(`
      ..........
      .......B..
      ..RYB..B..
      ..R....G..
      ..........
      ..........`),
    );
    pose(store, { [I.boneArm]: { offset: { x: 1, y: 2 } } });
    expectAscii(
      renderFrame(store, A, 0, { rig: createRigRenderer() }).toRGBA(),
      `
      ..........
      .......B..
      .......B..
      .......G..
      ...RYB....
      ...R......`,
      legend,
    );
    expect(checkOverrides(store).map((s) => s.stale)).toEqual([false]);
    pose(store, { [I.boneArm]: { angle: 90 } });
    expect(checkOverrides(store).map((s) => [s.stale, s.reason])).toEqual([[true, 'hash']]);
  });

  it('nothing changed: no overrides; a wrong size is refused', () => {
    const store = makeStore();
    const same = renderFrame(store, A, 0, { rig: createRigRenderer() });
    expect(store.transact('none', (tx) => attributeEditTx(tx, A, 0, same))).toEqual([]);
    expect(store.doc.animations[0]?.overrides).toEqual([]);
    expect(
      codeOf(() => store.transact('bad', (tx) => attributeEditTx(tx, A, 0, new TiledImage(3, 3)))),
    ).toBe('BAD_ARGUMENT');
  });

  it("a mirror's edit becomes a final override of the mirror, against the flipped render", () => {
    const store = makeStore();
    const flipped = renderFrame(store, MIRROR, 0, { rig: createRigRenderer() });
    expectAscii(
      flipped.toRGBA(),
      `
      ..........
      ...B......
      ...B..BRR.
      ...G....R.
      ..........
      ..........`,
      legend,
    );
    const edited = flipped.clone();
    edited.set(7, 2, [255, 255, 0, 255]); // inside the (flipped) arm: still final for a mirror
    expect(importEdit(store, edited, MIRROR)).toEqual(['final']);
    expect(store.doc.animations[1]?.overrides).toHaveLength(1);
    expect(store.doc.animations[0]?.overrides).toEqual([]);
  });

  it('an edit under an exported layer above the parts is final; an editor-only layer is ignored', () => {
    const edit = rgba(`
      ..........
      .......B..
      ..RYB..B..
      ..R....G..
      ..........
      ..........`);
    // the fx pixel at (3, 2) is not exported: the export render shows the arm there
    expect(importEdit(makeStore({ fx: true }), edit)).toEqual([I.partArm]);
    // exported, it covers the arm, so a part override could not show through
    expect(importEdit(makeStore({ fx: true, fxExport: true }), edit)).toEqual(['final']);
  });

  it('post-passes: the outline is recomputed from the parts, and what it moves goes final', () => {
    const outline: PostPasses = { outline: { color: [255, 0, 255, 255] } };
    const store = makeStore({ postPasses: outline });
    const before = renderFrame(store, A, 0, { exportOnly: true, rig: createRigRenderer() });
    // recolour inside the arm: the silhouette (and so the outline) is unchanged
    const inside = before.clone();
    inside.set(3, 2, [255, 255, 0, 255]);
    expect(importEdit(store, inside)).toEqual([I.partArm]);
    // erase the leg's foot: the outline would come back around the new silhouette, on that very
    // pixel, so it cannot be a part override
    const erase = renderFrame(store, A, 0, { exportOnly: true, rig: createRigRenderer() });
    erase.set(7, 3, [0, 0, 0, 0]);
    expect(importEdit(store, erase)).toEqual(['final']);
  });

  it('indexed documents get indexed set images; a colour outside the palette is refused', () => {
    const store = makeStore({ indexed: true });
    const before = renderFrame(store, A, 0, { rig: createRigRenderer() });
    const edited = before.clone();
    edited.set(3, 2, [255, 255, 0, 255]); // arm
    edited.set(0, 0, [255, 0, 255, 255]); // outside every part
    expect(importEdit(store, edited)).toEqual([I.partArm, 'final']);
    for (const o of store.doc.animations[0]?.overrides ?? []) {
      expect(store.image(o.set ?? ('' as ImageId))).toBeInstanceOf(IndexedImage);
    }
    const odd = edited.clone();
    odd.set(9, 5, [1, 2, 3, 255]);
    expect(codeOf(() => store.transact('odd', (tx) => attributeEditTx(tx, A, 0, odd)))).toBe(
      'BAD_VALUE',
    );
  });

  it('translucent edits and erasures round-trip exactly', () => {
    const store = makeStore();
    expect(
      importEdit(
        store,
        rgba(`
        h.........
        .......B..
        ..RhB.....
        ..R....G..
        ..........
        ..........`),
      ),
    ).toEqual([I.partLeg, I.partArm, 'final']);
  });

  it('an unknown animation is BAD_ARGUMENT with reason unknown-animation', () => {
    const store = makeStore();
    let err: unknown;
    try {
      store.transact('bad', (tx) =>
        attributeEditTx(tx, { group: 'nope', direction: 'side' }, 0, new TiledImage(10, 6)),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CoreError);
    expect((err as CoreError).code).toBe('BAD_ARGUMENT');
    expect((err as CoreError).details).toMatchObject({ reason: 'unknown-animation' });
  });

  it('a new part override stales an existing final override of the frame; the report lists it', () => {
    const store = makeStore();
    // a final override at (3, 2)'s neighbour (3, 3), outside every part
    const before = renderFrame(store, A, 0, { exportOnly: true, rig: createRigRenderer() });
    const withFinal = before.clone();
    withFinal.set(3, 3, [255, 255, 0, 255]);
    expect(importEdit(store, withFinal)).toEqual(['final']);
    const finalId = store.doc.animations[0]?.overrides[0]?.id;
    // erase the arm pixel (2, 3): a part override whose pixel lies in the final's region (2..4, 2..4)
    const erased = withFinal.clone();
    erased.set(2, 3, [0, 0, 0, 0]);
    const report = store.transact('import', (tx) => attributeEditTxReport(tx, A, 0, erased));
    expect(report.ids).toHaveLength(1);
    expect(report.newlyStale.map((s) => [s.overrideId, s.mirror, s.stale, s.reason])).toEqual([
      [finalId, false, true, 'hash'],
    ]);
    // the render is still exact, and the new override itself is valid
    expect(
      renderFrame(store, A, 0, { exportOnly: true, rig: createRigRenderer() }).hashRGBA(),
    ).toBe(erased.hashRGBA());
  });

  it("an import into a source animation can stale its mirror's final override; the report lists it", () => {
    const store = makeStore();
    const flipped = renderFrame(store, MIRROR, 0, { exportOnly: true, rig: createRigRenderer() });
    const edited = flipped.clone();
    edited.set(7, 2, [255, 255, 0, 255]); // the mirror's final, over the flipped arm
    expect(importEdit(store, edited, MIRROR)).toEqual(['final']);
    const mirrorFinal = store.doc.animations[1]?.overrides[0]?.id;
    // far from the mirror final's region (6..8, 1..3): the source's leg tip (7, 3) mirrors to x = 2
    const far = renderFrame(store, A, 0, { exportOnly: true, rig: createRigRenderer() });
    far.set(7, 3, [255, 255, 0, 255]);
    const calm = store.transact('far', (tx) => attributeEditTxReport(tx, A, 0, far));
    expect(calm.ids).toHaveLength(1);
    expect(calm.newlyStale).toEqual([]);
    // the arm pixel (3, 2) of the source is (6, 2) in the mirror: inside the final's region
    const near = renderFrame(store, A, 0, { exportOnly: true, rig: createRigRenderer() });
    near.set(3, 2, [0, 255, 255, 255]);
    const report = store.transact('near', (tx) => attributeEditTxReport(tx, A, 0, near));
    expect(report.ids).toHaveLength(1);
    expect(report.newlyStale.map((s) => [s.overrideId, s.mirror, s.reason])).toEqual([
      [mirrorFinal, true, 'hash'],
    ]);
    // attributeEditTx keeps returning just the ids
    const plain = renderFrame(store, A, 0, { exportOnly: true, rig: createRigRenderer() });
    plain.set(0, 0, [255, 0, 255, 255]);
    const ids = store.transact('plain', (tx) => attributeEditTx(tx, A, 0, plain));
    expect(ids).toHaveLength(1);
  });

  it('erase masks are 8-bit IndexedImages with 255 where they clear, in RGBA and indexed documents', () => {
    for (const indexed of [false, true]) {
      const store = makeStore({ indexed });
      const before = renderFrame(store, A, 0, { exportOnly: true, rig: createRigRenderer() });
      const edited = before.clone();
      edited.set(2, 3, [0, 0, 0, 0]);
      importEdit(store, edited);
      const erase = store.doc.animations[0]?.overrides[0]?.erase;
      const mask = store.image(erase ?? ('' as ImageId));
      expect(mask).toBeInstanceOf(IndexedImage);
      expect(Array.from((mask as IndexedImage).toIndices())).toEqual([255]);
    }
  });
});
