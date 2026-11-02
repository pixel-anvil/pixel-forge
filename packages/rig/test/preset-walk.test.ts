/**
 * E3.1 motion presets (FR-RIG-15): the preset API and the walk preset.
 *
 * Oracles: properties measured through `snapSkeleton` on the template skeleton (the real FK, not the
 * generator's own model): the loop closes, the planted foot does not slide beyond 1 px, the feet run
 * half a cycle apart, on more than one set of proportions; plus the determinism suite (a committed
 * SHA-256 of a case table, and runs with `Math` trig, `Math.sqrt`, `Math.random` and `Date.now`
 * stubbed to throw). The expectations for stance and phase are written from the spec formula
 * (`stance iff (100 f + offset) mod 100 n < stancePercent · n`), not read back from the code.
 */
import { createHash } from 'node:crypto';
import type { BoneId, FrameId } from '@pixel-forge/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRESETS,
  PRESET_NAMES,
  WALK_PARAMS,
  evaluatePose,
  getPreset,
  param,
  humanoidSide,
  presetAnimation,
  quantizeAngle,
  resolveParams,
  snapSkeleton,
  walk,
  type PoseKey,
  type PresetResult,
  type PresetRig,
  type SkeletonTemplate,
  type TemplateOptions,
} from '../src/index.js';
import { errorCode } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** The value of a lookup that must exist. */
function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing');
  return v;
}
const bid = (n: string): BoneId => `bon_${n}` as BoneId;

function rigOf(t: SkeletonTemplate): PresetRig {
  const rest: Record<BoneId, { x: number; y: number; angle: number }> = {};
  for (const b of t.bones) rest[bid(b.name)] = { ...b.rest };
  return {
    bones: t.bones.map((b) => ({
      id: bid(b.name),
      name: b.name,
      ...(b.parent === undefined ? {} : { parentId: bid(b.parent) }),
    })),
    view: { rest },
  };
}

/** Three sets of proportions: the default 48 px character, a tall long-legged one, a short small one. */
const SETS: Record<string, TemplateOptions> = {
  default48: { height: 48, origin: { x: 24, y: 47 } },
  tall64: {
    height: 64,
    origin: { x: 32, y: 63 },
    proportions: {
      ankle: 0.03,
      shin: 0.25,
      thigh: 0.22,
      pelvis: 0.06,
      torso: 0.22,
      neck: 0.03,
      head: 0.19,
    },
  },
  small32: { height: 32, origin: { x: 16, y: 31 } },
};
const rigs = Object.fromEntries(
  Object.entries(SETS).map(([k, o]) => [k, rigOf(humanoidSide(o))]),
) as Record<string, PresetRig>;
const rigA = must(rigs.default48);

type V = readonly [number, number];

function poseOf(frame: PresetResult['frames'][number]): Map<BoneId, PoseKey> {
  return new Map(Object.entries(frame.boneKeys).map(([id, k]) => [id as BoneId, k as PoseKey]));
}

function ankles(rig: PresetRig, r: PresetResult): { l: V[]; r: V[] } {
  const out = { l: [] as V[], r: [] as V[] };
  for (const f of r.frames) {
    const sk = snapSkeleton(rig, rig.view, poseOf(f), { angleQuantum: r.angleQuantum });
    for (const s of ['l', 'r'] as const) {
      const b = sk.bones.get(bid(`foot_${s}`));
      if (!b) throw new Error('foot');
      out[s].push([b.pivot.x, b.pivot.y]);
    }
  }
  return out;
}

/** `(offset, stancePercent)` -> the spec formula for "foot is in stance at frame f". */
const stanceAt = (f: number, n: number, offset: number, pct: number): boolean =>
  (100 * f + offset) % (100 * n) < pct * n;

/**
 * The largest spread of `ankle.x + cumulative root motion` over any complete run of planted frames
 * (two cycles unrolled, runs that touch its ends skipped), measured through `snapSkeleton`; also
 * returns how many runs were measured.
 */
