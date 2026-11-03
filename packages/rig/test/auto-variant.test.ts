/**
 * Variant auto-select (FR-RIG-14, card E2.1). The oracle is hand-written: tables of world angles and
 * the variant (and signed residual) worked out by hand, plus a test-local re-statement of the rule on
 * plain integers for the random order-independence check.
 */
import { describe, expect, it } from 'vitest';
import { createPartCache, partResiduals, renderParts } from '../src/index.js';
import type { PartRender } from '../src/index.js';
import { prng } from './helpers.js';
import { B, P, V, VIEW2, anim, fixtureImages, fixtureRig, variant } from './render-fixture.js';
import type { FixtureRig, FrameKeys } from './render-fixture.js';

/** The fixture rig with the arm's variants replaced by `drawn`: `[name, drawnAngle?]`, in order. */
function armRig(
  drawn: readonly (readonly [string, number?])[],
  restAngle = 0,
): FixtureRig & { arm: FixtureRig['parts'][number] } {
  const rig = fixtureRig();
  const arm = rig.parts[0];
  const view = rig.views[0];
  if (arm === undefined || view === undefined) throw new Error('fixture');
  arm.variants = drawn.map(([name, angle]) =>
    variant(name, 'arm', { x: 0, y: 0 }, angle === undefined ? {} : { drawnAngle: angle }),
  );
  view.rest[B('arm')] = { x: 2, y: 2, angle: restAngle };
  return Object.assign(rig, { arm });
}

const AUTO = { [P('arm')]: { variant: 'auto' as const } };
/** A frame that sets the arm's bone key and (optionally) its variant key. */
const at = (angle: number, variantKey?: string): FrameKeys => ({
  bones: { [B('arm')]: { angle } },
  ...(variantKey === undefined
    ? {}
    : { parts: { [P('arm')]: { variant: variantKey === 'auto' ? 'auto' : V(variantKey) } } }),
});

const images = fixtureImages();

/** Variant names of the arm at every frame, rendering the frames in `order` (default ascending). */
function armVariants(
  rig: FixtureRig,
  animation: ReturnType<typeof anim>,
  order?: readonly number[],
  cache = false,
): string[] {
  const shared = cache ? createPartCache() : undefined;
  const out: string[] = [];
  for (const frame of order ?? animation.frames.map((_, i) => i)) {
    const parts = renderParts({
      rig,
      animation,
      frame,
      images,
      ...(shared === undefined ? {} : { cache: shared }),
    });
    out[frame] = (parts.find((p) => p.partId === P('arm'))?.variantId ?? 'none').replace(
      'var_',
      '',
    );
  }
  return out;
}

/** One-frame animation with the arm at world angle `angle` (rest 0) and an auto key. */
const single = (angle: number, q?: number) =>
  anim([{ bones: { [B('arm')]: { angle } }, parts: AUTO }], [], 'once', q);

/** `partResiduals` rows of the arm only. */
const armRows = (input: Parameters<typeof partResiduals>[0]) =>
  partResiduals(input).filter((x) => x.partId === P('arm'));

const armPart = (parts: readonly PartRender[]): PartRender => {
  const p = parts.find((x) => x.partId === P('arm'));
  if (p === undefined) throw new Error('arm not drawn');
  return p;
};

describe('auto-select: nearest drawnAngle (frame 0 has no history)', () => {
  // A drawn at 0, B at 90, C at 180. Each row is a one-frame animation: world angle -> variant,
  // and the signed residual (world - drawn, short way round). Worked out by hand.
  const rig = armRig([
    ['a', 0],
    ['b', 90],
    ['c', 180],
  ]);
  const table: readonly (readonly [number, string, number])[] = [
    [0, 'a', 0],
    [44, 'a', 44],
    [45, 'a', 45], // tie A/B (45 each): the earlier variant
    [46, 'b', -44],
    [90, 'b', 0],
    [91, 'b', 1],
    [134, 'b', 44],
    [135, 'b', 45], // tie B/C: the earlier variant
    [136, 'c', -44],
    [180, 'c', 0],
    [224, 'c', 44],
    [225, 'c', 45], // C at 45, A at 135, B at 135
    [270, 'a', -90], // A and C are both 90 away (270 - 180 = 90; A wraps to -90): the earlier, A
    [316, 'a', -44],
    [359, 'a', -1],
  ];
  it.each(table)('world angle %d -> %s (residual %d)', (angle, name, residual) => {
    const parts = renderParts({ rig, animation: single(angle), frame: 0, images });
    const arm = armPart(parts);
    expect(arm.variantId).toBe(V(name));
    expect(armRows({ rig, animation: single(angle) })).toMatchObject([
      { variantId: V(name), residual },
    ]);
    // the part is rotated by exactly the residual
    expect(arm.angle).toBe(((residual % 360) + 360) % 360);
  });

  it('a negative key is the same world angle: -30 is 330', () => {
    expect(armVariants(rig, single(-30))).toEqual(['a']);
    expect(armVariants(rig, single(-100))).toEqual(['c']); // 260: C is 80 away, A 100
  });
});

