import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type {
  Animation,
  AuthoredAnimation,
  BoneKey,
  Document,
  ImageId,
  Layer,
  Override,
  PartKey,
  PostPasses,
} from '@pixel-forge/schema';
import { PART_RENDER_KEY } from '@pixel-forge/rig';
import { asciiToImage, expectAscii } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import {
  CoreError,
  DocumentStore,
  checkOverrides,
  createFrameRenderer,
  createRigRenderer,
  discardOverrides,
  listStaleOverrides,
  rebaseOverrides,
  renderFrame,
  renderInputKey,
  validate,
} from '../src/index.js';
import type { PartRenderer, RigRenderer, StoredImage } from '../src/index.js';
import { blankFrame } from './helpers.js';

const legend = {
  R: [255, 0, 0, 255],
  G: [0, 255, 0, 255],
  B: [0, 0, 255, 255],
  Y: [255, 255, 0, 255],
  M: [255, 0, 255, 255],
  W: [255, 255, 255, 255],
} as const;
const rgba = (ascii: string): TiledImage => TiledImage.fromRGBA(asciiToImage(ascii, legend));
function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing');
  return v;
}

const gen = createIdGenerator({ seed: 31, next: 0 });
const I = {
  doc: gen.next('doc'),
  pal: gen.next('palette'),
  skin: gen.next('skin'),
  anim: gen.next('animation'),
  mirror: gen.next('animation'),
  f0: gen.next('frame'),
  f1: gen.next('frame'),
  layBg: gen.next('layer'),
  layArm: gen.next('layer'),
  layLeg: gen.next('layer'),
  layFx: gen.next('layer'),
  boneArm: gen.next('bone'),
  boneLeg: gen.next('bone'),
  partArm: gen.next('part'),
  partLeg: gen.next('part'),
  view: gen.next('view'),
  varArm: gen.next('variant'),
  varArm2: gen.next('variant'),
  varLeg: gen.next('variant'),
  imgArm: gen.next('image'),
  imgArm2: gen.next('image'),
  imgLeg: gen.next('image'),
  imgDot: gen.next('image'),
  imgFinal: gen.next('image'),
  imgBg: gen.next('image'),
  imgRed: gen.next('image'),
  ovArm: gen.next('override'),
  ovLeg: gen.next('override'),
  ovFinal: gen.next('override'),
  ovMirror: gen.next('override'),
  ovMirrorPart: gen.next('override'),
};
const idState = gen.state();
const PLACEHOLDER = '0'.repeat(64);

const layer = (id: Layer['id'], kind: 'part' | 'pixel', extra: Partial<Layer> = {}): Layer =>
  ({
    kind,
    id,
    name: id.replace('lay_', 'l'),
    visible: true,
    opacity: 255,
    export: true,
    ...(kind === 'pixel' ? { cels: {} } : {}),
    ...extra,
  }) as Layer;

const partOv = (
  id: Override['id'],
  part: 'arm' | 'leg',
  anchor: { x: number; y: number },
): Override => ({
  id,
  frameId: I.f0,
  target: { partId: part === 'arm' ? I.partArm : I.partLeg },
  anchor,
  set: I.imgDot,
  baseHash: PLACEHOLDER,
});

interface Opts {
  bones?: Partial<Record<string, BoneKey>>;
  parts?: Partial<Record<string, PartKey>>;
  overrides?: Override[];
  postPasses?: PostPasses;
  leg?: boolean;
  layers?: Layer[];
  mirror?: Override[];
  rig?: boolean;
}

/**
 * A 10×6 RGBA document: an arm (pivot (2, 2), drawing `RRB / R..`) and, optionally, a leg (pivot
 * (7, 1), drawing `B B G`), both root bones; one animation `act` (frame f0 keyed by `opts`, f1 blank).
 */