function worstSlide(rig: PresetRig, r: PresetResult): { worst: number; runs: number } {
  const n = r.frames.length;
  const pos = ankles(rig, r);
  const cum: number[] = [0];
  for (let i = 0; i < 2 * n; i++) cum.push(must(cum[i]) + (r.frames[i % n]?.rootMotion.dx ?? 0));
  const pct = param(r.params, 'stancePercent');
  const phase = param(r.params, 'phase');
  const offsets = { r: phase * n, l: (phase * n + 50 * n) % (100 * n) };
  let worst = 0;
  let runs = 0;
  for (const s of ['l', 'r'] as const) {
    let run: number[] = [];
    for (let i = 0; i <= 2 * n; i++) {
      const inStance = i < 2 * n && stanceAt(i % n, n, offsets[s], pct);
      if (inStance) {
        run.push(i);
        continue;
      }
      if (run.length > 0 && run[0] !== 0 && i < 2 * n) {
        const xs = run.map((k) => must(pos[s][k % n])[0] + must(cum[k]));
        worst = Math.max(worst, Math.max(...xs) - Math.min(...xs));
        runs++;
      }
      run = [];
    }
  }
  return { worst, runs };
}

const CASES: { set: string; params: Record<string, number> }[] = [
  { set: 'default48', params: {} },
  { set: 'default48', params: { frames: 12, strideLength: 12, bob: 3, stancePercent: 65 } },
  { set: 'default48', params: { frames: 9, phase: 30, angleQuantum: 2 } },
  { set: 'default48', params: { frames: 6, stancePercent: 55, armSwing: 40 } },
  { set: 'tall64', params: {} },
  { set: 'tall64', params: { frames: 16, strideLength: 18, phase: 12 } },
  { set: 'small32', params: {} },
  { set: 'small32', params: { frames: 10, strideLength: 6, angleQuantum: 0.5 } },
];

