import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type { Animation, AnimRef, Document, ImageId, Layer, PostPasses } from '@pixel-forge/schema';
import { asciiToImage } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import {
  DocumentStore,
  attributeEditTx,
  bakeAnimation,
  createRigRenderer,
  deleteFrame,
  insertFrame,
  renderFrame,
  validate,
} from '../src/index.js';
import type { StoredImage } from '../src/index.js';
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
  grp: gen.next('layer'),
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
  /** Put the part layers (all, or only the first with `first`) in a group with these properties. */
  group?: { opacity?: number; visible?: boolean; export?: boolean; first?: boolean };
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
  let layers: Layer[] = [part(I.layArm), part(I.layLeg)];
  if (o.group !== undefined) {
    const g = o.group;
    const members = g.first === true ? [part(I.layArm)] : layers;
    layers = [
      {
        kind: 'group',
        id: I.grp,
        name: 'rig',
        visible: g.visible ?? true,
        opacity: g.opacity ?? 255,
        export: g.export ?? true,
        children: members,
      },
      ...(g.first === true ? [part(I.layLeg)] : []),
    ];
  }
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

/** Two frames: frame 0 has a part and a final override, frame 1 a bone key; outline post-pass. */
function prepared(o: Opts = {}): DocumentStore {
  const store = makeStore({
    fx: true,
    fxExport: true,
    postPasses: { outline: { color: [255, 255, 255, 255] } },
    ...o,
  });
  store.transact('second frame', (tx) => {
    const f1 = insertFrame(tx, A, 0, { position: 'after' });
    tx.update((d) => {
      const an = d.animations[0];
      const fr =
        an !== undefined && 'frames' in an ? an.frames.find((f) => f.id === f1) : undefined;
      if (fr !== undefined) fr.boneKeys = { [I.boneArm]: { angle: 90 } };
    });
  });
  // a part override (arm pixel) and a final override (leg) on frame 0, via an edited render
  const edited = renderFrame(store, A, 0, { exportOnly: true, rig: createRigRenderer() }).clone();
  edited.set(2, 3, [255, 255, 0, 255]);
  edited.set(0, 5, [255, 0, 255, 255]);
  store.transact('edit', (tx) => attributeEditTx(tx, A, 0, edited));
  return store;
}

const hashes = (store: DocumentStore, ref: AnimRef, n: number): string[] =>
  Array.from({ length: n }, (_, i) =>
    renderFrame(store, ref, i, { exportOnly: true, rig: createRigRenderer() }).hashRGBA(),
  );