function makeStore(o: Opts = {}): DocumentStore {
  const leg = o.leg ?? true;
  const anim: AuthoredAnimation = {
    id: I.anim,
    group: 'act',
    direction: 'side',
    loop: 'loop',
    frames: [
      {
        ...blankFrame(I.f0),
        boneKeys: { ...(o.bones ?? {}) } as AuthoredAnimation['frames'][number]['boneKeys'],
        partKeys: { ...(o.parts ?? {}) } as AuthoredAnimation['frames'][number]['partKeys'],
      },
      blankFrame(I.f1),
    ],
    overrides: o.overrides ?? [],
    ...(o.postPasses === undefined ? {} : { postPasses: o.postPasses }),
  };
  const animations: Animation[] = [anim];
  if (o.mirror !== undefined) {
    animations.push({
      id: I.mirror,
      group: 'act',
      direction: 'side_l',
      mirrorOf: I.anim,
      overrides: o.mirror,
    });
  }
  const doc: Document = {
    meta: {
      id: I.doc,
      name: 'rigrender',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w: 10, h: 6 },
      origin: { x: 5, y: 5 },
      pixelsPerUnit: 16,
      colorMode: 'rgba',
      paletteLocked: false,
      ids: { ...idState },
    },
    palettes: [
      {
        id: I.pal,
        name: 'p',
        colors: [
          [0, 0, 0, 0],
          [255, 0, 0, 255],
          [0, 255, 0, 255],
          [0, 0, 255, 255],
          [255, 255, 0, 255],
          [255, 0, 255, 255],
        ],
        ramps: [],
      },
    ],
    activePaletteId: I.pal,
    skins: [{ id: I.skin, name: 'green', remap: [[1, 2]] }],
    layers: o.layers ?? [layer(I.layArm, 'part'), ...(leg ? [layer(I.layLeg, 'part')] : [])],
    animations,
    directionFallback: {},
    markerDefs: [],
    eventDefs: [],
  };
  if (o.rig !== false) {
    doc.rig = {
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
            {
              id: I.varArm2,
              name: 'alt',
              viewId: I.view,
              imageId: I.imgArm2,
              pivot: { x: 0, y: 0 },
              tags: [],
            },
          ],
        },
        ...(leg
          ? [
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
            ]
          : []),
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
    };
  }
  const images: [ImageId, StoredImage][] = [
    [I.imgArm, rgba('RRB\nR..')],
    [I.imgArm2, rgba('GGG\nG..')],
    [I.imgLeg, rgba('B\nB\nG')],
    [I.imgDot, rgba('Y')],
    [I.imgFinal, rgba('G..\n...\n..Y')],
    [I.imgBg, rgba('WWWWWWWWWW\nWWWWWWWWWW')],
    [I.imgRed, rgba('R')],
  ];
  return new DocumentStore(doc, { images });
}

const A = { group: 'act', direction: 'side' } as const;
const M = { group: 'act', direction: 'side_l' } as const;
const W4_OVERRIDES = (): Override[] => [
  partOv(I.ovArm, 'arm', { x: 3, y: 0 }),
  partOv(I.ovLeg, 'leg', { x: 1, y: 1 }),
];

/** Captures every override's baseHash, as an editor stroke would when writing it. */
function rebaseAll(store: DocumentStore): void {
  const ids = store.doc.animations.flatMap((a) =>
    a.overrides.filter((o) => !('mirrorOf' in a) || o.target === 'final').map((o) => o.id),
  );
  store.transact('rebase', (tx) => {
    rebaseOverrides(tx, ids);
  });
}

/** Changes frame f0's keys, the way posing would. */
function pose(
  store: DocumentStore,
  bones: Partial<Record<string, BoneKey>>,
  parts: Partial<Record<string, PartKey>> = {},
): void {
  store.transact('pose', (tx) => {
    tx.update((d) => {
      const a = d.animations[0];
      const f = a !== undefined && 'frames' in a ? a.frames[0] : undefined;
      if (f === undefined) return;
      f.boneKeys = bones as typeof f.boneKeys;
      f.partKeys = parts as typeof f.partKeys;
    });
  });
}

const staleById = (store: DocumentStore) =>
  Object.fromEntries(checkOverrides(store).map((s) => [s.overrideId, s.stale]));