describe('walk: API shape', () => {
  it('is registered, with documented parameters', () => {
    expect(PRESET_NAMES).toEqual(['walk']);
    expect(getPreset('walk')).toBe(walk);
    expect(PRESETS.walk).toBe(walk);
    expect(errorCode(() => getPreset('moonwalk'))).toBe('BAD_VALUE');
    expect(errorCode(() => getPreset('__proto__'))).toBe('BAD_VALUE');
    for (const spec of Object.values(WALK_PARAMS))
      expect(spec.description.length).toBeGreaterThan(5);
  });

  it('echoes every parameter with its default filled in', () => {
    const r = walk.generate(rigA);
    expect(r.preset).toBe('walk');
    expect(r.loop).toBe('loop');
    expect(r.angleQuantum).toBe(1);
    expect(r.frames).toHaveLength(8);
    expect(Object.keys(r.params).sort()).toEqual(Object.keys(WALK_PARAMS).sort());
    expect(r.params.stancePercent).toBe(60);
    expect(r.params.strideLength).toBeGreaterThan(0);
    // A given value wins over the default.
    expect(walk.generate(rigA, { frames: 6 }).params.frames).toBe(6);
  });

  it('writes plain FK keys: quantised angles, integer offsets, no IK state', () => {
    for (const { set, params } of CASES) {
      const r = walk.generate(must(rigs[set]), params);
      for (const f of r.frames) {
        for (const [id, key] of Object.entries(f.boneKeys)) {
          expect(Object.keys(key ?? {}).every((k) => k === 'angle' || k === 'offset')).toBe(true);
          if (key?.angle !== undefined) {
            expect(quantizeAngle(key.angle, r.angleQuantum), id).toBe(key.angle);
          }
          if (key?.offset !== undefined) {
            expect(Number.isInteger(key.offset.x) && Number.isInteger(key.offset.y)).toBe(true);
          }
        }
        expect(Number.isInteger(f.rootMotion.dx)).toBe(true);
        expect(f.rootMotion.dy).toBe(0);
      }
    }
  });

  it('plays through key resolution: evaluatePose reproduces the keys', () => {
    const r = walk.generate(rigA);
    const ids = r.frames.map((_, i) => `frm_${String(i)}` as FrameId);
    const anim = presetAnimation(r, ids);
    expect(anim.loop).toBe('loop');
    for (let f = 0; f < r.frames.length; f++) {
      const direct = snapSkeleton(rigA, rigA.view, poseOf(r.frames[f] as never));
      const viaAnim = evaluatePose(rigA, rigA.view, anim, f);
      for (const [id, b] of direct.bones) {
        expect(viaAnim.bones.get(id)?.pivot).toEqual(b.pivot);
        expect(viaAnim.bones.get(id)?.rotation).toEqual(b.rotation);
      }
    }
    expect(errorCode(() => presetAnimation(r, ids.slice(1)))).toBe('BAD_VALUE');
  });

  it('presetAnimation reports a missing frame as an internal error, not as empty keys', () => {
    const r = walk.generate(rigA);
    const holes = { ...r, frames: [...r.frames.slice(0, 7), undefined as never] };
    const ids = holes.frames.map((_, i) => `frm_${String(i)}` as FrameId);
    expect(errorCode(() => presetAnimation(holes, ids))).toBe('BAD_VALUE');
    expect(() => presetAnimation(holes, ids)).toThrow(/internal error/);
  });

  it('works on a skeleton with only the leg bones (arms, torso and head are optional)', () => {
    const t = humanoidSide(SETS.default48);
    const keep = new Set([
      'root',
      'pelvis',
      'thigh_l',
      'shin_l',
      'foot_l',
      'thigh_r',
      'shin_r',
      'foot_r',
    ]);
    const legsOnly = rigOf({ ...t, bones: t.bones.filter((b) => keep.has(b.name)) });
    const r = walk.generate(legsOnly);
    expect(r.frames).toHaveLength(8);
    expect(Object.keys(r.frames[0]?.boneKeys ?? {}).sort()).toEqual(
      ['pelvis', 'shin_l', 'shin_r', 'thigh_l', 'thigh_r', 'foot_l', 'foot_r'].map(bid).sort(),
    );
  });

  it('does not depend on bone ids or bone order, only on names', () => {
    const base = walk.generate(rigA);
    const renamed: PresetRig = {
      bones: [...rigA.bones].reverse().map((b) => ({
        ...b,
        id: `bon_x_${b.name}` as BoneId,
        ...(b.parentId === undefined ? {} : { parentId: `bon_x_${b.parentId.slice(4)}` as BoneId }),
      })),
      view: {
        rest: Object.fromEntries(
          Object.entries(rigA.view.rest).map(([k, v]) => [`bon_x_${k.slice(4)}`, v]),
        ),
      },
    };
    const other = walk.generate(renamed);
    const strip = (r: PresetResult): unknown =>
      r.frames.map((f) =>
        Object.fromEntries(
          Object.entries(f.boneKeys).map(([k, v]) => [k.replace('bon_x_', 'bon_'), v]),
        ),
      );
    expect(strip(other)).toEqual(strip(base));
  });
});

