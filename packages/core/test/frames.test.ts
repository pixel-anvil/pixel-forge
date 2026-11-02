import { Document } from '@pixel-forge/schema';
import type { FrameId } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import {
  CoreError,
  deleteFrame,
  documentHash,
  duplicateFrame,
  insertFrame,
  referencedImages,
  reorderFrames,
  resolveAnimation,
  resolveFrame,
  validate,
} from '../src/index.js';
import type { DocumentStore } from '../src/index.js';
import { F, richDoc, richStore } from './frames-fixture.js';
import { int, rng } from './helpers.js';

function reason(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof CoreError && e.code === 'BAD_ARGUMENT') return String(e.details?.reason);
    return 'other';
  }
  return undefined;
}

function run(store: DocumentStore) {
  const a = store.doc.animations[0];
  if (a === undefined || 'mirrorOf' in a) throw new Error('fixture');
  return a;
}
const frameIds = (store: DocumentStore) => run(store).frames.map((f) => f.id);
const bodyCels = (store: DocumentStore) => {
  const l = store.doc.layers[0];
  if (l?.kind !== 'pixel') throw new Error('fixture');
  return l.cels;
};
const clean = (store: DocumentStore) => {
  expect(validate(store).filter((f) => f.severity === 'error')).toEqual([]);
};

describe('fixture', () => {
  it('is schema-valid and validates without findings', () => {
    expect(Document.safeParse(richDoc()).success).toBe(true);
    expect(validate(richStore())).toEqual([]);
  });
});

describe('references', () => {
  it('resolves animations by id, by (group, direction) and rejects unknown ones', () => {
    const doc = richDoc();
    expect(resolveAnimation(doc, { id: F.idle })).toBe(2);
    expect(resolveAnimation(doc, { group: 'run', direction: 'left' })).toBe(1);
    expect(resolveAnimation(doc, { group: 'idle' })).toBe(2);
    expect(reason(() => resolveAnimation(doc, { group: 'idle', direction: 'side' }))).toBe(
      'unknown-animation',
    );
  });
  it('resolves frames by index and id and rejects unknown ones', () => {
    const a = { frames: [{ id: F.f0 }, { id: F.f1 }] };
    expect(resolveFrame(a, 1)).toBe(1);
    expect(resolveFrame(a, F.f0)).toBe(0);
    expect(reason(() => resolveFrame(a, 2))).toBe('unknown-frame');
    expect(reason(() => resolveFrame(a, -1))).toBe('unknown-frame');
    expect(reason(() => resolveFrame(a, 0.5))).toBe('unknown-frame');
    expect(reason(() => resolveFrame(a, F.g0))).toBe('unknown-frame');
  });
});

describe('insertFrame (spec 3.2: new id, no keys, no cels, no overrides)', () => {
  it('inserts after, with a new id, empty content and the reference duration', () => {
    const store = richStore();
    let id!: FrameId;
    store.transact('Insert', (tx) => {
      id = insertFrame(tx, { id: F.run }, F.f1, { position: 'after' });
    });
    expect(frameIds(store)).toEqual([F.f0, F.f1, id, F.f2]);
    expect(run(store).frames[2]).toEqual({
      id,
      durationMs: 120,
      markers: {},
      events: [],
      rootMotion: { dx: 0, dy: 0 },
      boneKeys: {},
      partKeys: {},
    });
    expect([F.f0, F.f1, F.f2, F.g0]).not.toContain(id);
    // no cels, no overrides for the new frame
    expect(Object.keys(bodyCels(store))).not.toContain(id);
    expect(store.doc.animations.flatMap((a) => a.overrides.map((o) => o.frameId))).not.toContain(
      id,
    );
    expect(store.doc.meta.ids.next).toBe(richDoc().meta.ids.next + 1);
    clean(store);
  });

  it('inserts before an index, with an explicit duration, addressing the animation by group', () => {
    const store = richStore();
    let id!: FrameId;
    store.transact('Insert', (tx) => {
      id = insertFrame(tx, { group: 'run', direction: 'side' }, 0, {
        position: 'before',
        durationMs: 33,
      });
    });
    expect(frameIds(store)).toEqual([id, F.f0, F.f1, F.f2]);
    expect(run(store).frames[0]?.durationMs).toBe(33);
    clean(store);
  });

  it('refuses mirrors, unknown animations and frames, and bad durations (nothing changes)', () => {
    const store = richStore();
    const h = documentHash(store);
    const opts = { position: 'after' } as const;
    expect(
      reason(() => store.transact('x', (tx) => insertFrame(tx, { id: F.runL }, 0, opts))),
    ).toBe('mirror-animation');
    expect(
      reason(() => store.transact('x', (tx) => insertFrame(tx, { group: 'nope' }, 0, opts))),
    ).toBe('unknown-animation');
    expect(reason(() => store.transact('x', (tx) => insertFrame(tx, { id: F.run }, 9, opts)))).toBe(
      'unknown-frame',
    );
    for (const durationMs of [0, 1.5, Number.NaN]) {
      expect(
        reason(() =>
          store.transact('x', (tx) => insertFrame(tx, { id: F.run }, 0, { ...opts, durationMs })),
        ),
      ).toBe('bad-duration');
    }
    expect(documentHash(store)).toBe(h);
    expect(store.version).toBe(0);
  });
});