describe('createRigRenderer + renderFrame: W4 (part overrides, staleness, pipeline order)', () => {
  it('the fixture is a valid document', () => {
    const store = makeStore({ overrides: W4_OVERRIDES(), mirror: [] });
    expect(validate(store).filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('a translated part carries its override along, and the override stays valid', () => {
    const store = makeStore({ overrides: W4_OVERRIDES() });
    rebaseAll(store);
    const rig = createRigRenderer();
    expectAscii(
      renderFrame(store, A, 0, { rig }).toRGBA(),
      `
      ..........
      .......B..
      ..RRBY.BY.
      ..R....G..
      ..........
      ..........`,
      legend,
    );
    pose(store, { [I.boneArm]: { offset: { x: 1, y: 2 } } });
    expectAscii(
      renderFrame(store, A, 0, { rig }).toRGBA(),
      `
      ..........
      .......B..
      .......BY.
      .......G..
      ...RRBY...
      ...R......`,
      legend,
    );
    expect(staleById(store)).toEqual({ [I.ovArm]: false, [I.ovLeg]: false });
  });

  it("a rotated part's override goes stale (kept in place, not moved or dropped); an untouched part's stays valid", () => {
    const store = makeStore({ overrides: W4_OVERRIDES() });
    rebaseAll(store);
    pose(store, { [I.boneArm]: { angle: 90 } });
    expectAscii(
      renderFrame(store, A, 0, { rig: createRigRenderer() }).toRGBA(),
      `
      ..........
      .......B..
      .RR..Y.BY.
      ..R....G..
      ..B.......
      ..........`,
      legend,
    );
    const status = checkOverrides(store);
    expect(status.map((s) => [s.overrideId, s.stale, s.reason])).toEqual([
      [I.ovArm, true, 'hash'],
      [I.ovLeg, false, undefined],
    ]);
    expect(listStaleOverrides(store).map((s) => s.overrideId)).toEqual([I.ovArm]);
  });

  it('the outline post-pass runs after the part overrides and before the final overrides', () => {
    const final: Override = {
      id: I.ovFinal,
      frameId: I.f0,
      target: 'final',
      anchor: { x: 6, y: 2 },
      set: I.imgFinal,
      baseHash: PLACEHOLDER,
    };
    const store = makeStore({
      leg: false,
      overrides: [partOv(I.ovArm, 'arm', { x: 3, y: 0 }), final],
      postPasses: { outline: { color: [255, 0, 255, 255] } },
    });
    // the part override (Y at (5, 2)) is outlined; the final override's G replaces an outline pixel
    // and its Y at (8, 4) gets no outline
    expectAscii(
      renderFrame(store, A, 0, { rig: createRigRenderer() }).toRGBA(),
      `
      ..........
      ..MMMM....
      .MRRBYG...
      .MRMMM....
      ..M.....Y.
      ..........`,
      legend,
    );
  });

  it('the skin applies last, by colour, to parts and final overrides alike', () => {
    const final: Override = {
      id: I.ovFinal,
      frameId: I.f0,
      target: 'final',
      anchor: { x: 8, y: 4 },
      set: I.imgRed,
      baseHash: PLACEHOLDER,
    };
    const store = makeStore({ leg: false, overrides: [final] });
    expectAscii(
      renderFrame(store, A, 0, { rig: createRigRenderer(), skin: { name: 'green' } }).toRGBA(),
      `
      ..........
      ..........
      ..GGB.....
      ..G.......
      ........G.
      ..........`,
      legend,
    );
  });

  it('pixel layers interleave with the rig block; the layers filter reaches the part pipeline', () => {
    const store = makeStore({
      layers: [
        layer(I.layBg, 'pixel', {
          cels: { [I.f0]: { imageId: I.imgBg, offset: { x: 0, y: 2 }, opacity: 255 } },
        }),
        layer(I.layArm, 'part'),
        layer(I.layLeg, 'part'),
      ],
    });
    const rig = createRigRenderer();
    expectAscii(
      renderFrame(store, A, 0, { rig }).toRGBA(),
      `
      ..........
      .......B..
      WWRRBWWBWW
      WWRWWWWGWW
      ..........
      ..........`,
      legend,
    );
    expectAscii(
      renderFrame(store, A, 0, { rig, layers: [I.layLeg] }).toRGBA(),
      `
      ..........
      .......B..
      .......B..
      .......G..
      ..........
      ..........`,
      legend,
    );
  });

  it('reuses rotations across frames and renders through the frame memo', () => {
    const store = makeStore({ bones: { [I.boneArm]: { angle: 30 } } });
    const rig = createRigRenderer();
    const memo = createFrameRenderer();
    memo(store, A, 0, { rig });
    memo(store, A, 1, { rig });
    const before = { ...rig.cache.stats };
    renderFrame(store, A, 0, { rig });
    expect(rig.cache.stats.hits).toBe(before.hits + 2);
    expect(rig.cache.stats.misses).toBe(before.misses);
    memo(store, A, 0, { rig });
    expect(memo.stats).toEqual({ hits: 1, misses: 2 });
  });

  it('no rig in the document: part layers stay empty; rig and image errors become CoreErrors', () => {
    expectAscii(
      renderFrame(makeStore({ rig: false }), A, 0, { rig: createRigRenderer() }).toRGBA(),
      '..........\n..........\n..........\n..........\n..........\n..........',
      legend,
    );
    const bad = makeStore({ parts: { [I.partArm]: { variant: I.varLeg } } });
    let err: unknown;
    try {
      renderFrame(bad, A, 0, { rig: createRigRenderer() });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CoreError);
    expect((err as CoreError).details).toMatchObject({
      reason: 'BAD_RIG',
      rigCode: 'UNKNOWN_VARIANT',
    });
    const store = makeStore();
    store.transact('drop', (tx) => {
      tx.deleteImage(I.imgLeg);
    });
    expect(() => renderFrame(store, A, 0, { rig: createRigRenderer() })).toThrow(
      expect.objectContaining({ code: 'IMAGE_MISSING' }) as Error,
    );
  });

  it('raster refusals become BAD_RIG too', () => {
    const store = makeStore({ leg: false });
    store.transact('huge', (tx) => {
      tx.update((d) => {
        const v = d.rig?.parts[0]?.variants[0];
        if (v !== undefined) v.pivot = { x: 70000, y: 0 }; // the padded image exceeds MAX_DIMENSION
      });
    });
    expect(() => renderFrame(store, A, 0, { rig: createRigRenderer() })).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'BAD_RIG' }) as unknown,
      }) as Error,
    );
  });
});

