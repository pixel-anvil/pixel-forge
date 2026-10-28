import { TiledImage } from '@pixel-forge/raster';
import { humanoidBack, humanoidFront, humanoidSide, snapSkeleton } from '@pixel-forge/rig';
import { SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type { BoneId, Document, FrameId, ImageId, LayerId } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import {
  CoreError,
  DocumentStore,
  addBone,
  addView,
  applySkeletonTemplate,
  bindParts,
  deleteBone,
  deleteView,
  documentHash,
  renameBone,
  renameView,
  reparentBone,
  setBoneLength,
  setPartZ,
  setPivot,
  setRestPose,
  validate,
} from '../src/index.js';
import type { StoredImage, Transaction } from '../src/index.js';

const gen = createIdGenerator({ seed: 5, next: 0 });
const D = {
  doc: gen.next('doc'),
  pal: gen.next('palette'),
  anim: gen.next('animation'),
  f0: gen.next('frame'),
  f1: gen.next('frame'),
};
const ORIGIN = { x: 20, y: 48 };

interface Art {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** extra frame cel with another image (animated) */
  animated?: boolean;
  empty?: boolean;
}

/** A document with no rig and the given pixel layers, each a filled rectangle. */
function makeStore(arts: Art[]): { store: DocumentStore; ids: Record<string, LayerId> } {
  const g = createIdGenerator({ seed: 9, next: 0 });
  const images: [ImageId, StoredImage][] = [];
  const ids: Record<string, LayerId> = {};
  const layers: Document['layers'] = [];
  for (const a of arts) {
    const id = g.next('layer');
    ids[a.name] = id;
    const cels: Record<string, unknown> = {};
    if (!a.empty) {
      const img = new TiledImage(a.w, a.h);
      for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) img.set(x, y, [200, 0, 0, 255]);
      const iid = g.next('image');
      images.push([iid, img]);
      cels[D.f0] = { imageId: iid, offset: { x: a.x, y: a.y }, opacity: 255 };
      if (a.animated) {
        const img2 = new TiledImage(a.w, a.h);
        img2.set(0, 0, [1, 2, 3, 255]);
        const iid2 = g.next('image');
        images.push([iid2, img2]);
        cels[D.f1] = { imageId: iid2, offset: { x: a.x, y: a.y }, opacity: 255 };
      }
    }
    layers.push({
      kind: 'pixel',
      id,
      name: a.name,
      visible: true,
      opacity: 255,
      export: true,
      cels,
    } as Document['layers'][number]);
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
      id: D.doc,
      name: 'rig',
      schemaVersion: SCHEMA_VERSION,
      canvas: { w: 40, h: 50 },
      origin: ORIGIN,
      pixelsPerUnit: 16,
      colorMode: 'rgba',
      paletteLocked: false,
      ids: { ...g.state(), seed: g.state().seed },
    },
    palettes: [{ id: D.pal, name: 'Base', colors: [[0, 0, 0, 0]], ramps: [] }],
    activePaletteId: D.pal,
    skins: [],
    layers,
    animations: [
      {
        id: D.anim,
        group: 'idle',
        loop: 'loop',
        frames: [frame(D.f0), frame(D.f1)],
        overrides: [],
      },
    ],
    directionFallback: {},
    markerDefs: [],
    eventDefs: [],
  };
  return { store: new DocumentStore(doc, { images }), ids };
}

/** The bone id for a name, or a test failure. */
function bn(bones: Readonly<Record<string, BoneId | undefined>>, name: string): BoneId {
  const id = bones[name];
  if (id === undefined) throw new Error(`no bone ${name}`);
  return id;
}

const errors = (s: DocumentStore) => validate(s).filter((f) => f.severity === 'error');

function reason(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof CoreError && e.code === 'BAD_ARGUMENT') return String(e.details?.reason);
    return 'other';
  }
  return undefined;
}

/** Runs one op in a transaction; checks validity, undo (hash) and redo. */
function op<R>(s: DocumentStore, label: string, fn: (tx: Transaction) => R): R {
  const before = documentHash(s);
  const r = s.transact(label, fn);
  expect(errors(s)).toEqual([]);
  const after = documentHash(s);
  expect(after).not.toBe(before);
  s.undo();
  expect(documentHash(s)).toBe(before);
  s.redo();
  expect(documentHash(s)).toBe(after);
  return r;
}