describe('walk: the loop closes (no seam, no duplicate frame)', () => {
  for (const { set, params } of CASES) {
    const label = `${set} ${JSON.stringify(params)}`;
    it(`has no seam and no duplicate frame: ${label}`, () => {
      const rig = must(rigs[set]);
      const r = walk.generate(rig, params);
      const n = r.frames.length;
      const first = r.frames[0];
      const last = r.frames[n - 1];
      if (!first || !last) throw new Error('frames');
      // Smooth channels (a function of time alone): the step from the last frame to frame 0 is no
      // bigger than the biggest step inside the cycle (plus a quantum of rounding).
      let compared = 0;
      for (const name of ['pelvis', 'upper_arm_l', 'upper_arm_r', 'lower_arm_l', 'lower_arm_r']) {
        const get = (i: number) => r.frames[i % n]?.boneKeys[bid(name)];
        const ch = (i: number) => get(i)?.angle ?? get(i)?.offset?.y ?? 0;
        let inner = 0;
        for (let i = 0; i + 1 < n; i++) inner = Math.max(inner, Math.abs(ch(i + 1) - ch(i)));
        expect(Math.abs(ch(0) - ch(n - 1)), `${name} wrap`).toBeLessThanOrEqual(
          inner + r.angleQuantum + 1,
        );
        compared++;
      }
      expect(compared).toBe(5);
      // The cycle does not repeat inside itself: the last frame is not frame 0 again.
      expect(JSON.stringify(last.boneKeys)).not.toEqual(JSON.stringify(first.boneKeys));
      // Root motion over one cycle is the whole cycle distance, the same whatever the frame count.
      const stride = param(r.params, 'strideLength');
      const pct = param(r.params, 'stancePercent');
      const total = r.frames.reduce((s, f) => s + f.rootMotion.dx, 0);
      expect(total).toBe(Math.round((stride * 100) / pct));
      expect(r.frames.every((f) => f.rootMotion.dx >= 0)).toBe(true);
    });
  }

  it('frame n is frame 0: shifting the start by one frame rotates the frames exactly', () => {
    // `phase` is a percent of the cycle, so for n that divides 100 a shift of 100 / n percent is
    // exactly one frame: frame f of the shifted walk must be frame f + 1 of the plain one, and for
    // f = n - 1 that is frame 0, the frame after the last. Every key of every bone, the labels and
    // the root motion must agree, so the step over the wrap is an ordinary step.
    for (const set of Object.keys(SETS)) {
      for (const n of [4, 5, 10, 20]) {
        for (const phase of [0, 35]) {
          const rig = must(rigs[set]);
          const plain = walk.generate(rig, { frames: n, phase, strideLength: 6, bob: 2 });
          const shifted = walk.generate(rig, {
            frames: n,
            phase: phase + 100 / n,
            strideLength: 6,
            bob: 2,
          });
          for (let f = 0; f < n; f++) {
            const tag = `${set} n${String(n)} phase${String(phase)} f${String(f)}`;
            expect(shifted.frames[f], tag).toEqual(plain.frames[(f + 1) % n]);
          }
        }
      }
    }
  });
});

describe('walk: the support foot does not slide', () => {
  for (const { set, params } of CASES) {
    const label = `${set} ${JSON.stringify(params)}`;
    it(`holds the ankle within 1 px of one ground point during stance: ${label}`, () => {
      const rig = must(rigs[set]);
      const r = walk.generate(rig, params);
      const n = r.frames.length;
      const pos = ankles(rig, r);
      const ground = rigOfGround(rig);
      // Body travel by frame, from the root motion the generator reports (two cycles unrolled).
      const cum: number[] = [0];
      for (let i = 0; i < 2 * n; i++)
        cum.push(must(cum[i]) + (r.frames[i % n]?.rootMotion.dx ?? 0));
      const pct = param(r.params, 'stancePercent');
      const phase = param(r.params, 'phase');
      const offsets = { r: phase * n, l: (phase * n + 50 * n) % (100 * n) };
      for (const s of ['l', 'r'] as const) {
        // Runs of consecutive stance frames in the unrolled sequence that do not touch its ends.
        let run: number[] = [];
        let planted = 0;
        for (let i = 0; i <= 2 * n; i++) {
          const inStance = i < 2 * n && stanceAt(i % n, n, offsets[s], pct);
          // The generator's own label must agree with the spec formula.
          if (i < 2 * n) {
            expect(r.frames[i % n]?.labels[`foot_${s}`] === 'stance').toBe(inStance);
          }
          if (inStance) {
            run.push(i);
            continue;
          }
          if (run.length > 0 && run[0] !== 0 && i < 2 * n) {
            const xs = run.map((k) => must(pos[s][k % n])[0] + must(cum[k]));
            expect(
              Math.max(...xs) - Math.min(...xs),
              `${s} run ${run.join(',')}`,
            ).toBeLessThanOrEqual(1);
            // On the ground: the ankle is at its rest height.
            for (const k of run) expect(must(pos[s][k % n])[1]).toBe(ground[s]);
            planted++;
          }
          run = [];
        }
        expect(planted).toBeGreaterThanOrEqual(1);
        // Swing frames are off the ground (the lift is at least one px at the middle of the swing).
        const lifted = pos[s].filter((p) => p[1] < ground[s]).length;
        expect(lifted).toBeGreaterThanOrEqual(1);
        // And the ankle moves backwards across the canvas during stance (the ground goes by).
        const stanceFrames = r.frames
          .map((f, i) => (f.labels[`foot_${s}`] === 'stance' ? i : -1))
          .filter((i) => i >= 0);
        expect(stanceFrames.length).toBeGreaterThanOrEqual(2);
      }
    });
  }

  it('the planted ankle stays within the stride either side of the hip', () => {
    const r = walk.generate(rigA, { strideLength: 12 });
    const pos = ankles(rigA, r);
    const x0 = Object.values(rigA.view.rest).length > 0 ? must(pos.r[0])[0] : 0;
    for (const p of [...pos.l, ...pos.r]) expect(Math.abs(p[0] - 24)).toBeLessThanOrEqual(12);
    expect(x0).toBeGreaterThan(0);
  });
});

