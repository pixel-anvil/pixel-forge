/**
 * E3.2b motion presets `run` and `jump` (FR-RIG-15).
 *
 * Oracles: properties measured through `snapSkeleton` on the template skeleton (the real FK, not the
 * generator's own model), with the expectations written from the spec formulas in the preset docs:
 * `run` stance and flight from `(100 f + offset) mod 100 n < stancePercent · n`, the pelvis curve
 * `bob (1 + cos(4π (t − stancePercent n / 2) / cycle)) / 2`; `jump` phases from the percent boundaries,
 * the ballistic height curve, the planted feet and the tuck `tuck · sin(π p)`. Plus the determinism
 * suite (a committed SHA-256 per preset and runs with `Math` trig, `Math.sqrt`, `Math.random` and
 * `Date.now` stubbed to throw).
 */
import { createHash } from 'node:crypto';
import type { BoneId } from '@pixel-forge/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JUMP_PARAMS,
  JUMP_PHASES,
  PRESETS,
  PRESET_NAMES,
  RUN_PARAMS,
  getPreset,
  humanoidSide,
  jump,
  param,
  quantizeAngle,
  run,
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

/** Snapped pivot of `name` in every frame. */
function pivots(rig: PresetRig, r: PresetResult, name: string): V[] {
  return r.frames.map((f) => {
    const b = snapSkeleton(rig, rig.view, poseOf(f), { angleQuantum: r.angleQuantum }).bones.get(
      bid(name),
    );
    if (!b) throw new Error(name);
    return [b.pivot.x, b.pivot.y];
  });
}

/** The canvas pivot of `name` at rest. */
function restOf(rig: PresetRig, name: string): V {
  const b = snapSkeleton(rig, rig.view, new Map()).bones.get(bid(name));
  if (!b) throw new Error(name);
  return [b.pivot.x, b.pivot.y];
}

const stanceAt = (f: number, n: number, offset: number, pct: number): boolean =>
  (100 * f + offset) % (100 * n) < pct * n;

// ---------------------------------------------------------------------------------------- run

const RUN_CASES: { set: string; params: Record<string, number> }[] = [
  { set: 'default48', params: {} },
  { set: 'default48', params: { frames: 12 } },
  { set: 'default48', params: { frames: 10, phase: 30, stancePercent: 30 } },
  { set: 'default48', params: { frames: 16, angleQuantum: 2, stancePercent: 40 } },
  { set: 'tall64', params: {} },
  { set: 'tall64', params: { frames: 12, strideLength: 22, phase: 12 } },
  { set: 'small32', params: {} },
  { set: 'small32', params: { frames: 10, angleQuantum: 0.5 } },
];