const front = () => humanoidFront({ height: 48, origin: ORIGIN });
const side = () => humanoidSide({ height: 48, origin: ORIGIN });

describe('applySkeletonTemplate', () => {
  it('creates 17 bones and a view, valid and undoable', () => {
    const { store } = makeStore([]);
    const r = op<ReturnType<typeof applySkeletonTemplate>>(store, 'Template', (tx) =>
      applySkeletonTemplate(tx, side()),
    );
    expect(r.created).toHaveLength(17);
    expect(store.doc.rig?.bones.map((b) => b.name)).toContain('upper_arm_l');
    expect(store.doc.rig?.views[0]?.name).toBe('side');
    expect(store.doc.rig?.views[0]?.rest[bn(r.bones, 'root')]).toEqual({
      x: 20,
      y: 48,
      angle: 0,
    });
  });

  it('reuses bones by name for a second view and checks conflicts', () => {
    const { store } = makeStore([]);
    store.transact('a', (tx) => applySkeletonTemplate(tx, side()));
    const r = op<ReturnType<typeof applySkeletonTemplate>>(store, 'b', (tx) =>
      applySkeletonTemplate(tx, front()),
    );
    expect(r.created).toEqual([]);
    expect(store.doc.rig?.bones).toHaveLength(17);
    expect(store.doc.rig?.views).toHaveLength(2);
    expect(reason(() => store.transact('x', (tx) => applySkeletonTemplate(tx, front())))).toBe(
      'name-taken',
    );
    expect(
      reason(() =>
        store.transact('x', (tx) =>
          applySkeletonTemplate(tx, humanoidBack(), { viewName: 'front' }),
        ),
      ),
    ).toBe('name-taken');
    const back = op<ReturnType<typeof applySkeletonTemplate>>(store, 'c', (tx) =>
      applySkeletonTemplate(tx, humanoidBack({ origin: ORIGIN })),
    );
    expect(back.viewId).toBeDefined();
    // into an existing view: overwrite rest
    const vid = store.doc.rig?.views[0]?.id;
    if (vid === undefined) throw new Error('view');
    op(store, 'd', (tx) =>
      applySkeletonTemplate(tx, humanoidSide({ origin: { x: 10, y: 40 } }), { viewId: vid }),
    );
    expect(
      reason(() =>
        store.transact('x', (tx) =>
          applySkeletonTemplate(tx, side(), { viewId: 'view_zz' as never }),
        ),
      ),
    ).toBe('unknown-view');
  });

  it('refuses a direction already drawn, and a bone whose parent differs', () => {
    const { store } = makeStore([]);
    store.transact('a', (tx) => applySkeletonTemplate(tx, side()));
    expect(
      reason(() =>
        store.transact('x', (tx) => applySkeletonTemplate(tx, side(), { viewName: 'side2' })),
      ),
    ).toBe('direction-taken');
    const rootId = bn(
      Object.fromEntries((store.doc.rig?.bones ?? []).map((b) => [b.name, b.id])),
      'root',
    );
    store.transact('r', (tx) => {
      reparentBone(
        tx,
        bn(Object.fromEntries((store.doc.rig?.bones ?? []).map((b) => [b.name, b.id])), 'head'),
        rootId,
      );
    });
    expect(reason(() => store.transact('x', (tx) => applySkeletonTemplate(tx, front())))).toBe(
      'bone-mismatch',
    );
  });
});