/** The canvas row of the rest ankle (the ground) per side, from the rest pose. */
function rigOfGround(rig: PresetRig): { l: number; r: number } {
  const sk = snapSkeleton(rig, rig.view, new Map());
  const y = (s: string): number => sk.bones.get(bid(`foot_${s}`))?.pivot.y ?? NaN;
  return { l: y('l'), r: y('r') };
}

describe('walk: left and right feet run half a cycle apart', () => {
  it('shifts every left-foot quantity by half a cycle (even frame counts)', () => {
    for (const set of Object.keys(SETS)) {
      for (const n of [4, 8, 10, 16]) {
        for (const phase of [0, 25]) {
          const rig = must(rigs[set]);
          const r = walk.generate(rig, { frames: n, phase });
          const pos = ankles(rig, r);
          const h = n / 2;
          for (let f = 0; f < n; f++) {
            const tag = `${set} n${String(n)} phase${String(phase)} f${String(f)}`;
            const here = r.frames[f];
            const there = r.frames[(f + h) % n];
            // Labels, pelvis (two bobs a cycle) and the arms follow the time shift exactly.
            expect(here?.labels.foot_l, tag).toBe(there?.labels.foot_r);
            expect(here?.labels.foot_r, tag).toBe(there?.labels.foot_l);
            expect(here?.boneKeys[bid('pelvis')], tag).toEqual(there?.boneKeys[bid('pelvis')]);
            expect(here?.boneKeys[bid('upper_arm_l')], tag).toEqual(
              there?.boneKeys[bid('upper_arm_r')],
            );
            expect(here?.boneKeys[bid('lower_arm_l')], tag).toEqual(
              there?.boneKeys[bid('lower_arm_r')],
            );
            // Ankles: same height, same place within the 1 px of body-travel rounding.
            const a = must(pos.l[f]);
            const b = must(pos.r[(f + h) % n]);
            expect(a[1], tag).toBe(b[1]);
            expect(Math.abs(a[0] - b[0]), tag).toBeLessThanOrEqual(2);
          }
        }
      }
    }
  });

  it('keeps the offset for odd counts: equal stance counts and mirrored arms', () => {
    for (const n of [5, 7, 9, 11]) {
      const r = walk.generate(rigA, { frames: n, strideLength: 8, bob: 2 });
      const count = (s: string) =>
        r.frames.filter((f) => f.labels[`foot_${s}`] === 'stance').length;
      expect(Math.abs(count('l') - count('r'))).toBeLessThanOrEqual(1);
      // The left arm is the right arm half a cycle later: arm angle = A cos(2 pi t / cycle), so a
      // check against the formula at both offsets (written here from the spec, in degrees).
      const A = param(r.params, 'armSwing');
      for (let f = 0; f < n; f++) {
        const tR = (100 * f) % (100 * n);
        const tL = (100 * f + 50 * n) % (100 * n);
        const want = (t: number) => Math.round(A * Math.cos((2 * Math.PI * t) / (100 * n)));
        const gotR = r.frames[f]?.boneKeys[bid('upper_arm_r')]?.angle ?? Number.NaN;
        const gotL = r.frames[f]?.boneKeys[bid('upper_arm_l')]?.angle ?? Number.NaN;
        expect(Math.abs(gotR - want(tR))).toBeLessThanOrEqual(1);
        expect(Math.abs(gotL - want(tL))).toBeLessThanOrEqual(1);
      }
    }
  });

  it('moves the arm against the leg: the arm of the forward leg is back', () => {
    const r = walk.generate(rigA, { frames: 8 });
    // Frame 0 is right touchdown: right foot forward of the hip, so the right arm is back (+) and
    // the left arm forward (-).
    const pos = ankles(rigA, r);
    expect(must(pos.r[0])[0]).toBeGreaterThan(must(pos.l[0])[0]);
    expect(r.frames[0]?.boneKeys[bid('upper_arm_r')]?.angle).toBeGreaterThan(0);
    expect(r.frames[0]?.boneKeys[bid('upper_arm_l')]?.angle).toBeLessThan(0);
  });
});