describe('auto-select: wraparound at +-180', () => {
  // R drawn at 170, L drawn at -170 (= 190), M at 0. Distances go the short way round.
  const drawn = [
    ['r', 170],
    ['l', -170],
    ['m', 0],
  ] as const;
  const rl = armRig(drawn);
  const lr = armRig([drawn[1], drawn[0], drawn[2]]);
  const table: readonly (readonly [number, string, string])[] = [
    // world, winner with order [r, l, m], winner with order [l, r, m]
    [180, 'r', 'l'], // 10 from both: the earlier variant of the list wins
    [179, 'r', 'r'],
    [181, 'l', 'l'], // 9 from L (190), 11 from R
    [175, 'r', 'r'],
    [185, 'l', 'l'],
    [190, 'l', 'l'],
    [350, 'm', 'm'], // M is 10 away, L 160, R 180
    [5, 'm', 'm'],
  ];
  it.each(table)('world %d: %s (or %s with the order swapped)', (angle, first, second) => {
    expect(armVariants(rl, single(angle))).toEqual([first]);
    expect(armVariants(lr, single(angle))).toEqual([second]);
  });

  it('signed residuals across the seam come out the short way round', () => {
    const res = (angle: number) => armRows({ rig: rl, animation: single(angle) })[0];
    expect(res(180)).toMatchObject({ variantId: V('r'), residual: 10, angle: 10 });
    expect(res(181)).toMatchObject({ variantId: V('l'), residual: -9, angle: 351 });
    expect(res(165)).toMatchObject({ variantId: V('r'), residual: -5, angle: 355 });
    // exactly opposite: +180 is reported as +180 (never -180)
    const opp = armRig([['a', 0]]);
    expect(armRows({ rig: opp, animation: single(180) })[0]).toMatchObject({
      residual: 180,
      angle: 180,
    });
  });
});

describe('auto-select: no drawnAngle means the bone rest angle; other views do not count', () => {
  it('a missing drawnAngle is drawn at the rest angle', () => {
    // rest 30: X (no drawnAngle) is drawn at 30, Y at 120.
    const rig = armRig([['x'], ['y', 120]], 30);
    // key 0 -> world 30: X residual 0. key 60 -> world 90: X 60 away, Y 30 away -> Y.
    expect(armVariants(rig, single(0))).toEqual(['x']);
    expect(armVariants(rig, single(60))).toEqual(['y']);
    expect(armRows({ rig, animation: single(60) })[0]).toMatchObject({
      variantId: V('y'),
      residual: -30,
    });
    expect(armRows({ rig, animation: single(0) })[0]).toMatchObject({
      variantId: V('x'),
      residual: 0,
    });
  });

  it('only variants of the animation view are candidates; a part with none is not drawn', () => {
    const rig = armRig([['near', 0]]);
    rig.arm.variants = [
      { ...variant('front', 'arm', { x: 0, y: 0 }, { drawnAngle: 90 }), viewId: VIEW2 },
      variant('side', 'arm', { x: 0, y: 0 }, { drawnAngle: 0 }),
    ];
    // world 90 is exactly the other view's drawn angle, but that variant is not a candidate
    expect(armVariants(rig, single(90))).toEqual(['side']);
    rig.arm.variants = [{ ...variant('front', 'arm', { x: 0, y: 0 }), viewId: VIEW2 }];
    expect(armVariants(rig, single(90))).toEqual(['none']);
    expect(armRows({ rig, animation: single(90) })).toEqual([]);
  });

  it('quantum: the residual used for the choice is the quantised one that is rendered', () => {
    // A at 0, B at 12; world 6 with quantum 5 -> residual of A is 5 (6 -> 5), of B is -5 -> tie -> A.
    const rig = armRig([
      ['a', 0],
      ['b', 12],
    ]);
    const parts = renderParts({ rig, animation: single(6, 5), frame: 0, images });
    expect(armPart(parts)).toMatchObject({ variantId: V('a'), angle: 5 });
  });
});