describe('checkOverrides / rebaseOverrides / discardOverrides', () => {
  const finalAt = (anchor: { x: number; y: number }, id = I.ovFinal): Override => ({
    id,
    frameId: I.f0,
    target: 'final',
    anchor,
    set: I.imgDot,
    baseHash: PLACEHOLDER,
  });

  it('final overrides are hashed over the composite before step 7: stale only when it changes under them', () => {
    const near = finalAt({ x: 5, y: 3 });
    const far = finalAt({ x: 0, y: 5 }, I.ovMirror);
    const store = makeStore({ leg: false, overrides: [near, far] });
    expect(checkOverrides(store).map((s) => s.stale)).toEqual([true, true]); // placeholders
    rebaseAll(store);
    expect(checkOverrides(store).map((s) => s.stale)).toEqual([false, false]);
    pose(store, { [I.boneArm]: { offset: { x: 1, y: 0 } } }); // the arm now reaches into (4..6, 2..4)
    expect(checkOverrides(store).map((s) => [s.stale, s.reason])).toEqual([
      [true, 'hash'],
      [false, undefined],
    ]);
  });

  it('final overrides use the export render by default, or the given render options', () => {
    const fx = layer(I.layFx, 'pixel', {
      export: false,
      cels: { [I.f0]: { imageId: I.imgRed, offset: { x: 1, y: 5 }, opacity: 255 } },
    });
    const store = makeStore({
      leg: false,
      overrides: [finalAt({ x: 0, y: 5 })],
      layers: [layer(I.layArm, 'part'), fx],
    });
    rebaseAll(store);
    expect(checkOverrides(store)[0]?.stale).toBe(false);
    expect(checkOverrides(store, { render: { exportOnly: false } })[0]?.stale).toBe(true);
  });

  it("a mirror's own final overrides are checked against the flipped render; its part overrides are not listed (T3.6)", () => {
    const mirrorPart: Override = { ...partOv(I.ovMirrorPart, 'arm', { x: 0, y: 0 }) };
    const store = makeStore({
      leg: false,
      mirror: [finalAt({ x: 6, y: 2 }, I.ovMirror), mirrorPart],
    });
    rebaseAll(store);
    const s = checkOverrides(store, { animations: [M] });
    expect(s.map((x) => [x.overrideId, x.mirror, x.stale])).toEqual([[I.ovMirror, true, false]]);
    // the source arm at (2..4, 2) flips to (6..8, 2) about origin.x = 5
    pose(store, { [I.boneArm]: { angle: 90 } });
    expect(checkOverrides(store, { animations: [M] })[0]?.stale).toBe(true);
    expect(() => {
      store.transact('x', (tx) => {
        rebaseOverrides(tx, [I.ovMirrorPart]);
      });
    }).toThrow(expect.objectContaining({ details: { reason: 'mirror-part-override' } }) as Error);
  });

  it('an override whose part is hidden, or whose frame is gone, is stale with no-target and cannot be re-based', () => {
    const store = makeStore({ overrides: W4_OVERRIDES() });
    rebaseAll(store);
    pose(store, {}, { [I.partLeg]: { visible: false } });
    const leg = checkOverrides(store).find((s) => s.overrideId === I.ovLeg);
    expect(leg).toMatchObject({ stale: true, reason: 'no-target' });
    expect(leg?.currentHash).toBeUndefined();
    expect(() => {
      store.transact('x', (tx) => {
        rebaseOverrides(tx, [I.ovLeg]);
      });
    }).toThrow(expect.objectContaining({ details: { reason: 'no-target' } }) as Error);
    const gone = makeStore({
      overrides: [{ ...finalAt({ x: 0, y: 0 }), frameId: I.layBg as never }],
    });
    expect(checkOverrides(gone)[0]).toMatchObject({ stale: true, reason: 'no-target' });
  });

  it('rebase makes a stale override valid in one undoable transaction; unknown ids are refused', () => {
    const store = makeStore({ overrides: W4_OVERRIDES() });
    rebaseAll(store);
    pose(store, { [I.boneArm]: { angle: 90 } });
    expect(staleById(store)[I.ovArm]).toBe(true);
    store.transact('rebase arm', (tx) => {
      rebaseOverrides(tx, [I.ovArm]);
    });
    expect(staleById(store)).toEqual({ [I.ovArm]: false, [I.ovLeg]: false });
    store.undo();
    expect(staleById(store)[I.ovArm]).toBe(true);
    expect(() => {
      store.transact('x', (tx) => {
        rebaseOverrides(tx, [I.ovFinal]);
      });
    }).toThrow(expect.objectContaining({ details: { reason: 'unknown-override' } }) as Error);
  });

  it('discard removes overrides, deletes images nothing references any more, and undoes', () => {
    const final: Override = { ...finalAt({ x: 0, y: 0 }), set: I.imgFinal };
    const store = makeStore({ overrides: [...W4_OVERRIDES(), final] });
    store.transact('discard', (tx) => {
      discardOverrides(tx, [I.ovArm, I.ovFinal]);
    });
    const anim = store.doc.animations[0];
    expect(anim?.overrides.map((o) => o.id)).toEqual([I.ovLeg]);
    expect(store.image(I.imgFinal)).toBeUndefined(); // only the final override used it
    expect(store.image(I.imgDot)).toBeDefined(); // the leg override still uses it
    store.undo();
    expect(store.doc.animations[0]?.overrides).toHaveLength(3);
    expect(store.image(I.imgFinal)).toBeDefined();
    expect(() => {
      store.transact('x', (tx) => {
        discardOverrides(tx, [I.ovMirror]);
      });
    }).toThrow(expect.objectContaining({ details: { reason: 'unknown-override' } }) as Error);
  });

  it('indexed documents hash part renders through the base palette', () => {
    const store = makeStore({ leg: false, overrides: [partOv(I.ovArm, 'arm', { x: 3, y: 0 })] });
    store.transact('indexed', (tx) => {
      tx.update((d) => {
        d.meta.colorMode = 'indexed';
      });
      tx.deleteImage(I.imgArm);
      tx.deleteImage(I.imgDot);
    });
    const store2 = new DocumentStore(store.doc, {
      images: [
        [I.imgArm, IndexedImage.fromIndices(3, 2, Uint8Array.from([1, 1, 3, 1, 0, 0]), 0)],
        [I.imgDot, IndexedImage.fromIndices(1, 1, Uint8Array.from([4]), 0)],
        [I.imgArm2, need(store.image(I.imgArm2))],
        [I.imgLeg, need(store.image(I.imgLeg))],
      ],
    });
    rebaseAll(store2);
    expect(checkOverrides(store2)[0]?.stale).toBe(false);
    expectAscii(
      renderFrame(store2, A, 0, { rig: createRigRenderer() }).toRGBA(),
      '..........\n..........\n..RRBY....\n..R.......\n..........\n..........',
      legend,
    );
  });
});