describe('bone and view CRUD', () => {
  const setup = () => {
    const { store, ids } = makeStore([]);
    const t = store.transact('t', (tx) => applySkeletonTemplate(tx, side()));
    return { store, ids, t, id: (n: string) => bn(t.bones, n) };
  };

  it('addBone / renameBone / setBoneLength / setRestPose', () => {
    const { store, t, id } = setup();
    const b = op<BoneId>(store, 'add', (tx) =>
      addBone(
        tx,
        { name: 'tail', parentId: id('pelvis'), length: 5 },
        { viewId: t.viewId, x: -2, y: 1, angle: 180 },
      ),
    );
    expect(store.doc.rig?.views[0]?.rest[b]).toEqual({ x: -2, y: 1, angle: 180 });
    op(store, 'add2', (tx) => addBone(tx, { name: 'free', length: 0 }));
    op(store, 'ren', (tx) => {
      renameBone(tx, b, 'tail2');
    });
    store.transact('same', (tx) => {
      renameBone(tx, b, 'tail2');
    }); // no-op, no throw
    op(store, 'len', (tx) => {
      setBoneLength(tx, b, 9);
    });
    op(store, 'rest', (tx) => {
      setRestPose(tx, t.viewId, b, { x: 1, y: 2, angle: 33.5 });
    });
    expect(store.doc.rig?.bones.find((x) => x.id === b)?.length).toBe(9);

    expect(
      reason(() => store.transact('x', (tx) => addBone(tx, { name: 'head', length: 1 }))),
    ).toBe('name-taken');
    expect(
      reason(() => store.transact('x', (tx) => addBone(tx, { name: 'Bad Name', length: 1 }))),
    ).toBe('bad-name');
    expect(reason(() => store.transact('x', (tx) => addBone(tx, { name: 'z', length: -1 })))).toBe(
      'bad-value',
    );
    expect(reason(() => store.transact('x', (tx) => addBone(tx, { name: 'z', length: 1.5 })))).toBe(
      'bad-value',
    );
    expect(
      reason(() =>
        store.transact('x', (tx) =>
          addBone(tx, { name: 'z', length: 1, parentId: 'bon_zzzz' as never }),
        ),
      ),
    ).toBe('unknown-bone');
    expect(
      reason(() =>
        store.transact('x', (tx) =>
          addBone(tx, { name: 'z', length: 1 }, { viewId: 'v' as never, x: 0, y: 0, angle: 0 }),
        ),
      ),
    ).toBe('unknown-view');
    expect(
      reason(() =>
        store.transact('x', (tx) =>
          addBone(tx, { name: 'z', length: 1 }, { viewId: t.viewId, x: 0.5, y: 0, angle: 0 }),
        ),
      ),
    ).toBe('bad-value');
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          renameBone(tx, b, 'head');
        });
      }),
    ).toBe('name-taken');
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          renameBone(tx, b, 'A');
        });
      }),
    ).toBe('bad-name');
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          renameBone(tx, 'bon_nope' as never, 'q');
        });
      }),
    ).toBe('unknown-bone');
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          setBoneLength(tx, b, -1);
        });
      }),
    ).toBe('bad-value');
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          setRestPose(tx, t.viewId, b, { x: 0, y: 0, angle: Number.NaN });
        });
      }),
    ).toBe('bad-value');
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          setRestPose(tx, 'v' as never, b, { x: 0, y: 0, angle: 0 });
        });
      }),
    ).toBe('unknown-view');
  });

  it('reparentBone refuses cycles and keeps canvas pivots and world directions', () => {
    const { store, t, id } = setup();
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          reparentBone(tx, id('torso'), id('head'));
        });
      }),
    ).toBe('cycle');
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          reparentBone(tx, id('torso'), id('torso'));
        });
      }),
    ).toBe('cycle');
    const pivots = () => {
      const rig = store.doc.rig;
      if (rig === undefined) throw new Error('rig');
      const view = rig.views.find((v) => v.id === t.viewId);
      if (view === undefined) throw new Error('view');
      const sk = snapSkeleton(rig, view, new Map());
      return [...sk.bones.entries()]
        .map(([k, b]) => [k, b.pivot.x, b.pivot.y, b.restAngle])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    };
    const before = pivots();
    op(store, 'reparent', (tx) => {
      reparentBone(tx, id('head'), id('torso'));
    });
    expect(pivots()).toEqual(before);
    op(store, 'to root', (tx) => {
      reparentBone(tx, id('hand_l'), undefined);
    });
    expect(pivots()).toEqual(before);
    expect(store.doc.rig?.bones.find((b) => b.id === id('hand_l'))?.parentId).toBeUndefined();
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          reparentBone(tx, 'bon_nope' as never, undefined);
        });
      }),
    ).toBe('unknown-bone');
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          reparentBone(tx, id('head'), 'bon_nope' as never);
        });
      }),
    ).toBe('unknown-bone');
  });

  it('deleteBone refuses children and parts; cascade removes subtree, rest and keys', () => {
    const { store, id } = setup();
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          deleteBone(tx, id('upper_arm_r'));
        });
      }),
    ).toBe('has-children');
    store.transact('key', (tx) => {
      tx.update((d) => {
        const a = d.animations[0];
        if (a !== undefined && 'frames' in a) {
          const f = a.frames[0];
          if (f !== undefined) f.boneKeys[id('hand_r')] = { angle: 10 };
        }
      });
    });
    expect(errors(store)).toEqual([]);
    op(store, 'cascade', (tx) => {
      deleteBone(tx, id('upper_arm_r'), { cascade: true });
    });
    expect(store.doc.rig?.bones).toHaveLength(14);
    op(store, 'leaf', (tx) => {
      deleteBone(tx, id('hand_l'));
    });
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          deleteBone(tx, 'bon_no' as never);
        });
      }),
    ).toBe('unknown-bone');
  });

  it('deleteBone refuses a bone with parts', () => {
    const { store, id } = (() => {
      const m = makeStore([{ name: 'head', x: 18, y: 2, w: 4, h: 8 }]);
      const t = m.store.transact('t', (tx) => applySkeletonTemplate(tx, side()));
      return { store: m.store, id: (n: string) => bn(t.bones, n) };
    })();
    store.transact('b', (tx) => bindParts(tx));
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          deleteBone(tx, id('head'));
        });
      }),
    ).toBe('has-parts');
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          deleteBone(tx, id('pelvis'), { cascade: true });
        });
      }),
    ).toBe('has-parts');
  });

  it('view CRUD', () => {
    const { store, t } = setup();
    const v = op<string>(store, 'view', (tx) => addView(tx, 'front', ['front', 'front_left']));
    op(store, 'ren', (tx) => {
      renameView(tx, v as never, 'fr');
    });
    store.transact('same', (tx) => {
      renameView(tx, v as never, 'fr');
    });
    op(store, 'del', (tx) => {
      deleteView(tx, v as never);
    });
    expect(reason(() => store.transact('x', (tx) => addView(tx, 'side', ['x'])))).toBe(
      'name-taken',
    );
    expect(reason(() => store.transact('x', (tx) => addView(tx, 'v2', ['side'])))).toBe(
      'direction-taken',
    );
    expect(reason(() => store.transact('x', (tx) => addView(tx, 'v2', [])))).toBe('bad-value');
    expect(reason(() => store.transact('x', (tx) => addView(tx, 'v2', ['a', 'a'])))).toBe(
      'bad-value',
    );
    expect(reason(() => store.transact('x', (tx) => addView(tx, 'v2', ['default'])))).toBe(
      'bad-name',
    );
    expect(reason(() => store.transact('x', (tx) => addView(tx, 'V2', ['a'])))).toBe('bad-name');
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          renameView(tx, t.viewId, 'Q');
        });
      }),
    ).toBe('bad-name');
    const w = store.transact('w', (tx) => addView(tx, 'other', ['o']));
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          renameView(tx, w, 'side');
        });
      }),
    ).toBe('name-taken');
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          deleteView(tx, 'view_no' as never);
        });
      }),
    ).toBe('unknown-view');
  });
});

