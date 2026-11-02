import type { BoneId, BoneKey, Rig, View } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import {
  evaluatePose,
  selectView,
  snapSkeleton,
  type PoseAnimation,
  type PoseKey,
  type SnappedSkeleton,
} from '../src/index.js';
import { reference } from './float-reference.js';
import {
  angularDistance,
  bone,
  errorCode,
  frameId,
  makeAnim,
  makeRig,
  makeView,
  prng,
  randomCase,
  type RandomCase,
} from './helpers.js';

const S = bone('shoulder');
const E = bone('elbow');
const W = bone('wrist');
const arm = makeRig([[S], [E, S], [W, E]]);
const armView = makeView([
  [S, 10, 4, 90],
  [E, 0, 6],
  [W, 1, 5],
]);
const pose = (entries: readonly (readonly [BoneId, PoseKey])[]) => new Map(entries);
const pivots = (sk: SnappedSkeleton) => [...sk.bones.values()].map((b) => [b.pivot.x, b.pivot.y]);

describe('snapSkeleton: the formula (hand-computed, README worked example)', () => {
  it('reproduces the authored rest pose exactly when there are no keys', () => {
    const sk = snapSkeleton(arm, armView, new Map());
    expect(pivots(sk)).toEqual([
      [10, 4],
      [10, 10],
      [11, 15],
    ]);
    const s = sk.bones.get(S);
    expect(s).toEqual({
      id: S,
      inView: true,
      pivot: { x: 10, y: 4 },
      rotation: 0,
      restAngle: 90,
      worldAngle: 90,
      flipX: false,
      key: { angle: 0, offset: { x: 0, y: 0 }, flipX: false },
    });
    expect(sk.bones.get(W)?.parentId).toBe(E);
    expect(sk.angleQuantum).toBe(1);
  });

  it('rest pivots do not depend on rest angles or the quantum (ADR-012)', () => {
    const odd = makeView([
      [S, 10, 4, 100.3],
      [E, 0, 6, -37.7],
      [W, 1, 5, 12.1],
    ]);
    for (const q of [0.25, 1, 22.5, 45, 90]) {
      expect(pivots(snapSkeleton(arm, odd, new Map(), { angleQuantum: q }))).toEqual([
        [10, 4],
        [10, 10],
        [11, 15],
      ]);
    }
  });

  it('shoulder 30°, elbow 15.3°: the worked example', () => {
    const sk = snapSkeleton(
      arm,
      armView,
      pose([
        [S, { angle: 30 }],
        [E, { angle: 15.3 }],
      ]),
    );
    // elbow: (0, 6) by 30° -> (-3, 5.196) -> (-3, 5) -> (10 - 3, 4 + 5)
    // wrist: (1, 5) by 45° -> (-2.828, 4.243) -> (-3, 4) -> (7 - 3, 9 + 4)
    expect(pivots(sk)).toEqual([
      [10, 4],
      [7, 9],
      [4, 13],
    ]);
    const e = sk.bones.get(E);
    expect([e?.key.angle, e?.rotation, e?.restAngle, e?.worldAngle]).toEqual([15, 45, 90, 135]);
    expect(sk.bones.get(W)?.worldAngle).toBe(135);
  });

  it('adds offsets in canvas pixels after the rotation; children follow the snapped pivot', () => {
    const sk = snapSkeleton(
      arm,
      armView,
      pose([
        [S, { angle: 90, offset: { x: 2, y: -1 } }],
        [E, { offset: { x: 0, y: 3 } }],
      ]),
    );
    // shoulder (12, 3); elbow (0, 6) by 90° = (-6, 0) -> (6, 3) + (0, 3) = (6, 6);
    // wrist (1, 5) by 90° = (-5, 1) -> (1, 7)
    expect(pivots(sk)).toEqual([
      [12, 3],
      [6, 6],
      [1, 7],
    ]);
  });

  it('uses the Q16 table, so an exact Q16 tie rounds half away from zero', () => {
    const rig = makeRig([[S], [E, S]]);
    const view = makeView([
      [S, 0, 0],
      [E, 1, 0],
    ]);
    // (1, 0) by 30°: (56756, 32768) / 65536 = (0.866, 0.5) -> (1, 1); by -30° -> (1, -1).
    // Float64 sin 30° = 0.49999999999999994 would round to 0: one of the documented ties.
    expect(pivots(snapSkeleton(rig, view, pose([[S, { angle: 30 }]])))[1]).toEqual([1, 1]);
    expect(pivots(snapSkeleton(rig, view, pose([[S, { angle: -30 }]])))[1]).toEqual([1, -1]);
  });

  it('normalises rotation and world angles; key angles keep their sign', () => {
    const sk = snapSkeleton(
      arm,
      armView,
      pose([
        [S, { angle: -100 }],
        [E, { angle: 400 }],
      ]),
    );
    const s = sk.bones.get(S);
    const e = sk.bones.get(E);
    expect([s?.key.angle, s?.rotation, s?.worldAngle]).toEqual([-100, 260, 350]);
    expect([e?.key.angle, e?.rotation, e?.worldAngle]).toEqual([400, 300, 30]);
  });

  it('quantises the rest world angle once, from the exact sum', () => {
    const view = makeView([
      [S, 0, 0, 0.4],
      [E, 0, 6, 0.4],
      [W, 0, 5, 0.4],
    ]);
    const sk = snapSkeleton(arm, view, new Map());
    // per-bone rounding would give 0, 0, 0; the sums 0.4, 0.8, 1.2 give 0, 1, 1.
    expect([...sk.bones.values()].map((b) => b.restAngle)).toEqual([0, 1, 1]);
  });

  it('flipX is reported per bone and never moves or flips the subtree', () => {
    const sk = snapSkeleton(arm, armView, pose([[E, { flipX: true }]]));
    expect([...sk.bones.values()].map((b) => b.flipX)).toEqual([false, true, false]);
    expect(pivots(sk)).toEqual(pivots(snapSkeleton(arm, armView, new Map())));
  });

  it('bones without a rest entry are evaluated at rest (0, 0, 0) and marked inView: false', () => {
    const view = makeView([
      [S, 10, 4, 90],
      [W, 1, 5],
    ]);
    const sk = snapSkeleton(arm, view, pose([[E, { angle: 90 }]]));
    expect(sk.bones.get(E)?.inView).toBe(false);
    expect(sk.bones.get(E)?.pivot).toEqual({ x: 10, y: 4 }); // a zero-length pass-through
    expect(sk.bones.get(E)?.restAngle).toBe(90);
    expect(sk.bones.get(W)?.pivot).toEqual({ x: 5, y: 5 }); // (1, 5) by 90° = (-5, 1)
    expect(sk.bones.get(W)?.inView).toBe(true);
  });
});