describe('renderInputKey: the inputs of the part pipeline (T3.3)', () => {
  const key = (s: DocumentStore): string => renderInputKey(s, A, 0, { rig: createRigRenderer() });
  const edit = (s: DocumentStore, fn: (d: Document) => void): DocumentStore => {
    s.transact('edit', (tx) => {
      tx.update(fn);
    });
    return s;
  };
  const authored = (d: Document): AuthoredAnimation => d.animations[0] as AuthoredAnimation;

  it('changes with variant pixels, the keys of any frame, and the part overrides of this frame', () => {
    const k0 = key(makeStore({ overrides: W4_OVERRIDES() }));
    const pixels = makeStore({ overrides: W4_OVERRIDES() });
    pixels.transact('px', (tx) => {
      tx.writeImage(I.imgLeg, (i) => (i as TiledImage).set(0, 0, [1, 2, 3, 255]));
    });
    expect(key(pixels)).not.toBe(k0);
    const otherFrame = edit(makeStore({ overrides: W4_OVERRIDES() }), (d) => {
      const f1 = authored(d).frames[1];
      if (f1 !== undefined) f1.boneKeys = { [I.boneArm]: { angle: 10 } };
    });
    expect(key(otherFrame)).not.toBe(k0); // interpolation reads the neighbouring keys
    const moved = edit(makeStore({ overrides: W4_OVERRIDES() }), (d) => {
      const o = authored(d).overrides[0];
      if (o !== undefined) o.anchor = { x: 4, y: 0 };
    });
    expect(key(moved)).not.toBe(k0);
  });

  it("ignores durations, baseHash, images nothing draws and other frames' part overrides", () => {
    const k0 = key(makeStore({ overrides: W4_OVERRIDES() }));
    const s = edit(makeStore({ overrides: W4_OVERRIDES() }), (d) => {
      const a = authored(d);
      const f0 = a.frames[0];
      if (f0 !== undefined) f0.durationMs = 250;
      const o = a.overrides[0];
      if (o !== undefined) o.baseHash = 'a'.repeat(64);
      a.overrides.push({ ...partOv(I.ovMirror, 'arm', { x: 0, y: 0 }), frameId: I.f1 });
    });
    s.transact('px', (tx) => {
      tx.writeImage(I.imgBg, (i) => (i as TiledImage).set(0, 0, [1, 2, 3, 255]));
    });
    expect(key(s)).toBe(k0);
  });
});