describe('auto-select: hysteresis (A drawn at 0, B at 90, 5 degrees)', () => {
  const rig = armRig([
    ['a', 0],
    ['b', 90],
  ]);
  const autoAnim = (angles: readonly number[], q?: number) =>
    anim(
      angles.map((a, i) => (i === 0 ? at(a, 'auto') : at(a))),
      [],
      'once',
      q,
    );

  it('holds the previous variant until the other is closer by more than 5', () => {
    //            f0  f1  f2  f3  f4  f5  f6
    const angles = [0, 44, 46, 50, 46, 40, 47];
    // f2: A 46 vs B 44, 2 closer -> hold A. f3: A 50 vs B 40, 10 closer -> B.
    // f4: B 44 vs A 46 -> hold B. f5: B 50 vs A 40 -> A. f6: A 47 vs B 43 -> hold A.
    expect(armVariants(rig, autoAnim(angles))).toEqual(['a', 'a', 'a', 'b', 'b', 'a', 'a']);
  });

  it('exactly 5 closer holds, more than 5 switches (quantum 0.25)', () => {
    // From A: at 47.5, A is 47.5 away and B 42.5 away: exactly 5 closer -> hold.
    // At 47.75: 47.75 vs 42.25 = 5.5 closer -> switch.
    expect(armVariants(rig, autoAnim([0, 47.5], 0.25))).toEqual(['a', 'a']);
    expect(armVariants(rig, autoAnim([0, 47.75], 0.25))).toEqual(['a', 'b']);
    // and back from B: at 42.5, B is 47.5 away, A 42.5 away: exactly 5 -> hold B.
    expect(armVariants(rig, autoAnim([90, 42.5], 0.25))).toEqual(['b', 'b']);
    expect(armVariants(rig, autoAnim([90, 42.25], 0.25))).toEqual(['b', 'a']);
  });

  it('a jittering bone around the midpoint does not flicker', () => {
    const jitter = [44, 47, 43, 46, 45, 47, 43, 46]; // all within 42.5 to 47.5 of A
    expect(new Set(armVariants(rig, autoAnim(jitter))).size).toBe(1);
  });

  it('hysteresis works across the +-180 seam', () => {
    const seam = armRig([
      ['r', 170],
      ['l', -170],
    ]);
    // 179 -> R. 181: L is 9 away, R 11 away: only 2 closer -> hold R. 195: L 5, R 25 -> L.
    expect(armVariants(seam, autoAnim([179, 181, 195]))).toEqual(['r', 'r', 'l']);
  });

  it('hidden parts are folded too: visibility does not change the variant of a later frame', () => {
    const frames: FrameKeys[] = [
      { ...at(0, 'auto'), parts: { [P('arm')]: { variant: 'auto', visible: true } } },
      { bones: { [B('arm')]: { angle: 46 } }, parts: { [P('arm')]: { visible: false } } },
      { bones: { [B('arm')]: { angle: 47 } }, parts: { [P('arm')]: { visible: true } } },
    ];
    // f2 holds A from f1 (A 47 vs B 43), though f1 was never drawn
    expect(armVariants(rig, anim(frames))).toEqual(['a', 'none', 'a']);
  });
});