describe('duplicateFrame (spec 3.2)', () => {
  it('copies keys, markers, events, root motion; links cels; copies overrides with new ids', () => {
    const store = richStore();
    let id!: FrameId;
    store.transact('Dup', (tx) => {
      id = duplicateFrame(tx, { id: F.run }, F.f1);
    });
    const frames = run(store).frames;
    expect(frames.map((f) => f.id)).toEqual([F.f0, F.f1, id, F.f2]);
    const src = frames[1];
    const copy = frames[2];
    expect(copy).toEqual({ ...src, id });
    expect(copy?.boneKeys).toEqual({ [F.boneArm]: { angle: 45, interp: 'step' } });
    expect(copy?.partKeys).toEqual({ [F.part]: { variant: F.varB, z: 3 } });
    expect(copy?.markers).toEqual({ hand_r: { x: 5, y: 6 } });
    expect(copy?.events).toEqual(['step']);
    expect(copy?.rootMotion).toEqual({ dx: 2, dy: -1 });
    // the copy owns its own key objects
    expect(copy?.boneKeys).not.toBe(src?.boneKeys);

    // cels: body f1 was a link to f0 -> stays a link to f0; spark f1 was an image -> links to f1
    expect(bodyCels(store)[id]).toEqual({ linkTo: F.f0 });
    const fx = store.doc.layers[2];
    if (fx?.kind !== 'group' || fx.children[0]?.kind !== 'pixel') throw new Error('fixture');
    expect(fx.children[0].cels[id]).toEqual({ linkTo: F.f1 });
    // reference layer: no cel at f1 -> none created
    const ref = store.doc.layers[3];
    expect(ref?.kind === 'reference' && Object.keys(ref.cels)).toEqual([F.f0]);

    // overrides: the run one and the mirror's extra one are copied with new override ids
    const [o1, o1c] = [
      store.doc.animations[0]?.overrides[0],
      store.doc.animations[0]?.overrides[1],
    ];
    expect(o1?.id).toBe(F.ovr1);
    expect(o1c).toMatchObject({ frameId: id, target: { partId: F.part }, anchor: { x: 1, y: -1 } });
    expect(o1c?.id).not.toBe(F.ovr1);
    expect(o1c?.set).not.toBe(o1?.set);
    expect(o1c?.erase).not.toBe(o1?.erase);
    expect(store.image(o1c?.set as never)?.equals(store.image(o1?.set as never) as never)).toBe(
      true,
    );
    const mo = store.doc.animations[1]?.overrides;
    expect(mo?.length).toBe(2);
    expect(mo?.[1]).toMatchObject({ frameId: id, target: 'final' });
    expect(mo?.[1]?.id).not.toBe(F.ovr2);
    clean(store);
    expect(validate(store)).toEqual([]);
  });

  it('keeps the copy independent: writing one override image does not touch the other', () => {
    const store = richStore();
    store.transact('Dup', (tx) => {
      duplicateFrame(tx, { id: F.run }, 1);
    });
    const ovs = store.doc.animations[0]?.overrides;
    const [a, b] = [ovs?.[0]?.set, ovs?.[1]?.set];
    store.transact('Paint', (tx) => {
      tx.writeImage(b as never, (img) => {
        (img as unknown as { set(x: number, y: number, c: number[]): void }).set(
          0,
          0,
          [1, 2, 3, 255],
        );
      });
    });
    expect(store.image(a as never)?.equals(store.image(b as never) as never)).toBe(false);
  });

  it('duplicates a frame with an image cel as a link to it, and an unlinked frame has no cels', () => {
    const store = richStore();
    let id!: FrameId;
    store.transact('Dup', (tx) => {
      id = duplicateFrame(tx, { id: F.run }, F.f2);
    });
    expect(bodyCels(store)[id]).toEqual({ linkTo: F.f2 });
    expect(run(store).frames[3]).toEqual({ ...run(store).frames[2], id });
    clean(store);
  });

  it('fails on unknown images of an override (IMAGE_MISSING) and on mirrors', () => {
    const store = richStore();
    expect(reason(() => store.transact('x', (tx) => duplicateFrame(tx, { id: F.runL }, 0)))).toBe(
      'mirror-animation',
    );
    store.transact('break', (tx) => {
      tx.deleteImage(F.imgSet1);
    });
    let code: string | undefined;
    try {
      store.transact('x', (tx) => duplicateFrame(tx, { id: F.run }, F.f1));
    } catch (e) {
      code = e instanceof CoreError ? e.code : 'other';
    }
    expect(code).toBe('IMAGE_MISSING');
  });
});