describe('renderInputKey: part overrides and the renderer identity (review fixes 1 and 2)', () => {
  const ov = (id: Override['id'], imgs: { set?: ImageId; erase?: ImageId }): Override => ({
    id,
    frameId: I.f0,
    target: { partId: I.partArm },
    anchor: { x: 3, y: 0 },
    ...imgs,
    baseHash: PLACEHOLDER,
  });
  const key = (s: DocumentStore, rig: RigRenderer = createRigRenderer()): string =>
    renderInputKey(s, A, 0, { rig });

  it('describes each part override like a final one: set versus erase, and which image goes where', () => {
    const setA = key(makeStore({ overrides: [ov(I.ovArm, { set: I.imgDot })] }));
    const eraseA = key(makeStore({ overrides: [ov(I.ovArm, { erase: I.imgDot })] }));
    expect(eraseA).not.toBe(setA);
    const ab = key(
      makeStore({ overrides: [ov(I.ovArm, { set: I.imgDot }), ov(I.ovLeg, { set: I.imgRed })] }),
    );
    const ba = key(
      makeStore({ overrides: [ov(I.ovArm, { set: I.imgRed }), ov(I.ovLeg, { set: I.imgDot })] }),
    );
    expect(ba).not.toBe(ab); // the same two images, swapped between the overrides
  });

  it('narrows the rig part only for a renderer that gives a renderKey', () => {
    const rig = createRigRenderer();
    expect(rig.renderKey).toBe(PART_RENDER_KEY);
    const unkeyed: RigRenderer = { renderParts: (ctx) => rig.renderParts(ctx) };
    const other: RigRenderer = { renderKey: 'other', renderParts: (ctx) => rig.renderParts(ctx) };
    const s = makeStore();
    const keyed0 = key(s, rig);
    const unkeyed0 = key(s, unkeyed);
    expect(key(s, other)).not.toBe(keyed0); // a different renderer, a different key
    s.transact('unrelated image', (tx) => {
      tx.writeImage(I.imgBg, (i) => (i as TiledImage).set(0, 0, [1, 2, 3, 255]));
    });
    expect(key(s, rig)).toBe(keyed0); // createRigRenderer: unused images are not inputs
    expect(key(s, unkeyed)).not.toBe(unkeyed0); // an unknown renderer: every image is
  });
});