describe('bindParts', () => {
  // Front view, origin (20, 48): torso pivot x 20; see template geometry.
  const arts: Art[] = [
    { name: 'torso', x: 18, y: 20, w: 5, h: 12 }, // by plain bone name
    { name: 'arm_l_art', x: 25, y: 20, w: 3, h: 6 },
    { name: 'blob', x: 5, y: 2, w: 2, h: 2 }, // far from everything
    { name: 'hand_art_open', x: 0, y: 0, w: 2, h: 2 },
    { name: 'hand_art_fist', x: 0, y: 0, w: 2, h: 2 },
    { name: 'multi', x: 0, y: 0, w: 2, h: 2, animated: true },
    { name: 'nothing', x: 0, y: 0, w: 0, h: 0, empty: true },
  ];
  const setup = () => {
    const { store, ids } = makeStore(arts);
    const t = store.transact('t', (tx) => applySkeletonTemplate(tx, front()));
    return { store, ids, t };
  };

  it('binds by name (plain, raw part: names, variants, views), converts layers in place', () => {
    const { store, ids, t } = setup();
    store.transact('s', (tx) => applySkeletonTemplate(tx, side()));
    const handPivot = store.doc.rig?.views.find((v) => v.id === t.viewId)?.rest[
      bn(t.bones, 'hand_l')
    ];
    expect(handPivot).toBeDefined();
    const r = op<ReturnType<typeof bindParts>>(store, 'bind', (tx) =>
      bindParts(tx, {
        byOverlap: false,
        viewId: t.viewId,
        rawNames: {
          [ids.hand_art_open as string]: 'part:hand_r@open#front',
          [ids.hand_art_fist as string]: 'part:hand_r@fist#front',
          [ids.multi as string]: 'part:hand_r#nope',
          [ids.nothing as string]: 'part:hand_r#side',
          [ids.arm_l_art as string]: 'part:ghost',
        },
        zByBone: { hand_r: 7 },
      }),
    );
    expect(r.bound.map((b) => [b.how, b.merged])).toEqual([
      ['name', false], // torso
      ['name', false], // hand_r open (new part)
      ['name', true], // hand_r fist (folded in)
    ]);
    const skipReasons = Object.fromEntries(r.skipped.map((s) => [s.layerId, s.reason]));
    expect(skipReasons[ids.arm_l_art as string]).toBe('unknown-bone');
    expect(skipReasons[ids.multi as string]).toBe('unknown-view');
    expect(skipReasons[ids.nothing as string]).toBe('empty');
    const rig = store.doc.rig;
    const hand = rig?.parts.find((p) => p.boneId === t.bones.hand_r);
    expect(hand?.variants.map((v) => v.name)).toEqual(['open', 'fist']);
    expect(store.doc.layers.find((l) => l.id === hand?.layerId)).toMatchObject({
      kind: 'part',
      name: 'hand_r',
    });
    expect(store.doc.layers.some((l) => l.id === ids.hand_art_fist)).toBe(false);
    expect(rig?.views.find((v) => v.id === t.viewId)?.defaultZ[hand?.id as never]).toBe(7);
    // the torso layer was a pixel layer named after its bone and became the part layer
    expect(rig?.parts.find((p) => p.boneId === t.bones.torso)?.layerId).toBe(ids.torso);
    // pivot = bone pivot - cel offset: the hand art at (0,0) with the hand pivot on the canvas
    const hp = hand?.variants[0]?.pivot;
    expect(hp).toBeDefined();
  });

  it('pivot puts the art where it was drawn', () => {
    const { store, ids, t } = setup();
    store.transact('bind', (tx) => bindParts(tx, { byOverlap: false }));
    const part = store.doc.rig?.parts.find((p) => p.layerId === ids.torso);
    const rig = store.doc.rig;
    const view = rig?.views[0];
    if (rig === undefined || view === undefined || part === undefined) throw new Error('rig');
    const torsoPivot = snapSkeleton(rig, view, new Map()).bones.get(bn(t.bones, 'torso'))?.pivot;
    expect(part.variants[0]?.pivot).toEqual({
      x: (torsoPivot?.x ?? 0) - 18,
      y: (torsoPivot?.y ?? 0) - 20,
    });
    expect(part.variants[0]?.name).toBe('default');
    expect(errors(store)).toEqual([]);
  });

  it('binds by overlap and reports ambiguity, no-overlap and animated layers', () => {
    const m = makeStore([
      { name: 'art1', x: 25, y: 20, w: 3, h: 6 }, // on the front-view upper_arm_l (shoulder x 26)
      { name: 'art2', x: 5, y: 2, w: 2, h: 2 }, // nowhere
      { name: 'art3', x: 0, y: 0, w: 2, h: 2, animated: true },
    ]);
    const t = m.store.transact('t', (tx) => applySkeletonTemplate(tx, front()));
    const r = op<ReturnType<typeof bindParts>>(m.store, 'bind', (tx) => bindParts(tx));
    expect(r.bound.map((b) => [b.layerId, b.boneId, b.how])).toEqual([
      [m.ids.art1, t.bones.lower_arm_l, 'overlap'],
    ]);
    expect(Object.fromEntries(r.skipped.map((s) => [s.layerId, s.reason]))).toEqual({
      [m.ids.art2 as string]: 'no-overlap',
      [m.ids.art3 as string]: 'animated',
    });
  });

  it('never guesses: side-view arms tie and come back as candidates', () => {
    const m = makeStore([{ name: 'art', x: 19, y: 22, w: 3, h: 6 }]);
    const t = m.store.transact('t', (tx) => applySkeletonTemplate(tx, side()));
    const before = documentHash(m.store);
    const r = m.store.transact('bind', (tx) => bindParts(tx));
    expect(r.bound).toEqual([]);
    expect(r.ambiguous).toHaveLength(1);
    const c = r.ambiguous[0]?.candidates ?? [];
    expect(c).toContain(t.bones.lower_arm_l);
    expect(c).toContain(t.bones.lower_arm_r);
    expect(m.store.doc.layers[0]?.kind).toBe('pixel');
    expect(documentHash(m.store)).toBe(before);
  });

  it('skips for no view, duplicate variants, bone not in view, taken names', () => {
    const m = makeStore([{ name: 'hand_r', x: 0, y: 0, w: 2, h: 2 }]);
    const none = m.store.transact('bind', (tx) => bindParts(tx));
    expect(none.skipped).toEqual([{ layerId: m.ids.hand_r, reason: 'no-view' }]);
    m.store.transact('bone', (tx) => addBone(tx, { name: 'hand_r', length: 2 }));
    expect(m.store.transact('b', (tx) => bindParts(tx)).skipped[0]?.reason).toBe('no-view');
    const v = m.store.transact('v', (tx) => addView(tx, 'main', ['main']));
    expect(m.store.transact('b', (tx) => bindParts(tx)).skipped[0]?.reason).toBe(
      'bone-not-in-view',
    );
    const boneId = m.store.doc.rig?.bones[0]?.id ?? ('' as BoneId);
    m.store.transact('rest', (tx) => {
      setRestPose(tx, v, boneId, { x: 3, y: 3, angle: 90 });
    });
    // overlap with no matching name: unnamed layers get no-view-free path
    const ok = op<ReturnType<typeof bindParts>>(m.store, 'b', (tx) => bindParts(tx));
    expect(ok.bound).toHaveLength(1);

    // duplicate variant: same bone/view/name twice
    const d = makeStore([
      { name: 'a', x: 0, y: 0, w: 2, h: 2 },
      { name: 'b', x: 0, y: 0, w: 2, h: 2 },
    ]);
    d.store.transact('t', (tx) => applySkeletonTemplate(tx, front()));
    const raw = { [d.ids.a as string]: 'part:hand_r', [d.ids.b as string]: 'part:hand_r' };
    const r1 = d.store.transact('b', (tx) => bindParts(tx, { rawNames: raw, byOverlap: false }));
    expect(r1.bound).toHaveLength(1);
    expect(r1.skipped[0]?.reason).toBe('duplicate-variant');

    // an existing part layer with the bone's name blocks a second part
    const n = makeStore([{ name: 'a', x: 0, y: 0, w: 2, h: 2 }]);
    n.store.transact('t', (tx) => applySkeletonTemplate(tx, front()));
    n.store.transact('x', (tx) => {
      tx.update((doc) => {
        doc.layers.push({
          kind: 'part',
          id: 'lay_zzzz' as never,
          name: 'hand_r',
          visible: true,
          opacity: 255,
          export: true,
        });
      });
    });
    const r2 = n.store.transact('b', (tx) =>
      bindParts(tx, { rawNames: { [n.ids.a as string]: 'part:hand_r' }, byOverlap: false }),
    );
    expect(r2.skipped[0]?.reason).toBe('name-taken');
  });

  it('skips a layer whose image is missing', () => {
    const m = makeStore([{ name: 'hand_r', x: 0, y: 0, w: 2, h: 2 }]);
    m.store.transact('t', (tx) => applySkeletonTemplate(tx, front()));
    m.store.transact('d', (tx) => {
      for (const id of tx.imageIds()) tx.deleteImage(id);
    });
    expect(m.store.transact('b', (tx) => bindParts(tx)).skipped[0]?.reason).toBe('image-missing');
    const o = makeStore([{ name: 'x1', x: 0, y: 0, w: 2, h: 2 }]);
    o.store.transact('t', (tx) => applySkeletonTemplate(tx, front()));
    o.store.transact('d', (tx) => {
      for (const id of tx.imageIds()) tx.deleteImage(id);
    });
    expect(o.store.transact('b', (tx) => bindParts(tx)).skipped[0]?.reason).toBe('image-missing');
    const e = makeStore([{ name: 'x1', x: 0, y: 0, w: 2, h: 2 }]);
    expect(e.store.transact('b', (tx) => bindParts(tx)).skipped[0]?.reason).toBe('no-view');
    expect(e.store.transact('b', (tx) => bindParts(tx, { layers: [] })).skipped).toEqual([]);
  });
});