describe('deleteFrame (spec 3.2)', () => {
  it('removes keys, cels, overrides (also the mirror extras) and the images only they used', () => {
    const store = richStore();
    store.transact('Del', (tx) => {
      deleteFrame(tx, { id: F.run }, F.f1);
    });
    expect(frameIds(store)).toEqual([F.f0, F.f2]);
    expect(store.doc.animations[0]?.overrides).toEqual([]);
    expect(store.doc.animations[1]?.overrides).toEqual([]);
    const fx = store.doc.layers[2];
    if (fx?.kind !== 'group' || fx.children[0]?.kind !== 'pixel') throw new Error('fixture');
    expect(fx.children[0].cels).toEqual({});
    expect(Object.keys(bodyCels(store)).sort()).toEqual([F.f0, F.f2, F.g0].sort());
    // images of the deleted spark cel and both overrides are gone; nothing else is
    for (const id of [F.imgSpark, F.imgSet1, F.imgErase1, F.imgSet2]) {
      expect(store.image(id)).toBeUndefined();
    }
    expect(store.image(F.imgBody0)).toBeDefined();
    expect(validate(store)).toEqual([]);
  });

  it('materialises links to the deleted cel: first linker gets the image, others follow it', () => {
    const store = richStore();
    store.transact('Del', (tx) => {
      deleteFrame(tx, { id: F.run }, F.f0);
    });
    expect(frameIds(store)).toEqual([F.f1, F.f2]);
    const cels = bodyCels(store);
    const owner = cels[F.f1];
    expect(owner).toMatchObject({ offset: { x: 1, y: 2 }, opacity: 200 });
    const ownerImage = owner && 'imageId' in owner ? owner.imageId : undefined;
    expect(ownerImage).toBeDefined();
    expect(ownerImage).not.toBe(F.imgBody0); // a copy, with its own id
    expect(store.image(F.imgBody0)).toBeUndefined(); // the original went with its cel
    const src = richStore().image(F.imgBody0);
    expect(store.image(ownerImage as never)?.equals(src as never)).toBe(true);
    // the other link (idle's g0, in another animation) now points at the new owner
    expect(cels[F.g0]).toEqual({ linkTo: F.f1 });
    expect(cels[F.f0]).toBeUndefined();
    // the reference layer's f0 cel (nothing linked to it) is removed with its image
    expect(store.image(F.imgRef)).toBeUndefined();
    expect(validate(store)).toEqual([]);
  });

  it('retargets links when the deleted cel is itself (invalidly) a link', () => {
    const store = richStore();
    store.transact('Corrupt', (tx) => {
      tx.set(['layers', 0, 'cels', F.f1], { linkTo: F.f0 });
      tx.set(['layers', 0, 'cels', F.f2], { linkTo: F.f1 }); // link to a link
    });
    expect(validate(store).map((f) => f.code)).toContain('LINK_TO_LINK');
    store.transact('Del', (tx) => {
      deleteFrame(tx, { id: F.run }, F.f1);
    });
    expect(bodyCels(store)[F.f2]).toEqual({ linkTo: F.f0 });
    clean(store); // (the test itself orphaned img body2)
  });

  it('ignores dangling links and refuses the last frame, unknown frames and mirrors', () => {
    const store = richStore();
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          deleteFrame(tx, { id: F.idle }, 0);
        });
      }),
    ).toBe('last-frame');
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          deleteFrame(tx, { id: F.run }, 7);
        });
      }),
    ).toBe('unknown-frame');
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          deleteFrame(tx, { id: F.runL }, 0);
        });
      }),
    ).toBe('mirror-animation');
    expect(store.version).toBe(0);
    // a link to a frame with no cel on that layer: deleting that frame must not crash
    store.transact('Dangle', (tx) => {
      tx.set(['layers', 0, 'cels', F.f2], { linkTo: F.f1 });
      tx.remove(['layers', 2, 'children', 0, 'cels', F.f1]);
      tx.set(['layers', 2, 'children', 0, 'cels', F.f2], { linkTo: F.f1 });
    });
    store.transact('Del', (tx) => {
      deleteFrame(tx, { id: F.run }, F.f1);
    });
    expect(frameIds(store)).toEqual([F.f0, F.f2]);
  });

  it('keeps an image that something else still references', () => {
    const store = richStore();
    store.transact('Share', (tx) => {
      // the reference layer's f0 cel uses the same image as the body f0 cel
      tx.set(['layers', 3, 'cels', F.f0, 'imageId'], F.imgBody2);
    });
    store.transact('Del', (tx) => {
      deleteFrame(tx, { id: F.run }, F.f2);
    });
    expect(store.image(F.imgBody2)).toBeDefined();
    expect(referencedImages(store.doc).has(F.imgBody2)).toBe(true);
  });
});