describe('snapSkeleton validation', () => {
  it('rejects unknown bones in the pose and the view', () => {
    expect(errorCode(() => snapSkeleton(arm, armView, pose([[bone('x'), { angle: 1 }]])))).toBe(
      'UNKNOWN_BONE',
    );
    expect(errorCode(() => snapSkeleton(arm, makeView([[bone('x'), 0, 0]]), new Map()))).toBe(
      'UNKNOWN_BONE',
    );
    expect(
      errorCode(() =>
        snapSkeleton(
          makeRig([
            [S, E],
            [E, S],
          ]),
          armView,
          new Map(),
        ),
      ),
    ).toBe('CYCLE');
  });

  it('rejects bad values', () => {
    const v = (x: number, y = 0, angle = 0) => makeView([[S, x, y, angle]]);
    const rig = makeRig([[S]]);
    expect(errorCode(() => snapSkeleton(rig, v(0.5), new Map()))).toBe('BAD_VALUE');
    expect(errorCode(() => snapSkeleton(rig, v(0, 2 ** 31 + 1), new Map()))).toBe('BAD_VALUE');
    expect(errorCode(() => snapSkeleton(rig, v(0, 0, Number.NaN), new Map()))).toBe('BAD_VALUE');
    expect(errorCode(() => snapSkeleton(rig, v(0), pose([[S, { angle: Infinity }]])))).toBe(
      'BAD_VALUE',
    );
    expect(
      errorCode(() => snapSkeleton(rig, v(0), pose([[S, { offset: { x: 1.5, y: 0 } }]]))),
    ).toBe('BAD_VALUE');
    expect(errorCode(() => snapSkeleton(rig, v(0), pose([[S, { angle: 2 ** 60 }]])))).toBe(
      'BAD_VALUE',
    );
    expect(errorCode(() => snapSkeleton(rig, v(0), new Map(), { angleQuantum: 0.3 }))).toBe(
      'BAD_QUANTUM',
    );
    // Rest angles may be huge: only their quantised value mod 360 is used.
    expect(
      snapSkeleton(rig, v(0, 0, 1e300), new Map()).bones.get(S)?.restAngle,
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('snapSkeleton: undefined entries are skipped, as resolvePose skips undefined keys', () => {
  const withUndefined = (id: BoneId) => ({ rest: { ...armView.rest, [id]: undefined } });

  it('a rest entry whose value is undefined is the same as no entry', () => {
    const withoutE = makeView([
      [S, 10, 4, 90],
      [W, 1, 5],
    ]);
    const missing = snapSkeleton(arm, withoutE, new Map());
    const undef = snapSkeleton(arm, withUndefined(E), new Map());
    expect(undef).toEqual(missing);
    expect(undef.bones.get(E)?.inView).toBe(false);
  });

  it('an undefined entry for a bone the rig lacks is not an UNKNOWN_BONE, a defined one is', () => {
    expect(() => snapSkeleton(arm, withUndefined(bone('x')), new Map())).not.toThrow();
    expect(errorCode(() => snapSkeleton(arm, makeView([[bone('x'), 0, 0]]), new Map()))).toBe(
      'UNKNOWN_BONE',
    );
  });
});

describe('evaluatePose', () => {
  it('is resolvePose followed by snapSkeleton', () => {
    const anim = makeAnim(
      3,
      { 0: { [S]: { angle: 0 } }, 2: { [S]: { angle: 30 }, [E]: { angle: 15.3 } } },
      'loop',
    );
    const sk = evaluatePose(arm, armView, anim, frameId(2));
    expect(pivots(sk)).toEqual([
      [10, 4],
      [7, 9],
      [4, 13],
    ]);
    // frame 1: shoulder halfway (15°); the elbow's single key holds (15°) everywhere.
    expect(pivots(evaluatePose(arm, armView, anim, 1))).toEqual([
      [10, 4],
      [8, 10],
      [6, 15],
    ]);
    expect(
      evaluatePose(arm, armView, { ...anim, angleQuantum: 45 }, 2).bones.get(E)?.rotation,
    ).toBe(45);
    expect(evaluatePose(arm, armView, anim, 2, { angleQuantum: 45 }).angleQuantum).toBe(45);
  });

  it('accepts deep-readonly schema values (as core hands them over)', () => {
    type DeepReadonly<T> = T extends null | undefined | boolean | number | string | bigint | symbol
      ? T
      : { readonly [K in keyof T]: DeepReadonly<T[K]> };
    const rig: DeepReadonly<Rig> = {
      bones: arm.bones.map((b) => ({ ...b, name: 'b', length: 1 })),
      parts: [],
      views: [],
    };
    const view: DeepReadonly<View> = {
      id: 'viw_a' as View['id'],
      name: 'side',
      directions: ['side'],
      rest: armView.rest as View['rest'],
      partVisibility: {},
      defaultZ: {},
    };
    const anim = makeAnim(1, {});
    expect(pivots(evaluatePose(rig, view, anim, 0))).toEqual(
      pivots(snapSkeleton(arm, armView, new Map())),
    );
    expect(selectView({ views: [view] }, 'side')).toBe(view);
  });
});

describe('selectView', () => {
  const side = { id: 'viw_s', directions: ['side'] };
  const fb = { id: 'viw_f', directions: ['front', 'back'] };
  it('uses views[0] when undirected, else the first view drawing the direction', () => {
    expect(selectView({ views: [side, fb] })).toBe(side);
    expect(selectView({ views: [side, fb] }, 'back')).toBe(fb);
    expect(errorCode(() => selectView({ views: [side] }, 'up'))).toBe('UNKNOWN_VIEW');
    expect(errorCode(() => selectView({ views: [] }))).toBe('UNKNOWN_VIEW');
  });
});

/** Every frame of a random case, evaluated. */
const evalAll = (c: RandomCase): SnappedSkeleton[] =>
  c.anim.frames.map((_, f) => evaluatePose(c.rig, c.view, c.anim, f));

describe('oracle (b): a translation-only change shifts every pivot by the same integers', () => {
  it('moving a root rest position by k moves its whole tree by exactly k', () => {
    const rand = prng(21);
    for (let n = 0; n < 200; n++) {
      const c = randomCase(rand);
      const root = c.rig.bones[0]?.id;
      if (root === undefined) continue;
      const r = c.view.rest[root] ?? { x: 0, y: 0, angle: 0 };
      const k = { x: Math.floor(rand() * 41) - 20, y: Math.floor(rand() * 41) - 20 };
      const moved: RandomCase = {
        ...c,
        view: { rest: { ...c.view.rest, [root]: { ...r, x: r.x + k.x, y: r.y + k.y } } },
      };
      const inTree = (sk: SnappedSkeleton, id: BoneId): boolean => {
        for (let b = sk.bones.get(id); b; b = b.parentId ? sk.bones.get(b.parentId) : undefined) {
          if (b.id === root) return true;
        }
        return false;
      };
      const a = evalAll(c);
      const b = evalAll(moved);
      a.forEach((sk, f) => {
        for (const [id, bone0] of sk.bones) {
          const bone1 = b[f]?.bones.get(id);
          const d = inTree(sk, id) ? k : { x: 0, y: 0 };
          expect(bone1?.pivot).toEqual({ x: bone0.pivot.x + d.x, y: bone0.pivot.y + d.y });
          expect(bone1?.worldAngle).toBe(bone0.worldAngle);
        }
      });
    }
  });

  it('a constant root offset key (+k on every frame) moves every pivot by exactly k', () => {
    const rand = prng(22);
    for (let n = 0; n < 200; n++) {
      const c = randomCase(rand);
      const roots = c.rig.bones.filter((b) => b.parentId === undefined).map((b) => b.id);
      const k = { x: Math.floor(rand() * 21) - 10, y: Math.floor(rand() * 21) - 10 };
      // Remove the roots' own offset keys, then compare "no offset" with "offset k everywhere".
      const strip = (add: boolean): PoseAnimation => ({
        ...c.anim,
        frames: c.anim.frames.map((fr) => {
          const boneKeys: Partial<Record<BoneId, BoneKey>> = {};
          for (const [id, key] of Object.entries(fr.boneKeys)) {
            if (key && !roots.includes(id as BoneId)) boneKeys[id as BoneId] = key;
          }
          for (const id of roots) {
            const key = fr.boneKeys[id];
            const rest: { angle?: number; flipX?: boolean; interp?: BoneKey['interp'] } = {};
            if (key?.angle !== undefined) rest.angle = key.angle;
            if (key?.flipX !== undefined) rest.flipX = key.flipX;
            if (key?.interp !== undefined) rest.interp = key.interp;
            const next = add ? { ...rest, offset: k } : rest;
            if (next.angle !== undefined || next.flipX !== undefined || 'offset' in next) {
              boneKeys[id] = next as BoneKey;
            }
          }
          return { id: fr.id, boneKeys };
        }),
      });
      const base = strip(false);
      const shifted = strip(true);
      for (let f = 0; f < c.anim.frames.length; f++) {
        const a = evaluatePose(c.rig, c.view, base, f);
        const b = evaluatePose(c.rig, c.view, shifted, f);
        for (const [id, bone0] of a.bones) {
          expect(b.bones.get(id)?.pivot).toEqual({
            x: bone0.pivot.x + k.x,
            y: bone0.pivot.y + k.y,
          });
        }
      }
    }
  });

  it('documented exception: an interpolated offset at an exact .5 tie is not translation-equivariant', () => {
    // Half away from zero (FR-RIG-12) is odd-symmetric, so it cannot also commute with translation:
    // offsets 0 -> 1 give 0.5 -> 1 at the midpoint, but -1 -> 0 give -0.5 -> -1 (a shift of 2, not 1).
    const rig = makeRig([[S]]);
    const view = makeView([[S, 0, 0]]);
    const mid = (a: number, b: number): number =>
      evaluatePose(
        rig,
        view,
        makeAnim(3, {
          0: { [S]: { offset: { x: a, y: 0 } } },
          2: { [S]: { offset: { x: b, y: 0 } } },
        }),
        1,
      ).bones.get(S)?.pivot.x ?? Number.NaN;
    expect(mid(0, 1)).toBe(1);
    expect(mid(-1, 0)).toBe(-1);
  });
});

describe('oracle (c): per-frame child pivot delta ≤ ceil(L·Δθ) + 1', () => {
  it('holds for every child, consecutive frame pair (and the loop seam) of 400 random rigs', () => {
    const rand = prng(33);
    let pairs = 0;
    let rigid = 0;
    let tightMisses = 0;
    for (let n = 0; n < 400; n++) {
      const c = randomCase(rand);
      const sks = evalAll(c);
      // Rotations and offset keys come from the independent reference (accumulated ancestor key angles
      // and its own interpolation), not from the `rotation` / `key` the code under test returns.
      const refs = sks.map((sk, f) => reference(c, f, sk));
      const count = sks.length;
      const last = c.anim.loop === 'loop' ? count : count - 1;
      for (let f = 0; f < last; f++) {
        const a = sks[f];
        const b = sks[(f + 1) % count];
        if (!a || !b) continue;
        for (const bone0 of a.bones.values()) {
          if (bone0.parentId === undefined) continue;
          const p0 = a.bones.get(bone0.parentId);
          const bone1 = b.bones.get(bone0.id);
          const p1 = b.bones.get(bone0.parentId);
          const ref0 = refs[f]?.get(bone0.id);
          const ref1 = refs[(f + 1) % count]?.get(bone0.id);
          const pref0 = refs[f]?.get(bone0.parentId);
          const pref1 = refs[(f + 1) % count]?.get(bone0.parentId);
          if (!p0 || !bone1 || !p1 || !ref0 || !ref1 || !pref0 || !pref1) continue;
          // The vector the rotation produced: pivot - parent pivot - own offset key (the reference's).
          const r0 = [
            bone0.pivot.x - p0.pivot.x - ref0.offset[0],
            bone0.pivot.y - p0.pivot.y - ref0.offset[1],
          ];
          const r1 = [
            bone1.pivot.x - p1.pivot.x - ref1.offset[0],
            bone1.pivot.y - p1.pivot.y - ref1.offset[1],
          ];
          const rest = c.view.rest[bone0.id] ?? { x: 0, y: 0 };
          const L = Math.hypot(rest.x, rest.y);
          const dTheta = angularDistance(pref0.rotation, pref1.rotation);
          const delta = Math.max(
            Math.abs((r1[0] ?? 0) - (r0[0] ?? 0)),
            Math.abs((r1[1] ?? 0) - (r0[1] ?? 0)),
          );
          expect(delta).toBeLessThanOrEqual(Math.ceil(L * dTheta) + 1);
          if (dTheta === 0) {
            // Rigid attachment: the vector depends on the parent's rotation only.
            expect(delta).toBe(0);
            rigid++;
          }
          if (delta > Math.ceil(L * dTheta)) tightMisses++;
          pairs++;
        }
      }
    }
    // Pinned (seeded): how many pairs were checked, how many had an unchanged parent rotation, and
    // how many needed the "+1" (only possible at exact Q16 ties or within the table error of one).
    expect({ pairs, rigid, tightMisses }).toEqual({ pairs: 11188, rigid: 5133, tightMisses: 0 });
  });
});

describe('mirror symmetry (what T3.6 pose paste relies on)', () => {
  it('mirroring the rest x and negating angles and offset x mirrors every pivot exactly', () => {
    const rand = prng(44);
    for (let n = 0; n < 200; n++) {
      const c = randomCase(rand);
      const mirroredRest: RandomCase['view']['rest'] = {};
      for (const [id, r] of Object.entries(c.view.rest)) {
        if (r) mirroredRest[id as BoneId] = { x: -r.x, y: r.y, angle: -r.angle };
      }
      const mirrored: PoseAnimation = {
        ...c.anim,
        frames: c.anim.frames.map((fr) => ({
          id: fr.id,
          boneKeys: Object.fromEntries(
            Object.entries(fr.boneKeys).map(([id, k]) => {
              const m: Record<string, unknown> = { ...k };
              if (k?.angle !== undefined) m.angle = -k.angle;
              if (k?.offset !== undefined) m.offset = { x: -k.offset.x, y: k.offset.y };
              return [id, m];
            }),
          ),
        })),
      };
      for (let f = 0; f < c.anim.frames.length; f++) {
        const a = evaluatePose(c.rig, c.view, c.anim, f);
        const b = evaluatePose(c.rig, { rest: mirroredRest }, mirrored, f);
        for (const [id, bone0] of a.bones) {
          const bone1 = b.bones.get(id);
          expect(bone1?.pivot).toEqual({ x: -bone0.pivot.x + 0, y: bone0.pivot.y });
          expect(bone1?.key.angle).toBe(-bone0.key.angle + 0);
          expect(bone1?.rotation).toBe((360 - bone0.rotation) % 360);
        }
      }
    }
  });
});