describe('several parts per bone (R-15)', () => {
  const setup = () => {
    const m = makeStore([
      { name: 'arm', x: 25, y: 20, w: 3, h: 6 },
      { name: 'sleeve', x: 25, y: 20, w: 3, h: 3 },
      { name: 'sleeve_open', x: 25, y: 20, w: 3, h: 3 },
      { name: 'sleeve_dup', x: 25, y: 20, w: 3, h: 3 },
      { name: 'long', x: 25, y: 20, w: 3, h: 3 },
      { name: 'ovl', x: 25, y: 20, w: 3, h: 6 },
    ]);
    const t = m.store.transact('t', (tx) => applySkeletonTemplate(tx, front()));
    const ua = bn(t.bones, 'upper_arm_r');
    return { ...m, t, ua };
  };
  const raw = (ids: Record<string, LayerId>) => ({
    [ids.arm as string]: 'part:upper_arm_r',
    [ids.sleeve as string]: 'part:upper_arm_r.sleeve',
    [ids.sleeve_open as string]: 'part:upper_arm_r.sleeve@open',
    [ids.sleeve_dup as string]: 'part:upper_arm_r.sleeve@open',
    [ids.long as string]: `part:upper_arm_r.${'x'.repeat(40)}`,
  });

  it('binds an arm and a sleeve to one bone with their own z, idempotently', () => {
    const { store, ids, t, ua } = setup();
    const r = op<ReturnType<typeof bindParts>>(store, 'bind', (tx) =>
      bindParts(tx, {
        byOverlap: false,
        rawNames: raw(ids),
        zByBone: { upper_arm_r: 1, upper_arm_r_sleeve: 2 },
      }),
    );
    const parts = (store.doc.rig?.parts ?? []).filter((p) => p.boneId === ua);
    expect(parts).toHaveLength(2);
    const names = parts.map((p) => store.doc.layers.find((l) => l.id === p.layerId)?.name).sort();
    expect(names).toEqual(['upper_arm_r', 'upper_arm_r_sleeve']);
    const sleeve = parts.find((p) => p.layerId === ids.sleeve);
    const arm = parts.find((p) => p.layerId === ids.arm);
    expect(sleeve?.variants.map((v) => v.name)).toEqual(['default', 'open']);
    const z = store.doc.rig?.views[0]?.defaultZ ?? {};
    expect(z[sleeve?.id as never]).toBe(2);
    expect(z[arm?.id as never]).toBe(1);
    expect(Object.fromEntries(r.skipped.map((s) => [s.layerId, s.reason]))).toEqual({
      [ids.sleeve_dup as string]: 'duplicate-variant',
      [ids.long as string]: 'name-too-long',
    });
    // setPartZ per part
    op(store, 'z', (tx) => {
      setPartZ(tx, t.viewId, sleeve?.id as never, 9);
    });
    expect(store.doc.rig?.views[0]?.defaultZ[sleeve?.id as never]).toBe(9);
    expect(store.doc.rig?.views[0]?.defaultZ[arm?.id as never]).toBe(1);
    // re-binding changes nothing
    const h = documentHash(store);
    const again = store.transact('again', (tx) =>
      bindParts(tx, { byOverlap: false, rawNames: raw(ids) }),
    );
    expect(again.bound).toEqual([]);
    expect(documentHash(store)).toBe(h);
  });

  it('refuses a colliding part layer name, and overlap never adds to a bone with a part', () => {
    const { store, ids } = setup();
    store.transact('x', (tx) => {
      tx.update((d) => {
        d.layers.push({
          kind: 'part',
          id: 'lay_zzzz' as never,
          name: 'upper_arm_r_sleeve',
          visible: true,
          opacity: 255,
          export: true,
        });
      });
    });
    const r = store.transact('bind', (tx) =>
      bindParts(tx, {
        byOverlap: false,
        layers: [ids.sleeve ?? ('' as LayerId)],
        rawNames: raw(ids),
      }),
    );
    expect(r.skipped).toEqual([{ layerId: ids.sleeve, reason: 'name-taken' }]);
    // overlap: bone has no part yet -> main part; second overlap layer on the same bone -> bone-has-part
    const o = setup();
    const res = o.store.transact('bind', (tx) =>
      bindParts(tx, { layers: [o.ids.arm ?? ('' as LayerId), o.ids.ovl ?? ('' as LayerId)] }),
    );
    expect(res.bound).toHaveLength(1);
    expect(res.skipped.map((s) => s.reason)).toEqual(['bone-has-part']);
    expect(errors(o.store)).toEqual([]);
  });
});