describe('checkOverrides: render errors are reported per override (review fix 3)', () => {
  const finalAt = (id: Override['id']): Override => ({
    id,
    frameId: I.f0,
    target: 'final',
    anchor: { x: 0, y: 5 },
    set: I.imgDot,
    baseHash: PLACEHOLDER,
  });

  it('lists the others when one animation cannot be rendered', () => {
    const store = makeStore({
      overrides: [partOv(I.ovArm, 'arm', { x: 3, y: 0 }), finalAt(I.ovFinal)],
    });
    // a second animation of the same rig whose direction has no view
    store.transact('second animation', (tx) => {
      tx.update((d) => {
        const a = d.animations[0] as AuthoredAnimation;
        d.animations.push({
          ...a,
          id: I.mirror,
          group: 'other',
          direction: 'up',
          overrides: [partOv(I.ovLeg, 'leg', { x: 1, y: 1 }), finalAt(I.ovMirror)],
        });
      });
    });
    const all = checkOverrides(store);
    expect(all.map((s) => [s.overrideId, s.stale, s.reason, s.errorCode])).toEqual([
      [I.ovArm, true, 'hash', undefined], // the placeholder hash, but rendered fine
      [I.ovFinal, true, 'hash', undefined],
      [I.ovLeg, true, 'error', 'BAD_VALUE'],
      [I.ovMirror, true, 'error', 'BAD_VALUE'],
    ]);
    const bad = all[2];
    expect(bad?.errorMessage).toMatch(/up/);
    expect(bad?.currentHash).toBeUndefined();
    expect(bad?.baseHash).toBe(PLACEHOLDER);
    expect(listStaleOverrides(store).map((s) => s.overrideId)).toEqual([
      I.ovArm,
      I.ovFinal,
      I.ovLeg,
      I.ovMirror,
    ]);
    // after re-basing the good animation, only the broken one is listed
    store.transact('rebase', (tx) => {
      rebaseOverrides(tx, [I.ovArm, I.ovFinal]);
    });
    expect(listStaleOverrides(store).map((s) => [s.overrideId, s.reason])).toEqual([
      [I.ovLeg, 'error'],
      [I.ovMirror, 'error'],
    ]);
  });
});

describe('checkOverrides: the parts of a frame are rendered once (review fix 7)', () => {
  it('a frame with part and final overrides asks the rig for its parts one time', () => {
    const store = makeStore({
      overrides: [
        partOv(I.ovArm, 'arm', { x: 3, y: 0 }),
        partOv(I.ovLeg, 'leg', { x: 1, y: 1 }),
        {
          id: I.ovFinal,
          frameId: I.f0,
          target: 'final',
          anchor: { x: 0, y: 5 },
          set: I.imgDot,
          baseHash: PLACEHOLDER,
        },
      ],
    });
    const real = createRigRenderer();
    const calls = { parts: 0, frameParts: 0 };
    const spy: PartRenderer = {
      ...real,
      renderParts: (ctx) => {
        calls.parts++;
        return real.renderParts(ctx);
      },
      frameParts: (...args) => {
        calls.frameParts++;
        return real.frameParts(...args);
      },
    };
    const spied = checkOverrides(store, { rig: spy });
    expect(calls).toEqual({ parts: 0, frameParts: 1 });
    expect(spied).toEqual(checkOverrides(store, { rig: createRigRenderer() }));
  });
});

describe('discardOverrides refuses a mirror part override like rebaseOverrides (review fix 10)', () => {
  it('names the mirror-part-override reason, and changes nothing', () => {
    const mirrorPart = partOv(I.ovMirrorPart, 'arm', { x: 0, y: 0 });
    const store = makeStore({ overrides: W4_OVERRIDES(), mirror: [mirrorPart] });
    expect(() => {
      store.transact('x', (tx) => {
        discardOverrides(tx, [I.ovArm, I.ovMirrorPart]);
      });
    }).toThrow(expect.objectContaining({ details: { reason: 'mirror-part-override' } }) as Error);
    expect(store.doc.animations[0]?.overrides).toHaveLength(2);
    expect(store.doc.animations[1]?.overrides).toHaveLength(1);
  });
});