describe('auto-select: an explicit variant key wins', () => {
  const rig = armRig([
    ['a', 0],
    ['b', 90],
  ]);

  it('the explicit variant is drawn even when auto would choose another', () => {
    const frames = [at(10, 'auto'), at(80, 'a'), at(80)];
    // f0 auto -> A. f1 explicit A at 80 (B is nearer): A, residual 80. f2 holds the explicit A.
    const animation = anim(frames);
    expect(armVariants(rig, animation)).toEqual(['a', 'a', 'a']);
    const f1 = renderParts({ rig, animation, frame: 1, images });
    expect(armPart(f1)).toMatchObject({ variantId: V('a'), angle: 80 });
  });

  it('after an explicit key, auto keeps the explicit variant as its previous one', () => {
    // f1 forces A at world 47 (B is nearer by 4). f2 returns to auto at 47: hysteresis holds A.
    const animation = anim([at(0, 'auto'), at(47, 'a'), at(47, 'auto')]);
    expect(armVariants(rig, animation)).toEqual(['a', 'a', 'a']);
    // control: with no explicit frame in between, a fresh auto at 47 picks B
    expect(armVariants(rig, anim([at(47, 'auto')]))).toEqual(['b']);
    // forced B at 40, then auto at 40: B is 50 away, A 40: 10 closer -> A
    expect(armVariants(rig, anim([at(40, 'b'), at(40, 'auto')]))).toEqual(['b', 'a']);
  });

  it('an explicit variant of another view is not a previous one for hysteresis', () => {
    const r = armRig([
      ['a', 0],
      ['b', 90],
    ]);
    r.arm.variants.push({ ...variant('x', 'arm', { x: 0, y: 0 }), viewId: VIEW2 });
    const animation = anim([at(47, 'x'), at(47, 'auto')]);
    expect(armVariants(r, animation)).toEqual(['x', 'b']);
  });

  it('an unknown explicit variant still throws when that frame is drawn, and not before', () => {
    const animation = anim([at(0, 'auto'), at(0, 'nope'), at(0, 'auto')]);
    expect(armVariants(rig, animation, [0, 2])[2]).toBe('a');
    expect(() => renderParts({ rig, animation, frame: 1, images })).toThrow(/no variant/);
  });

  it('no key at all keeps the view default variant and does not touch the fold', () => {
    const animation = anim([at(80), at(80)]);
    expect(armVariants(rig, animation)).toEqual(['a', 'a']);
  });
});

describe('auto-select: defined from frame 0, never from playback order', () => {
  // An oracle on plain numbers: variants A@0, B@90, A listed first. Integer degrees, rest 0.
  const dist = (world: number, drawn: number): number => {
    const r = (((world - drawn) % 360) + 360) % 360;
    return Math.min(r, 360 - r);
  };
  function oracle(worlds: readonly number[], hyst = 5): string[] {
    const out: string[] = [];
    let prev: string | undefined;
    for (const w of worlds) {
      const da = dist(w, 0);
      const db = dist(w, 90);
      const best = db < da ? 'b' : 'a'; // tie: A (listed first)
      let pick = best;
      if (prev !== undefined) {
        const dp = prev === 'a' ? da : db;
        const dBest = best === 'a' ? da : db;
        if (dp - dBest <= hyst) pick = prev;
      }
      out.push(pick);
      prev = pick;
    }
    return out;
  }
  const rig = armRig([
    ['a', 0],
    ['b', 90],
  ]);
  const rand = prng(20261102);
  const worlds = Array.from({ length: 24 }, () => Math.floor(rand() * 360));
  const animation = anim(worlds.map((w, i) => (i === 0 ? at(w, 'auto') : at(w))));
  const expected = oracle(worlds);

  it('the fold equals the hand-stated rule on 24 random world angles', () => {
    expect(armVariants(rig, animation)).toEqual(expected);
    // some frames really are held against the nearest (the case is not vacuous)
    const nearest = worlds.map((w) => (dist(w, 90) < dist(w, 0) ? 'b' : 'a'));
    expect(nearest).not.toEqual(expected);
  });

  it('any frame renders the same, however it is reached: reverse, shuffled, repeated, one at a time', () => {
    const n = worlds.length;
    const reverse = Array.from({ length: n }, (_, i) => n - 1 - i);
    const shuffled = [...reverse];
    const r = prng(7);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const a = shuffled[i];
      const b = shuffled[j];
      if (a === undefined || b === undefined) throw new Error('shuffle');
      shuffled[i] = b;
      shuffled[j] = a;
    }
    for (const cache of [false, true]) {
      expect(armVariants(rig, animation, reverse, cache)).toEqual(expected);
      expect(armVariants(rig, animation, shuffled, cache)).toEqual(expected);
      expect(armVariants(rig, animation, [...shuffled, ...reverse, ...shuffled], cache)).toEqual(
        expected,
      );
    }
    // a brand new cache and one single late frame: it folds from frame 0 on its own
    for (const f of [n - 1, 11, 3]) {
      expect(armVariants(rig, animation, [f], true)[f]).toBe(expected[f]);
    }
  });

  it('partResiduals reports the same variants as the renderer, and the same angles', () => {
    const rows = partResiduals({ rig, animation });
    const arm = rows.filter((x) => x.partId === P('arm'));
    expect(arm.map((x) => x.variantId.replace('var_', ''))).toEqual(expected);
    expect(arm.map((x) => x.frame)).toEqual(worlds.map((_, i) => i));
    worlds.forEach((_, i) => {
      const part = armPart(renderParts({ rig, animation, frame: i, images }));
      expect(arm[i]).toMatchObject({ variantId: part.variantId, angle: part.angle });
    });
  });

  it('a loop does not carry state across the seam: frame 0 has no history', () => {
    const loop = anim(
      worlds.map((w, i) => (i === 0 ? at(w, 'auto') : at(w))),
      [],
      'loop',
    );
    const pingpong = anim(
      worlds.map((w, i) => (i === 0 ? at(w, 'auto') : at(w))),
      [],
      'pingpong',
    );
    expect(armVariants(rig, loop)).toEqual(expected);
    expect(armVariants(rig, pingpong)).toEqual(expected);
    // frame 0 alone: the nearest variant, even when the last frame would hold the other one
    const last = worlds.at(-1);
    if (last === undefined) throw new Error('worlds');
    const two = anim([at(47, 'auto'), at(last)], [], 'loop');
    expect(armVariants(rig, two)[0]).toBe('b');
  });

  it('an auto key on a later frame still folds from frame 0 (earlier frames hold the first key)', () => {
    // keys: auto only at frame 2; frames 0 and 1 hold the first key, so they are auto as well
    const frames = [at(0), at(46), at(46, 'auto'), at(50), at(46)];
    expect(armVariants(rig, anim(frames))).toEqual(oracle([0, 46, 46, 50, 46]));
    expect(oracle([0, 46, 46, 50, 46])).toEqual(['a', 'a', 'a', 'b', 'b']);
  });
});