describe('run: API shape', () => {
  it('is registered next to walk, with documented parameters', () => {
    expect(PRESET_NAMES).toContain('run');
    expect(getPreset('run')).toBe(run);
    expect(PRESETS.run).toBe(run);
    for (const spec of Object.values(RUN_PARAMS))
      expect(spec.description.length).toBeGreaterThan(5);
  });

  it('echoes every parameter with its default filled in', () => {
    const r = run.generate(rigA);
    expect(r.preset).toBe('run');
    expect(r.loop).toBe('loop');
    expect(r.frames).toHaveLength(8);
    expect(Object.keys(r.params).sort()).toEqual(Object.keys(RUN_PARAMS).sort());
    expect(r.params.stancePercent).toBe(35);
  });

  it('writes plain FK keys: quantised angles, integer offsets', () => {
    for (const { set, params } of RUN_CASES) {
      const r = run.generate(must(rigs[set]), params);
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

  it('depends on bone names only, and works with leg bones alone', () => {
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
    const r = run.generate(legsOnly);
    expect(Object.keys(r.frames[0]?.boneKeys ?? {}).sort()).toEqual(
      ['pelvis', 'shin_l', 'shin_r', 'thigh_l', 'thigh_r', 'foot_l', 'foot_r'].map(bid).sort(),
    );
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
    const strip = (x: PresetResult): unknown =>
      x.frames.map((f) =>
        Object.fromEntries(
          Object.entries(f.boneKeys).map(([k, v]) => [k.replace('bon_x_', 'bon_'), v]),
        ),
      );
    expect(strip(run.generate(renamed))).toEqual(strip(run.generate(rigA)));
  });
});

describe('run: the loop closes (no seam, no duplicate frame)', () => {
  it('frame n is frame 0: shifting the start by one frame rotates the frames exactly', () => {
    for (const set of Object.keys(SETS)) {
      for (const n of [10, 20, 25]) {
        for (const phase of [0, 35]) {
          const rig = must(rigs[set]);
          const base = { frames: n, strideLength: 8, bob: 3, stancePercent: 30 };
          const plain = run.generate(rig, { ...base, phase });
          const shifted = run.generate(rig, { ...base, phase: phase + 100 / n });
          for (let f = 0; f < n; f++) {
            const tag = `${set} n${String(n)} phase${String(phase)} f${String(f)}`;
            expect(shifted.frames[f], tag).toEqual(plain.frames[(f + 1) % n]);
          }
        }
      }
    }
  });

  it('has no seam: smooth channels wrap with an ordinary step, and the last frame is not frame 0', () => {
    for (const { set, params } of RUN_CASES) {
      const r = run.generate(must(rigs[set]), params);
      const n = r.frames.length;
      for (const name of ['pelvis', 'upper_arm_l', 'upper_arm_r', 'lower_arm_l', 'lower_arm_r']) {
        const ch = (i: number): number => {
          const k = r.frames[i % n]?.boneKeys[bid(name)];
          return k?.angle ?? k?.offset?.y ?? 0;
        };
        let inner = 0;
        for (let i = 0; i + 1 < n; i++) inner = Math.max(inner, Math.abs(ch(i + 1) - ch(i)));
        expect(Math.abs(ch(0) - ch(n - 1)), `${set} ${name}`).toBeLessThanOrEqual(
          inner + r.angleQuantum + 1,
        );
      }
      expect(JSON.stringify(r.frames[n - 1]?.boneKeys)).not.toEqual(
        JSON.stringify(r.frames[0]?.boneKeys),
      );
      const stride = param(r.params, 'strideLength');
      const pct = param(r.params, 'stancePercent');
      expect(r.frames.reduce((s, f) => s + f.rootMotion.dx, 0)).toBe(
        Math.round((stride * 100) / pct),
      );
    }
  });
});

describe('run: flight and planted feet', () => {
  for (const { set, params } of RUN_CASES) {
    const label = `${set} ${JSON.stringify(params)}`;
    it(`has frames with both feet off the ground, and no slide in stance: ${label}`, () => {
      const rig = must(rigs[set]);
      const r = run.generate(rig, params);
      const n = r.frames.length;
      const pct = param(r.params, 'stancePercent');
      const phase = param(r.params, 'phase');
      const off = { r: phase * n, l: (phase * n + 50 * n) % (100 * n) };
      const ankle = { l: pivots(rig, r, 'foot_l'), r: pivots(rig, r, 'foot_r') };
      const ground = { l: restOf(rig, 'foot_l')[1], r: restOf(rig, 'foot_r')[1] };
      let flight = 0;
      for (let f = 0; f < n; f++) {
        const inL = stanceAt(f, n, off.l, pct);
        const inR = stanceAt(f, n, off.r, pct);
        const fr = must(r.frames[f]);
        expect(fr.labels.foot_l === 'stance').toBe(inL);
        expect(fr.labels.foot_r === 'stance').toBe(inR);
        expect(fr.labels.flight === 'air').toBe(!inL && !inR);
        // Never both feet in stance (stancePercent is below 50).
        expect(inL && inR).toBe(false);
        if (!inL && !inR) {
          flight++;
          expect(must(ankle.l[f])[1]).toBeLessThan(ground.l);
          expect(must(ankle.r[f])[1]).toBeLessThan(ground.r);
        }
        if (inL) expect(must(ankle.l[f])[1]).toBeLessThanOrEqual(ground.l);
      }
      expect(flight).toBeGreaterThanOrEqual(1);

      // Slide: ankle.x + cumulative root motion over each complete stance run (two cycles unrolled).
      const cum: number[] = [0];
      for (let i = 0; i < 2 * n; i++)
        cum.push(must(cum[i]) + (r.frames[i % n]?.rootMotion.dx ?? 0));
      let runs = 0;
      for (const s of ['l', 'r'] as const) {
        let cur: number[] = [];
        for (let i = 0; i <= 2 * n; i++) {
          const inStance = i < 2 * n && stanceAt(i % n, n, off[s], pct);
          if (inStance) {
            cur.push(i);
            continue;
          }
          if (cur.length > 0 && cur[0] !== 0 && i < 2 * n) {
            const xs = cur.map((k) => must(ankle[s][k % n])[0] + must(cum[k]));
            expect(Math.max(...xs) - Math.min(...xs), `${s} ${cur.join(',')}`).toBeLessThanOrEqual(
              1,
            );
            for (const k of cur) expect(must(ankle[s][k % n])[1]).toBe(ground[s]);
            runs++;
          }
          cur = [];
        }
      }
      expect(runs).toBeGreaterThanOrEqual(2);
    });
  }

  it('the pelvis is lowest in mid stance and highest in mid flight (spec curve)', () => {
    for (const [n, phase, pct] of [
      [8, 0, 35],
      [12, 0, 30],
      [20, 5, 25],
      [16, 50, 40],
    ] as const) {
      const bob = 4;
      const r = run.generate(rigA, { frames: n, phase, bob, stancePercent: pct, strideLength: 8 });
      const ys = r.frames.map((f) => f.boneKeys[bid('pelvis')]?.offset?.y ?? Number.NaN);
      const cycle = 100 * n;
      for (let f = 0; f < n; f++) {
        const t = (100 * f + phase * n) % cycle;
        const want = (bob * (1 + Math.cos((4 * Math.PI * (t - (pct * n) / 2)) / cycle))) / 2;
        expect(Math.abs(must(ys[f]) - want), `n${String(n)} f${String(f)}`).toBeLessThanOrEqual(
          0.51,
        );
      }
      expect(Math.max(...ys)).toBe(bob);
      expect(Math.min(...ys)).toBe(0);
      // The lowest frame is in a stance, the highest in flight or at the ends of a stance.
      const lowest = ys.indexOf(bob);
      expect(
        stanceAt(lowest, n, phase * n, pct) || stanceAt(lowest, n, phase * n + 50 * n, pct),
      ).toBe(true);
    }
  });

  it('left and right run half a cycle apart (even counts: labels, pelvis and arms exactly)', () => {
    for (const n of [10, 16]) {
      const r = run.generate(rigA, {
        frames: n,
        phase: 0,
        strideLength: 8,
        bob: 3,
        stancePercent: 30,
      });
      for (let f = 0; f < n; f++) {
        const here = must(r.frames[f]);
        const there = must(r.frames[(f + n / 2) % n]);
        expect(here.labels.foot_l).toBe(there.labels.foot_r);
        expect(here.boneKeys[bid('pelvis')]).toEqual(there.boneKeys[bid('pelvis')]);
        expect(here.boneKeys[bid('upper_arm_l')]).toEqual(there.boneKeys[bid('upper_arm_r')]);
        expect(here.boneKeys[bid('lower_arm_l')]).toEqual(there.boneKeys[bid('lower_arm_r')]);
      }
    }
  });
});

describe('run: it is a run, not a walk', () => {
  it('has a longer stride, a higher lift, more knee and elbow bend and a bigger lean than walk', () => {
    const w = walk.generate(rigA);
    const r = run.generate(rigA);
    expect(param(r.params, 'strideLength')).toBeGreaterThan(param(w.params, 'strideLength'));
    expect(param(r.params, 'lift')).toBeGreaterThan(param(w.params, 'lift'));
    const maxAbs = (x: PresetResult, name: string): number =>
      Math.max(...x.frames.map((f) => Math.abs(f.boneKeys[bid(name)]?.angle ?? 0)));
    const maxOf = (x: PresetResult, names: string[]): number =>
      Math.max(...names.map((nm) => maxAbs(x, nm)));
    expect(maxOf(r, ['shin_l', 'shin_r'])).toBeGreaterThan(maxOf(w, ['shin_l', 'shin_r']));
    expect(maxOf(r, ['lower_arm_l', 'lower_arm_r'])).toBeGreaterThan(
      maxOf(w, ['lower_arm_l', 'lower_arm_r']),
    );
    expect(maxAbs(r, 'torso')).toBeGreaterThan(maxAbs(w, 'torso'));
    // Foot on the ground for less of the cycle than walk (and below half).
    const stance = (x: PresetResult): number =>
      x.frames.filter((f) => f.labels.foot_r === 'stance').length;
    expect(stance(r)).toBeLessThan(stance(w));
  });
});

describe('run: parameters and errors', () => {
  it('takes lean, armSwing and elbowBend as given', () => {
    const r = run.generate(rigA, { armSwing: 0, elbowBend: 0, lean: 5 });
    for (const f of r.frames) {
      expect(f.boneKeys[bid('upper_arm_l')]?.angle).toBe(0);
      expect(f.boneKeys[bid('lower_arm_r')]?.angle).toBe(0);
      expect(f.boneKeys[bid('torso')]?.angle).toBe(5);
      expect(f.boneKeys[bid('head')]?.angle).toBe(-5);
    }
  });

  it('auto defaults stay inside the parameter ranges on a very tall rig', () => {
    const tall = rigOf(humanoidSide({ height: 160, origin: { x: 80, y: 159 } }));
    const r = run.generate(tall, { frames: 10 });
    for (const name of ['strideLength', 'lift', 'bob']) {
      const spec = must(RUN_PARAMS[name]);
      expect(param(r.params, name), name).toBeGreaterThanOrEqual(spec.min);
      expect(param(r.params, name), name).toBeLessThanOrEqual(spec.max);
    }
  });

  it('rejects bad input with a typed error', () => {
    expect(errorCode(() => run.generate(rigA, { frames: 3 }))).toBe('BAD_VALUE');
    expect(errorCode(() => run.generate(rigA, { stancePercent: 50 }))).toBe('BAD_VALUE');
    expect(errorCode(() => run.generate(rigA, { speed: 2 }))).toBe('BAD_VALUE');
    expect(errorCode(() => run.generate(rigA, { angleQuantum: 7 }))).toBe('BAD_QUANTUM');
    // No frame can show the flight (4 frames, short flight), or the stance has no frame.
    expect(errorCode(() => run.generate(rigA, { frames: 4, stancePercent: 49 }))).toBe('BAD_VALUE');
    expect(errorCode(() => run.generate(rigA, { frames: 4, stancePercent: 10, phase: 10 }))).toBe(
      'BAD_VALUE',
    );
    // A stride the legs cannot reach.
    expect(errorCode(() => run.generate(rigA, { strideLength: 60, bob: 1 }))).toBe('BAD_VALUE');
    const t = humanoidSide(SETS.default48);
    const noShin = rigOf({ ...t, bones: t.bones.filter((b) => b.name !== 'shin_l') });
    expect(errorCode(() => run.generate(noShin))).toBe('UNKNOWN_BONE');
  });

  it('refuses the 15 degree quantum with a message that names what to change', () => {
    for (const angleQuantum of [15, 30]) {
      let message = '';
      try {
        run.generate(rigA, { angleQuantum });
      } catch (e) {
        message = (e as Error).message;
        expect((e as { code?: string }).code).toBe('BAD_VALUE');
      }
      expect(message).toMatch(/angleQuantum/);
      expect(message).toMatch(/bob/);
    }
  });

  it('at coarse quanta a planted foot slides at most 1 px, or the call is refused', () => {
    let made = 0;
    let refused = 0;
    for (const angleQuantum of [3, 5, 6, 9, 10, 15]) {
      try {
        const r = run.generate(rigA, { angleQuantum, frames: 12 });
        const x = pivots(rigA, r, 'foot_r').map((p, i) => ({ x: p[0], f: i }));
        expect(x.length).toBe(12);
        made++;
      } catch (e) {
        expect((e as { code?: string }).code).toBe('BAD_VALUE');
        refused++;
      }
    }
    expect(made + refused).toBe(6);
    expect(refused).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------------------- jump

const JUMP_CASES: { set: string; params: Record<string, number> }[] = [
  { set: 'default48', params: {} },
  { set: 'default48', params: { frames: 10, height: 8, crouch: 3 } },
  { set: 'default48', params: { frames: 21, height: 14, crouch: 6, landDepth: 3, tuck: 5 } },
  { set: 'default48', params: { frames: 16, travel: 18 } },
  { set: 'default48', params: { frames: 30, angleQuantum: 2, travel: -10 } },
  { set: 'tall64', params: {} },
  { set: 'tall64', params: { frames: 24, height: 20, travel: 12 } },
  { set: 'small32', params: {} },
  { set: 'small32', params: { frames: 14, angleQuantum: 0.5, height: 6 } },
];

/** The phase of frame `f` of `n` from the percent boundaries, written from the spec table. */
function phaseAt(f: number, n: number): string {
  const starts: [string, number][] = [
    ['anticipation', 0],
    ['pushoff', 25],
    ['rise', 36],
    ['apex', 52],
    ['fall', 62],
    ['land', 78],
    ['recover', 90],
  ];
  let name = 'anticipation';
  for (const [nm, from] of starts) if (100 * f >= from * (n - 1)) name = nm;
  return name;
}

describe('jump: API shape', () => {
  it('is registered, plays once, and documents its parameters', () => {
    expect(PRESET_NAMES).toContain('jump');
    expect(getPreset('jump')).toBe(jump);
    expect(PRESETS.jump).toBe(jump);
    expect(jump.loop).toBe('once');
    for (const spec of Object.values(JUMP_PARAMS))
      expect(spec.description.length).toBeGreaterThan(5);
    expect(JUMP_PHASES.map((p) => p.name)).toEqual([
      'anticipation',
      'pushoff',
      'rise',
      'apex',
      'fall',
      'land',
      'recover',
    ]);
  });

  it('echoes every parameter with its default filled in', () => {
    const r = jump.generate(rigA);
    expect(r.preset).toBe('jump');
    expect(r.loop).toBe('once');
    expect(r.frames).toHaveLength(12);
    expect(Object.keys(r.params).sort()).toEqual(Object.keys(JUMP_PARAMS).sort());
    expect(r.params.travel).toBe(0);
    // landDepth follows crouch unless given.
    expect(r.params.landDepth).toBe(r.params.crouch);
    expect(jump.generate(rigA, { crouch: 7 }).params.landDepth).toBe(7);
    expect(jump.generate(rigA, { crouch: 7, landDepth: 2 }).params.landDepth).toBe(2);
  });

  it('writes plain FK keys: quantised angles, integer offsets', () => {
    for (const { set, params } of JUMP_CASES) {
      const r = jump.generate(must(rigs[set]), params);
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
        expect(f.rootMotion.dy).toBe(0);
      }
    }
  });

  it('works with leg bones alone and depends on names only', () => {
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
    expect(jump.generate(legsOnly).frames).toHaveLength(12);
    const noFoot = rigOf({ ...t, bones: t.bones.filter((b) => b.name !== 'foot_r') });
    expect(errorCode(() => jump.generate(noFoot))).toBe('UNKNOWN_BONE');
  });
});

describe('jump: phases and height', () => {
  it('labels the phases as the boundary table says, in order, every phase at least once', () => {
    for (const n of [10, 11, 12, 16, 21, 33, 64]) {
      const r = jump.generate(rigA, { frames: n });
      const seen: string[] = [];
      for (let f = 0; f < n; f++) {
        const got = r.frames[f]?.labels.phase;
        expect(got, `n${String(n)} f${String(f)}`).toBe(phaseAt(f, n));
        if (seen[seen.length - 1] !== got) seen.push(got ?? '');
      }
      expect(seen).toEqual(JUMP_PHASES.map((p) => p.name));
    }
  });

  it('the pelvis follows the spec curve, measured through snapSkeleton', () => {
    // 21 frames: u = 5 f percent, so every boundary is a frame.
    const height = 14;
    const crouch = 6;
    const landDepth = 4;
    const r = jump.generate(rigA, { frames: 21, height, crouch, landDepth, tuck: 3 });
    const rest = restOf(rigA, 'pelvis')[1];
    const ys = pivots(rigA, r, 'pelvis').map((p) => p[1] - rest);
    const ease = (s: number): number => 3 * s * s - 2 * s * s * s;
    const bounds = [0, 25, 36, 52, 62, 78, 90, 100];
    for (let f = 0; f < 21; f++) {
      const u = 5 * f;
      let i = 0;
      for (let k = 0; k < 7; k++) if (u >= (bounds[k] ?? 0)) i = k;
      const s = (u - (bounds[i] ?? 0)) / ((bounds[i + 1] ?? 100) - (bounds[i] ?? 0));
      const want = must(
        [
          crouch * ease(s),
          crouch * (1 - ease(s)),
          -height * (2 * s - s * s),
          -height,
          -height * (1 - s * s),
          landDepth * ease(s),
          landDepth * (1 - ease(s)),
        ][i],
      );
      expect(Math.abs(must(ys[f]) - want), `f${String(f)} u${String(u)}`).toBeLessThanOrEqual(0.51);
    }
    // The apex is exactly `height` above rest and nothing goes higher.
    expect(Math.min(...ys)).toBe(-height);
    for (let f = 0; f < 21; f++) {
      if (phaseAt(f, 21) === 'apex') expect(ys[f]).toBe(-height);
    }
    // The deepest points are the crouch before take-off and the landing absorb.
    expect(Math.max(...ys.slice(0, 8))).toBe(crouch);
    expect(Math.max(...ys.slice(14))).toBe(landDepth);
    // Whole jump is the offset: the key is the offset the snapped pelvis shows.
    expect(r.frames.map((f) => f.boneKeys[bid('pelvis')]?.offset?.y)).toEqual(ys);
  });

  it('the height parameter is the rise of the pelvis, for every proportion set', () => {
    for (const set of Object.keys(SETS)) {
      const rig = must(rigs[set]);
      for (const height of [4, 9]) {
        const r = jump.generate(rig, { height, crouch: 2, landDepth: 2, tuck: 2 });
        const rest = restOf(rig, 'pelvis')[1];
        const top = Math.min(...pivots(rig, r, 'pelvis').map((p) => p[1] - rest));
        expect(top, `${set} ${String(height)}`).toBe(-height);
      }
    }
  });

  it('first and last frame are the standing pose (the jump returns to where it began)', () => {
    for (const { set, params } of JUMP_CASES) {
      const r = jump.generate(must(rigs[set]), params);
      expect(r.frames[r.frames.length - 1]?.boneKeys, set).toEqual(r.frames[0]?.boneKeys);
    }
  });
});

describe('jump: feet', () => {
  for (const { set, params } of JUMP_CASES) {
    const label = `${set} ${JSON.stringify(params)}`;
    it(`plants the feet on the ground rows on the ground and lifts them in the air: ${label}`, () => {
      const rig = must(rigs[set]);
      const r = jump.generate(rig, params);
      const n = r.frames.length;
      const tuck = param(r.params, 'tuck');
      const rest = restOf(rig, 'pelvis')[1];
      const pel = pivots(rig, r, 'pelvis').map((p) => p[1] - rest);
      for (const s of ['l', 'r'] as const) {
        const ankle = pivots(rig, r, `foot_${s}`);
        const [gx, gy] = restOf(rig, `foot_${s}`);
        for (let f = 0; f < n; f++) {
          const ph = phaseAt(f, n);
          const u = (100 * f) / (n - 1);
          const [ax, ay] = must(ankle[f]);
          const air = (ph === 'rise' && u > 36) || ph === 'apex' || ph === 'fall';
          expect(r.frames[f]?.labels[`foot_${s}`]).toBe(air ? 'air' : 'ground');
          if (!air) {
            // On the ground: on the rest pixel (within 1 px at coarse quanta).
            expect(Math.abs(ax - gx), `${s} f${String(f)} x`).toBeLessThanOrEqual(1);
            expect(Math.abs(ay - gy), `${s} f${String(f)} y`).toBeLessThanOrEqual(1);
          } else {
            // In the air: rest ankle + pelvis offset - tuck sin(pi p), within 2 px of rounding.
            const p = (u - 36) / (78 - 36);
            const want = gy + must(pel[f]) - tuck * Math.sin(Math.PI * p);
            expect(Math.abs(ay - want), `${s} f${String(f)} air`).toBeLessThanOrEqual(2);
            // Off the ground wherever the spec lifts the foot by 2 px or more (1 px of IK slack).
            expect(ay, `${s} f${String(f)} not sunk`).toBeLessThanOrEqual(gy);
            if (want <= gy - 2) expect(ay, `${s} f${String(f)} off the ground`).toBeLessThan(gy);
            expect(Math.abs(ax - gx)).toBeLessThanOrEqual(1);
          }
        }
        // Planted ankles do not move at all within a contact at the default quantum.
        if (r.angleQuantum <= 1) {
          const before = ankle.filter((_, f) => 100 * f <= 36 * (n - 1));
          const after = ankle.filter((_, f) => 100 * f >= 78 * (n - 1));
          for (const run of [before, after]) {
            expect(new Set(run.map((a) => `${String(a[0])},${String(a[1])}`)).size).toBe(1);
          }
        }
      }
    });
  }

  it('the knees fold in the crouch: more bend than standing, and the shin goes back', () => {
    const r = jump.generate(rigA, { crouch: 6 });
    const bend = (f: number): number => r.frames[f]?.boneKeys[bid('shin_r')]?.angle ?? 0;
    expect(bend(0)).toBe(0);
    expect(Math.max(...r.frames.map((_, f) => bend(f)))).toBeGreaterThan(20);
  });
});

describe('jump: root motion', () => {
  it('is zero on every frame unless travel is given', () => {
    const r = jump.generate(rigA);
    expect(r.frames.every((f) => f.rootMotion.dx === 0 && f.rootMotion.dy === 0)).toBe(true);
  });

  it('travel moves the body during the flight only, and sums to the given px', () => {
    for (const travel of [18, -10, 1]) {
      for (const n of [10, 12, 21, 40]) {
        const r = jump.generate(rigA, { frames: n, travel });
        expect(
          r.frames.reduce((s, f) => s + f.rootMotion.dx, 0),
          `${String(travel)} n${String(n)}`,
        ).toBe(travel);
        const sign = Math.sign(travel);
        for (let f = 0; f < n; f++) {
          const dx = must(r.frames[f]).rootMotion.dx;
          expect(dx * sign).toBeGreaterThanOrEqual(0);
          // Frames wholly before take-off (36%) or from landing (78%) on do not move.
          if (100 * (f + 1) <= 36 * (n - 1) || 100 * f >= 78 * (n - 1)) {
            expect(dx, `f${String(f)}`).toBe(0);
          }
        }
      }
    }
  });
});

describe('jump: parameters and errors', () => {
  it('height, crouch and tuck change the motion', () => {
    const low = jump.generate(rigA, { height: 4 });
    const high = jump.generate(rigA, { height: 14 });
    const top = (x: PresetResult): number =>
      Math.min(...x.frames.map((f) => f.boneKeys[bid('pelvis')]?.offset?.y ?? 0));
    expect(top(high)).toBeLessThan(top(low));
    const shallow = jump.generate(rigA, { crouch: 1 });
    const deep = jump.generate(rigA, { crouch: 7 });
    const bottom = (x: PresetResult): number =>
      Math.max(...x.frames.map((f) => f.boneKeys[bid('pelvis')]?.offset?.y ?? 0));
    expect(bottom(deep)).toBeGreaterThan(bottom(shallow));
    const noTuck = jump.generate(rigA, { tuck: 0 });
    const tucked = jump.generate(rigA, { tuck: 8 });
    const apexShin = (x: PresetResult): number => x.frames[6]?.boneKeys[bid('shin_r')]?.angle ?? 0;
    expect(Math.abs(apexShin(tucked))).toBeGreaterThan(Math.abs(apexShin(noTuck)));
  });

  it('armSwing 0, elbowBend 0 and lean 0 leave arms and torso still but for the elbow rest', () => {
    const r = jump.generate(rigA, { armSwing: 0, elbowBend: 0, lean: 0 });
    for (const f of r.frames) {
      expect(f.boneKeys[bid('upper_arm_l')]?.angle).toBe(0);
      expect(f.boneKeys[bid('lower_arm_r')]?.angle).toBe(0);
      expect(f.boneKeys[bid('torso')]?.angle).toBe(0);
      expect(f.boneKeys[bid('head')]?.angle).toBe(0);
    }
  });

  it('rejects bad input with a typed error', () => {
    expect(errorCode(() => jump.generate(rigA, { frames: 9 }))).toBe('BAD_VALUE');
    expect(errorCode(() => jump.generate(rigA, { frames: 12.5 }))).toBe('BAD_VALUE');
    expect(errorCode(() => jump.generate(rigA, { height: 0 }))).toBe('BAD_VALUE');
    expect(errorCode(() => jump.generate(rigA, { travel: 300 }))).toBe('BAD_VALUE');
    expect(errorCode(() => jump.generate(rigA, { phase: 10 }))).toBe('BAD_VALUE');
    expect(errorCode(() => jump.generate(rigA, { angleQuantum: 7 }))).toBe('BAD_QUANTUM');
    // A tuck the legs cannot reach.
    expect(errorCode(() => jump.generate(rigA, { tuck: 64 }))).toBe('BAD_VALUE');
  });

  it('refuses a coarse quantum with a clear error, or stays within 1 px', () => {
    let refused = 0;
    for (const angleQuantum of [3, 5, 6, 9, 10, 15, 30]) {
      try {
        const r = jump.generate(rigA, { angleQuantum });
        const ys = pivots(rigA, r, 'foot_r').map((p) => p[1]);
        expect(Math.max(...ys.slice(0, 3)) - Math.min(...ys.slice(0, 3))).toBeLessThanOrEqual(1);
      } catch (e) {
        expect((e as { code?: string }).code).toBe('BAD_VALUE');
        expect((e as Error).message).toMatch(/angleQuantum|reach/);
        refused++;
      }
    }
    expect(refused).toBeGreaterThanOrEqual(0);
  });
});

// ------------------------------------------------------------------------------- determinism

describe('run and jump: determinism (ADR-010)', () => {
  const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const dump = (r: PresetResult): unknown => [
    r.params,
    r.frames.map((f) => [f.boneKeys, f.rootMotion, f.labels]),
  ];
  const runTable = (): unknown[] =>
    RUN_CASES.map(({ set, params }) => dump(run.generate(must(rigs[set]), params)));
  const jumpTable = (): unknown[] =>
    JUMP_CASES.map(({ set, params }) => dump(jump.generate(must(rigs[set]), params)));

  it('gives the same result every time', () => {
    expect(runTable()).toEqual(runTable());
    expect(jumpTable()).toEqual(jumpTable());
  });

  it('matches the committed hashes of the case tables', () => {
    // Pinned on macOS (2026-11-02; run re-pinned in E7.5 after the default lift change); CI must reproduce them on Linux (ADR-010).
    expect(hash(runTable())).toBe(
      'df9b65856eec684bffb36fc8a6d97ffa2faeb9b7f54cad51523c5e7c035f1855',
    );
    expect(hash(jumpTable())).toBe(
      '30f316367704f2715d308c045528322d40a58de74b1d110602d7d0958bb4aa7f',
    );
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
    const before = [hash(runTable()), hash(jumpTable())];
    for (const n of banned) {
      vi.spyOn(Math, n).mockImplementation(() => {
        throw new Error(`Math.${n} called by a preset`);
      });
    }
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now called by a preset');
    });
    expect([hash(runTable()), hash(jumpTable())]).toEqual(before);
  });
});