describe('bakeAnimation (FR-RIG-23)', () => {
  it('new: baked frames equal the rig render, source and mirror stay', () => {
    const store = prepared();
    const before = hashes(store, A, 2);
    const mirrorBefore = hashes(store, MIRROR, 2);
    expect(store.doc.animations[0]?.overrides.map((o) => o.target === 'final')).toEqual([
      false,
      true,
    ]);
    const res = store.transact('bake', (tx) =>
      bakeAnimation(tx, A, { mode: 'new', name: 'act_b' }),
    );
    const baked: AnimRef = { id: res.animationId };
    expect(hashes(store, baked, 2)).toEqual(before);
    expect(hashes(store, A, 2)).toEqual(before);
    expect(hashes(store, MIRROR, 2)).toEqual(mirrorBefore);
    expect(res.dropped.overrides).toEqual([]);
    const b = store.doc.animations.find((a) => a.id === res.animationId);
    expect(b).toMatchObject({ group: 'act_b', direction: 'side' });
    expect(validate(store).filter((f) => f.severity === 'error')).toEqual([]);
    store.undo();
    expect(store.doc.animations).toHaveLength(2);
    expect(store.doc.layers.some((l) => l.name === 'baked')).toBe(false);
  });

  it('replace: same render, keys, overrides and post-passes dropped and reported; mirror still equals', () => {
    const store = prepared();
    const before = hashes(store, A, 2);
    const mirrorBefore = hashes(store, MIRROR, 2);
    const imagesBefore = store.imageIds().length;
    const res = store.transact('bake', (tx) => bakeAnimation(tx, A, { mode: 'replace' }));
    expect(hashes(store, A, 2)).toEqual(before);
    expect(hashes(store, MIRROR, 2)).toEqual(mirrorBefore);
    expect(res.animationId).toBe(I.anim);
    expect(res.dropped).toMatchObject({ boneKeys: 1, partKeys: 0, postPasses: true });
    expect(res.dropped.overrides).toHaveLength(2);
    expect(res.dropped.cels).toBe(1); // the fx cel of frame 0
    const a = store.doc.animations[0];
    expect(a && 'frames' in a && a.overrides).toEqual([]);
    expect(a && 'frames' in a && a.postPasses).toBeUndefined();
    expect(a && 'frames' in a && a.frames.map((f) => f.id)).toEqual(res.frames);
    expect(validate(store).filter((f) => f.severity === 'error')).toEqual([]);
    expect(store.imageIds().length).toBeLessThan(imagesBefore + 2);
    store.undo();
    expect(hashes(store, A, 2)).toEqual(before);
  });

  it('indexed documents bake to indexed cels', () => {
    const store = prepared({ indexed: true });
    const before = hashes(store, A, 2);
    store.transact('bake', (tx) => bakeAnimation(tx, A, { mode: 'replace' }));
    expect(hashes(store, A, 2)).toEqual(before);
    const layer = store.doc.layers.find((l) => l.name === 'baked');
    const cel = layer?.kind === 'pixel' ? Object.values(layer.cels)[0] : undefined;
    expect(cel && 'imageId' in cel && store.image(cel.imageId) instanceof IndexedImage).toBe(true);
  });

  it('refuses a mirror, a taken name and a bad name, leaving the document unchanged', () => {
    const store = prepared();
    const v = store.version;
    const run = (ref: AnimRef, name?: string): string | undefined =>
      codeOf(() =>
        store.transact('bake', (tx) =>
          bakeAnimation(tx, ref, { mode: 'new', ...(name === undefined ? {} : { name }) }),
        ),
      );
    expect(run(MIRROR)).toBe('BAD_ARGUMENT');
    expect(run(A, 'act')).toBe('BAD_ARGUMENT');
    expect(run(A, 'no good')).toBe('BAD_ARGUMENT');
    expect(store.version).toBe(v);
  });

  it('bakes parts that sit in a translucent group to exactly the pre-bake render (G1-fix 1)', () => {
    for (const mode of ['new', 'replace'] as const) {
      const store = prepared({ group: { opacity: 128 } });
      const before = hashes(store, A, 2);
      const res = store.transact('bake', (tx) => bakeAnimation(tx, A, { mode }));
      const ref: AnimRef = mode === 'new' ? { id: res.animationId } : A;
      expect(hashes(store, ref, 2), mode).toEqual(before);
      // the baked layer is a top-level layer with its own full opacity, below the group that held the rig
      const names = store.doc.layers.map((l) => l.name);
      expect(names, mode).toEqual(['baked', 'rig', 'fx']);
      expect(store.doc.layers[0]).toMatchObject({ opacity: 255, visible: true, export: true });
      expect(validate(store).filter((f) => f.severity === 'error')).toEqual([]);
    }
  });

  it('bakes when the first part layer is in a hidden or not exported group (G1-fix 1)', () => {
    for (const group of [{ visible: false }, { export: false }]) {
      for (const mode of ['new', 'replace'] as const) {
        const store = prepared({ group: { ...group, first: true } });
        const before = hashes(store, A, 2);
        const res = store.transact('bake', (tx) => bakeAnimation(tx, A, { mode }));
        const ref: AnimRef = mode === 'new' ? { id: res.animationId } : A;
        const label = `${JSON.stringify(group)} ${mode}`;
        expect(hashes(store, ref, 2), label).toEqual(before);
        expect(
          store.doc.layers.map((l) => l.name),
          label,
        ).toEqual(['baked', 'rig', I.layLeg, 'fx']);
      }
    }
  });

  it('hides the rig on every baked frame, so deleting frame 0 keeps the baked pixels (G1-fix 4)', () => {
    for (const mode of ['new', 'replace'] as const) {
      const store = prepared();
      const before = hashes(store, A, 2);
      const res = store.transact('bake', (tx) => bakeAnimation(tx, A, { mode }));
      const ref: AnimRef = mode === 'new' ? { id: res.animationId } : A;
      const anim = store.doc.animations.find((a) => a.id === res.animationId);
      if (anim === undefined || !('frames' in anim)) throw new Error('animation');
      const hidden = { [I.partArm]: { visible: false }, [I.partLeg]: { visible: false } };
      expect(
        anim.frames.map((f) => f.partKeys),
        mode,
      ).toEqual([hidden, hidden]);
      store.transact('delete frame 0', (tx) => {
        deleteFrame(tx, ref, 0);
      });
      expect(hashes(store, ref, 1), mode).toEqual([before[1]]);
    }
  });

  it('a second bake gets a fresh layer name', () => {
    const store = prepared();
    store.transact('b1', (tx) => bakeAnimation(tx, A, { mode: 'new', name: 'one' }));
    store.transact('b2', (tx) => bakeAnimation(tx, A, { mode: 'new', name: 'two' }));
    expect(store.doc.layers.map((l) => l.name)).toContain('baked_2');
  });
});