describe('reorderFrames (spec 3.2: everything keyed by FrameId comes along)', () => {
  it('permutes frames; keys, cels, links and overrides stay attached to their frame ids', () => {
    const store = richStore();
    const before = store.doc;
    store.transact('Reorder', (tx) => {
      reorderFrames(tx, { group: 'run', direction: 'side' }, [F.f2, F.f0, F.f1]);
    });
    expect(frameIds(store)).toEqual([F.f2, F.f0, F.f1]);
    expect(run(store).frames[2]).toEqual(
      before.animations[0] && 'frames' in before.animations[0]
        ? before.animations[0].frames[1]
        : undefined,
    );
    expect(store.doc.layers).toEqual(before.layers);
    expect(store.doc.animations[0]?.overrides).toEqual(before.animations[0]?.overrides);
    expect(store.doc.animations[1]).toEqual(before.animations[1]);
    clean(store);
  });

  it('refuses anything that is not a permutation, and mirrors', () => {
    const store = richStore();
    const bad: (readonly FrameId[])[] = [
      [F.f0, F.f1],
      [F.f0, F.f1, F.f2, F.g0],
      [F.f0, F.f0, F.f1],
      [F.f0, F.f1, F.g0],
    ];
    for (const order of bad) {
      expect(
        reason(() => {
          store.transact('x', (tx) => {
            reorderFrames(tx, { id: F.run }, order);
          });
        }),
      ).toBe('bad-order');
    }
    expect(
      reason(() => {
        store.transact('x', (tx) => {
          reorderFrames(tx, { id: F.runL }, [F.f0, F.f1, F.f2]);
        });
      }),
    ).toBe('mirror-animation');
    expect(store.version).toBe(0);
  });
});

describe('property: random frame ops keep the document valid and undo restores it', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`seed ${String(seed)}`, () => {
      const r = rng(seed);
      const store = richStore();
      const h0 = documentHash(store);
      const anims = [{ id: F.run }, { id: F.idle }] as const;
      let committed = 0;
      for (let step = 0; step < 40; step++) {
        const ref = anims[int(r, anims.length)] ?? anims[0];
        const anim = store.doc.animations.find((a) => a.id === ref.id);
        if (anim === undefined || 'mirrorOf' in anim) throw new Error('fixture');
        const n = anim.frames.length;
        const at = int(r, n);
        const kind = int(r, 4);
        try {
          store.transact(`op${String(step)}`, (tx) => {
            if (kind === 0) {
              insertFrame(tx, ref, at, { position: r() < 0.5 ? 'before' : 'after' });
            } else if (kind === 1) {
              duplicateFrame(tx, ref, at);
            } else if (kind === 2) {
              deleteFrame(tx, ref, at);
            } else {
              const order = anim.frames.map((f) => f.id);
              for (let i = order.length - 1; i > 0; i--) {
                const j = int(r, i + 1);
                const t = order[i];
                if (t === undefined || order[j] === undefined) throw new Error('index');
                order[i] = order[j];
                order[j] = t;
              }
              reorderFrames(tx, ref, order);
            }
          });
          committed = store.version;
        } catch (e) {
          // only deleting the last frame may be refused
          expect(e instanceof CoreError && e.details?.reason).toBe('last-frame');
        }
        const errors = validate(store).filter((f) => f.severity === 'error');
        expect(errors).toEqual([]);
      }
      expect(committed).toBeGreaterThan(0);
      while (store.canUndo) store.undo();
      expect(documentHash(store)).toBe(h0);
      while (store.canRedo) store.redo();
      expect(validate(store).filter((f) => f.severity === 'error')).toEqual([]);
    });
  }
});