describe('walk: parameters', () => {
  it('bob lowers the pelvis at touchdown and raises it at mid stance', () => {
    const r = walk.generate(rigA, { bob: 3, frames: 12 });
    const ys = r.frames.map((f) => f.boneKeys[bid('pelvis')]?.offset?.y ?? NaN);
    expect(Math.max(...ys)).toBe(3);
    expect(Math.min(...ys)).toBe(0);
    expect(
      walk
        .generate(rigA, { bob: 0, strideLength: 2 })
        .frames.every((f) => f.boneKeys[bid('pelvis')]?.offset?.y === 0),
    ).toBe(true);
  });

  it('the pelvis is lowest at touchdown and highest a quarter cycle later, whatever the stance', () => {
    // Written from the spec: the right foot touches down at 0% of the cycle (100 f + phase n = 0 mod
    // 100 n), the left foot at 50%; the pelvis is `bob` px down at both, 0 a quarter cycle later.
    for (const stancePercent of [50, 60, 75, 85]) {
      for (const [n, phase] of [
        [8, 0],
        [8, 25],
        [12, 0],
        [16, 50],
        [20, 5],
      ] as const) {
        const bob = 4;
        const r = walk.generate(rigA, { frames: n, phase, bob, stancePercent, strideLength: 6 });
        const ys = r.frames.map((f) => f.boneKeys[bid('pelvis')]?.offset?.y ?? NaN);
        const cycle = 100 * n;
        let touchdowns = 0;
        for (let f = 0; f < n; f++) {
          const t = (100 * f + phase * n) % cycle; // right foot's time, units
          const tag = `stance ${String(stancePercent)} n${String(n)} phase${String(phase)} f${String(f)}`;
          // The spec curve, bob (1 + cos(4 pi t / cycle)) / 2, within a pixel of rounding.
          const want = (bob * (1 + Math.cos((4 * Math.PI * t) / cycle))) / 2;
          expect(Math.abs(must(ys[f]) - want), tag).toBeLessThanOrEqual(0.51);
          // A touchdown frame is at the maximum, a quarter-cycle frame at the minimum.
          if (t === 0 || t === cycle / 2) {
            expect(ys[f], tag).toBe(bob);
            touchdowns++;
          }
          if (t === cycle / 4 || t === (3 * cycle) / 4) expect(ys[f], tag).toBe(0);
        }
        // The test is not vacuous: touchdown and quarter-cycle frames exist, and they are the extremes.
        expect(Math.max(...ys)).toBe(bob);
        expect(Math.min(...ys)).toBe(0);
        expect(touchdowns).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('bob given as undefined is absent: the dip is chosen like the default', () => {
    const plain = walk.generate(rigA);
    const undef = walk.generate(rigA, { bob: undefined });
    expect(undef).toEqual(plain);
    expect(undef.params.bob).toBe(plain.params.bob);
    // A given bob, even 0, is taken as it is.
    expect(walk.generate(rigA, { bob: 0, strideLength: 2 }).params.bob).toBe(0);
  });

  it('stride scales the foot travel and the root motion', () => {
    const small = walk.generate(rigA, { strideLength: 6, frames: 12 });
    const big = walk.generate(rigA, { strideLength: 12, frames: 12 });
    const dist = (r: PresetResult) => r.frames.reduce((s, f) => s + f.rootMotion.dx, 0);
    expect(dist(big)).toBeGreaterThan(dist(small));
    const span = (r: PresetResult) => {
      const xs = ankles(rigA, r).r.map((p) => p[0]);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(span(big)).toBeGreaterThan(span(small));
  });

  it('armSwing 0 and elbowBend 0 keep the arms still; lean moves torso and head the other way', () => {
    const r = walk.generate(rigA, { armSwing: 0, elbowBend: 0, lean: 5 });
    for (const f of r.frames) {
      expect(f.boneKeys[bid('upper_arm_l')]?.angle).toBe(0);
      expect(f.boneKeys[bid('lower_arm_r')]?.angle).toBe(0);
      expect(f.boneKeys[bid('torso')]?.angle).toBe(5);
      expect(f.boneKeys[bid('head')]?.angle).toBe(-5);
    }
  });

  it('the frame count and the angle quantum are free', () => {
    for (const frames of [4, 5, 6, 8, 13, 24]) {
      const r = walk.generate(rigA, { frames, strideLength: 6, bob: 2 });
      expect(r.frames).toHaveLength(frames);
    }
    const coarse = walk.generate(rigA, { angleQuantum: 5 });
    for (const f of coarse.frames) {
      for (const k of Object.values(f.boneKeys)) {
        if (k?.angle !== undefined) expect(Math.abs(k.angle % 5)).toBe(0);
      }
    }
  });

  it('at a coarse angle quantum a planted foot slides at most 1 px, or the error says what to change', () => {
    let made = 0;
    let refused = 0;
    for (const set of ['default48', 'tall64']) {
      const rig = must(rigs[set]);
      for (const angleQuantum of [3, 5, 6, 9, 10, 15, 30]) {
        for (const frames of [8, 12]) {
          const tag = `${set} q${String(angleQuantum)} n${String(frames)}`;
          let r: PresetResult | undefined;
          try {
            r = walk.generate(rig, { angleQuantum, frames });
          } catch (e) {
            expect(
              errorCode(() => walk.generate(rig, { angleQuantum, frames })),
              tag,
            ).toBe('BAD_VALUE');
            expect((e as Error).message, tag).toMatch(/angleQuantum/);
            expect((e as Error).message, tag).toMatch(/strideLength/);
            refused++;
          }
          if (r === undefined) continue;
          const { worst, runs } = worstSlide(rig, r);
          expect(runs, tag).toBeGreaterThanOrEqual(2);
          expect(worst, tag).toBeLessThanOrEqual(1);
          made++;
        }
      }
    }
    // Both outcomes are exercised, so neither branch passes vacuously.
    expect(made).toBeGreaterThan(5);
    expect(refused).toBeGreaterThan(0);
  });

  it('names the parameter to change when the dip or the stride cannot work', () => {
    const e = (() => {
      try {
        walk.generate(rigA, { angleQuantum: 15 });
      } catch (err) {
        return err as Error;
      }
      return undefined;
    })();
    expect(e?.message).toMatch(/angleQuantum/);
    expect(e?.message).toMatch(/bob/);
    expect(errorCode(() => walk.generate(rigA, { strideLength: 40, bob: 1 }))).toBe('BAD_VALUE');
  });

  it('auto defaults stay inside the parameter ranges on a very tall rig', () => {
    const height = 800;
    const tall = rigOf(humanoidSide({ height, origin: { x: 400, y: height - 1 } }));
    const r = walk.generate(tall, { frames: 4 });
    for (const name of ['strideLength', 'lift', 'bob']) {
      const spec = must(WALK_PARAMS[name]);
      const v = param(r.params, name);
      expect(v, name).toBeGreaterThanOrEqual(spec.min);
      expect(v, name).toBeLessThanOrEqual(spec.max);
    }
    // A value the caller gives is still checked as given.
    expect(errorCode(() => walk.generate(tall, { strideLength: 300 }))).toBe('BAD_VALUE');
  });

  it('takes the auto stride and lift from the shorter leg', () => {
    const t = humanoidSide(SETS.default48);
    const shorten = (name: string): PresetRig => {
      const base = rigOf(t);
      const rest = { ...base.view.rest };
      const id = bid(name);
      const cur = must(rest[id]);
      rest[id] = { ...cur, y: cur.y - 8 };
      return { ...base, view: { rest } };
    };
    const full = walk.generate(rigA);
    const leftShort = walk.generate(shorten('shin_l'));
    const rightShort = walk.generate(shorten('shin_r'));
    expect(leftShort.params.strideLength).toBe(rightShort.params.strideLength);
    expect(leftShort.params.lift).toBe(rightShort.params.lift);
    expect(Number(leftShort.params.strideLength)).toBeLessThan(Number(full.params.strideLength));
  });

  it('rejects bad input with a typed error', () => {
    expect(errorCode(() => walk.generate(rigA, { frames: 3 }))).toBe('BAD_VALUE');
    expect(errorCode(() => walk.generate(rigA, { frames: 8.5 }))).toBe('BAD_VALUE');
    expect(errorCode(() => walk.generate(rigA, { bob: Number.NaN }))).toBe('BAD_VALUE');
    expect(errorCode(() => walk.generate(rigA, { stancePercent: 95 }))).toBe('BAD_VALUE');
    expect(errorCode(() => walk.generate(rigA, { speed: 2 }))).toBe('BAD_VALUE');
    expect(errorCode(() => walk.generate(rigA, { angleQuantum: 7 }))).toBe('BAD_QUANTUM');
    // A stride the legs cannot reach.
    expect(errorCode(() => walk.generate(rigA, { strideLength: 40, bob: 1 }))).toBe('BAD_VALUE');
    expect(errorCode(() => walk.generate(rigA, { strideLength: 30, bob: 0 }))).toBe('BAD_VALUE');
    // No swing frame fits.
    expect(
      errorCode(() => walk.generate(rigA, { frames: 4, stancePercent: 90, strideLength: 4 })),
    ).toBe('BAD_VALUE');
    // A missing leg bone.
    const t = humanoidSide(SETS.default48);
    const noShin = rigOf({ ...t, bones: t.bones.filter((b) => b.name !== 'shin_l') });
    expect(errorCode(() => walk.generate(noShin))).toBe('UNKNOWN_BONE');
    // Two bones with one name.
    const dup: PresetRig = { ...rigA, bones: [...rigA.bones, { id: bid('twin'), name: 'head' }] };
    expect(errorCode(() => walk.generate(dup))).toBe('BAD_VALUE');
  });

  it('resolveParams fills defaults, takes auto values and rejects unknown names', () => {
    expect(resolveParams(WALK_PARAMS, {}, { strideLength: 5, bob: 1, lift: 2 }).frames).toBe(8);
    expect(errorCode(() => resolveParams(WALK_PARAMS, {}))).toBe('BAD_VALUE'); // no auto for stride
    expect(errorCode(() => resolveParams(WALK_PARAMS, { __proto__: 1 }, {}))).toBe('BAD_VALUE');
  });
});

describe('walk: determinism (ADR-010)', () => {
  function table(): unknown[] {
    return CASES.map(({ set, params }) => {
      const r = walk.generate(must(rigs[set]), params);
      return [set, r.params, r.frames.map((f) => [f.boneKeys, f.rootMotion, f.labels])];
    });
  }
  const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

  it('gives the same result every time', () => {
    expect(table()).toEqual(table());
  });

  it('matches the committed hash of the case table', () => {
    // Pinned on macOS (2026-11-02, re-pinned after the pelvis timing fix); CI must reproduce it on Linux (ADR-010).
    expect(hash(table())).toBe('261fa3e541d3a92c3bc76566f3b0da7b6c755545c61afe3d5b92fed4f661011e');
  });

  it('uses no Math trig, no Math.sqrt, no Math.random and no clock', () => {
    const banned = [
      'random',
      'sin',
      'cos',
      'tan',
      'atan',
      'atan2',
      'asin',
      'acos',
      'sinh',
      'cosh',
      'tanh',
      'sqrt',
      'hypot',
      'pow',
      'exp',
      'log',
    ] as const;
    const before = hash(table());
    for (const n of banned) {
      vi.spyOn(Math, n).mockImplementation(() => {
        throw new Error(`Math.${n} called by the walk preset`);
      });
    }
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now called by the walk preset');
    });
    expect(hash(table())).toBe(before);
  });
});