describe('setPivot and setPartZ', () => {
  it('validates and edits', () => {
    const m = makeStore([{ name: 'torso', x: 18, y: 20, w: 5, h: 12 }]);
    const t = m.store.transact('t', (tx) => applySkeletonTemplate(tx, front()));
    m.store.transact('b', (tx) => bindParts(tx));
    const part = m.store.doc.rig?.parts[0];
    const variant = part?.variants[0];
    if (part === undefined || variant === undefined) throw new Error('part');
    op(m.store, 'pivot', (tx) => {
      setPivot(tx, part.id, variant.id, { x: 1, y: 1 });
    });
    op(m.store, 'outside', (tx) => {
      setPivot(tx, part.id, variant.id, { x: -4, y: 100 });
    });
    op(m.store, 'z', (tx) => {
      setPartZ(tx, t.viewId, part.id, 5);
    });
    const r = (f: () => void) =>
      reason(() => {
        m.store.transact('x', f);
      });
    expect(r(() => undefined)).toBeUndefined();
    expect(
      reason(() => {
        m.store.transact('x', (tx) => {
          setPivot(tx, 'p' as never, variant.id, { x: 0, y: 0 });
        });
      }),
    ).toBe('unknown-part');
    expect(
      reason(() => {
        m.store.transact('x', (tx) => {
          setPivot(tx, part.id, 'v' as never, { x: 0, y: 0 });
        });
      }),
    ).toBe('unknown-variant');
    expect(
      reason(() => {
        m.store.transact('x', (tx) => {
          setPivot(tx, part.id, variant.id, { x: 0.5, y: 0 });
        });
      }),
    ).toBe('bad-value');
    expect(
      reason(() => {
        m.store.transact('x', (tx) => {
          setPivot(tx, part.id, variant.id, { x: 2 ** 21, y: 0 });
        });
      }),
    ).toBe('bad-value');
    expect(
      reason(() => {
        m.store.transact('x', (tx) => {
          setPartZ(tx, t.viewId, 'p' as never, 1);
        });
      }),
    ).toBe('unknown-part');
    expect(
      reason(() => {
        m.store.transact('x', (tx) => {
          setPartZ(tx, 'v' as never, part.id, 1);
        });
      }),
    ).toBe('unknown-view');
    expect(
      reason(() => {
        m.store.transact('x', (tx) => {
          setPartZ(tx, t.viewId, part.id, 1.5);
        });
      }),
    ).toBe('bad-value');
  });
});