describe('partResiduals: the lint input (card E2.2 reads it)', () => {
  const rig = armRig([
    ['a', 0],
    ['b', 90],
  ]);

  it('lists drawn parts per frame in frame then rig order, with signed and unsigned residuals', () => {
    const animation = anim([
      { bones: { [B('arm')]: { angle: 0 }, [B('leg')]: { angle: 30 } }, parts: AUTO },
      { bones: { [B('arm')]: { angle: 100 }, [B('leg')]: { angle: -20 } } },
    ]);
    const rows = partResiduals({ rig, animation });
    expect(rows).toEqual([
      { frame: 0, partId: P('arm'), boneId: B('arm'), variantId: V('a'), residual: 0, angle: 0 },
      {
        frame: 0,
        partId: P('leg'),
        boneId: B('leg'),
        variantId: V('leg'),
        residual: 30,
        angle: 30,
      },
      { frame: 1, partId: P('arm'), boneId: B('arm'), variantId: V('b'), residual: 10, angle: 10 },
      {
        frame: 1,
        partId: P('leg'),
        boneId: B('leg'),
        variantId: V('leg'),
        residual: -20,
        angle: 340,
      },
    ]);
  });

  it('skips parts that are not drawn (hidden, bone outside the view)', () => {
    const animation = anim([{ parts: { [P('arm')]: { variant: 'auto', visible: false } } }]);
    expect(partResiduals({ rig, animation }).map((x) => x.partId)).toEqual([P('leg')]);
  });

  it('a variant held with hysteresis reports its residual beyond the nearest one', () => {
    // at world 46 B is nearer, but A is held: its residual is 46, not the nearest's -44
    const animation = anim([at(0, 'auto'), at(46)]);
    const arm = partResiduals({ rig, animation }).filter((x) => x.partId === P('arm'));
    expect(arm.map((x) => [x.variantId, x.residual])).toEqual([
      [V('a'), 0],
      [V('a'), 46],
    ]);
  });

  it('a shared cache gives the same rows as no cache', () => {
    const animation = anim([at(0, 'auto'), at(46), at(120), at(-170)]);
    const cache = createPartCache();
    renderParts({ rig, animation, frame: 3, images, cache });
    expect(partResiduals({ rig, animation, cache })).toEqual(partResiduals({ rig, animation }));
  });
});

describe('auto-select: unrelated behaviour is unchanged', () => {
  it('a rig without auto keys renders the default variant, as before', () => {
    const rig = fixtureRig();
    const arm = armPart(renderParts({ rig, animation: anim([{}, {}]), frame: 1, images }));
    expect(arm.variantId).toBe(V('arm'));
  });
});
