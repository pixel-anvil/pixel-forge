/**
 * E3.2a motion presets (FR-RIG-15): `idle-breathe` and `swing`.
 *
 * Oracles are written from the spec formulas in the preset docs (breath `(1 − cos 2π t) / 2`, the
 * phase split indices of `swing`) with floating-point trig in the test only, and measured through
 * `snapSkeleton` on the template skeleton (the real FK), not through the generator's own model.
 * Tolerances are one pixel / one degree where a rounding step is involved. Determinism: a committed
 * SHA-256 of the case tables, and runs with `Math` trig, `sqrt`, `random` and `Date.now` stubbed.
 */
import { createHash } from 'node:crypto';
import type { BoneId } from '@pixel-forge/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IDLE_BREATHE_PARAMS,
  PRESET_NAMES,
  SWING_PARAMS,
  getPreset,
  humanoidSide,
  idleBreathe,
  param,
  quantizeAngle,
  snapSkeleton,
  swing,
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

function rigOf(t: SkeletonTemplate, idOf: (n: string) => BoneId = bid): PresetRig {
  const rest: Record<BoneId, { x: number; y: number; angle: number }> = {};
  for (const b of t.bones) rest[idOf(b.name)] = { ...b.rest };
  return {
    bones: t.bones.map((b) => ({
      id: idOf(b.name),
      name: b.name,
      ...(b.parent === undefined ? {} : { parentId: idOf(b.parent) }),
    })),
    view: { rest },
  };
}

const SETS: Record<string, TemplateOptions> = {
  default48: { height: 48, origin: { x: 24, y: 47 } },
  tall64: { height: 64, origin: { x: 32, y: 63 } },
  small32: { height: 32, origin: { x: 16, y: 31 } },
};
const rigs = Object.fromEntries(
  Object.entries(SETS).map(([k, o]) => [k, rigOf(humanoidSide(o))]),
) as Record<string, PresetRig>;
const rigA = must(rigs.default48);

type Frame = PresetResult['frames'][number];
const poseOf = (frame: Frame): Map<BoneId, PoseKey> =>
  new Map(Object.entries(frame.boneKeys).map(([id, k]) => [id as BoneId, k as PoseKey]));

/** Snapped pivot of a bone in a frame (or at rest when `frame` is undefined). */
function pivot(rig: PresetRig, r: PresetResult, frame: Frame | undefined, name: string) {
  const pose = frame === undefined ? new Map<BoneId, PoseKey>() : poseOf(frame);
  const b = snapSkeleton(rig, rig.view, pose, { angleQuantum: r.angleQuantum }).bones.get(
    bid(name),
  );
  if (!b) throw new Error(name);
  return b.pivot;
}
const angleOf = (f: Frame, name: string): number => f.boneKeys[bid(name)]?.angle ?? 0;
const frameOf = (r: PresetResult, i: number): Frame => must(r.frames[i]);

const LEG_BONES = ['pelvis', 'thigh_l', 'shin_l', 'foot_l', 'thigh_r', 'shin_r', 'foot_r'];

function checkFk(r: PresetResult): void {
  for (const f of r.frames) {
    for (const [id, key] of Object.entries(f.boneKeys)) {
      expect(Object.keys(key ?? {}).every((k) => k === 'angle' || k === 'offset')).toBe(true);
      if (key?.angle !== undefined)
        expect(quantizeAngle(key.angle, r.angleQuantum), id).toBe(key.angle);
      if (key?.offset !== undefined) {
        expect(Number.isInteger(key.offset.x) && Number.isInteger(key.offset.y)).toBe(true);
      }
    }
    expect(f.rootMotion).toEqual({ dx: 0, dy: 0 });
  }
}

const IDLE_CASES: { set: string; params: Record<string, number> }[] = [
  { set: 'default48', params: {} },
  { set: 'default48', params: { frames: 12, amplitude: 2, chestTilt: 3, armSway: 8 } },
  { set: 'default48', params: { frames: 9, phase: 30, angleQuantum: 2 } },
  { set: 'tall64', params: { frames: 16, amplitude: 3, phase: 12 } },
  { set: 'small32', params: { frames: 6, angleQuantum: 0.5, headTilt: 4 } },
];

const SWING_CASES: { set: string; params: Record<string, number> }[] = [
  { set: 'default48', params: {} },
  { set: 'default48', params: { frames: 12, side: 1, raise: 150, reach: 80, follow: 10 } },
  { set: 'default48', params: { frames: 5, angleQuantum: 2 } },
  { set: 'tall64', params: { frames: 24, twist: 20, anticipationPercent: 50, strikePercent: 20 } },
  { set: 'small32', params: { frames: 4, angleQuantum: 0.5 } },
];

describe('idle-breathe', () => {
  it('is registered, with documented parameters and every default echoed', () => {
    expect(PRESET_NAMES).toContain('idle-breathe');
    expect(getPreset('idle-breathe')).toBe(idleBreathe);
    for (const spec of Object.values(IDLE_BREATHE_PARAMS)) {
      expect(spec.description.length).toBeGreaterThan(5);
    }
    const r = idleBreathe.generate(rigA);
    expect(r.preset).toBe('idle-breathe');
    expect(r.loop).toBe('loop');
    expect(r.frames).toHaveLength(8);
    expect(Object.keys(r.params).sort()).toEqual(Object.keys(IDLE_BREATHE_PARAMS).sort());
    expect(idleBreathe.generate(rigA, { frames: 6 }).params.frames).toBe(6);
  });

  it('writes plain FK keys, and none on the pelvis or the legs', () => {
    for (const { set, params } of IDLE_CASES) {
      const r = idleBreathe.generate(must(rigs[set]), params);
      checkFk(r);
      for (const f of r.frames) {
        for (const name of LEG_BONES) expect(f.boneKeys[bid(name)], name).toBeUndefined();
      }
    }
  });

  it('keeps the legs planted: every leg pivot equals its rest pivot in every frame', () => {
    for (const { set, params } of IDLE_CASES) {
      const rig = must(rigs[set]);
      const r = idleBreathe.generate(rig, params);
      for (const f of r.frames) {
        for (const name of LEG_BONES) {
          expect(pivot(rig, r, f, name), `${set} ${name}`).toEqual(pivot(rig, r, undefined, name));
        }
      }
    }
  });

  it('raises the chest by the breath (1 - cos 2 pi t) / 2 times the amplitude, measured on the torso pivot', () => {
    for (const { set, params } of IDLE_CASES) {
      const rig = must(rigs[set]);
      const r = idleBreathe.generate(rig, params);
      const n = r.frames.length;
      const amp = param(r.params, 'amplitude');
      const phase = param(r.params, 'phase');
      const rest = pivot(rig, r, undefined, 'torso');
      let top = 0;
      r.frames.forEach((f, i) => {
        const turns = (100 * i + phase * n) / (100 * n);
        const want = (amp * (1 - Math.cos(2 * Math.PI * turns))) / 2;
        const p = pivot(rig, r, f, 'torso');
        expect(p.x).toBe(rest.x);
        expect(Math.abs(rest.y - p.y - want), `${set} frame ${String(i)}`).toBeLessThanOrEqual(1);
        top = Math.max(top, rest.y - p.y);
      });
      expect(top).toBeLessThanOrEqual(amp);
      if (n % 2 === 0 && phase === 0) expect(top).toBe(amp); // frame n/2 is the top of the inhale
    }
  });

  it('turns the torso back, the head forward (late) and sways the arms (later), by the spec formulas', () => {
    const r = idleBreathe.generate(rigA, { frames: 16, chestTilt: 4, headTilt: 5, armSway: 10 });
    const n = r.frames.length;
    const b = (turns: number): number => (1 - Math.cos(2 * Math.PI * turns)) / 2;
    r.frames.forEach((f, i) => {
      const t = i / n;
      expect(Math.abs(angleOf(f, 'torso') + 4 * b(t))).toBeLessThanOrEqual(1);
      expect(Math.abs(angleOf(f, 'head') - 5 * b(t - 1 / 8))).toBeLessThanOrEqual(1);
      for (const s of ['l', 'r']) {
        expect(Math.abs(angleOf(f, `upper_arm_${s}`) - 10 * b(t - 1 / 4))).toBeLessThanOrEqual(1);
        expect(Math.abs(angleOf(f, `lower_arm_${s}`) + 5 * b(t - 1 / 4))).toBeLessThanOrEqual(1);
      }
    });
    // The head peak comes after the chest peak (counter-motion that follows).
    const peak = (name: string, sign: number): number => {
      let best = 0;
      r.frames.forEach((f, i) => {
        if (sign * angleOf(f, name) > sign * angleOf(frameOf(r, best), name)) best = i;
      });
      return best;
    };
    expect(peak('head', 1)).toBe((peak('torso', -1) + n / 8) % n);
  });

  it('labels the inhale and the exhale from the spec formula', () => {
    for (const { params } of IDLE_CASES) {
      const r = idleBreathe.generate(rigA, params);
      const n = r.frames.length;
      const phase = param(r.params, 'phase');
      r.frames.forEach((f, i) => {
        const want = (100 * i + phase * n) % (100 * n) < 50 * n ? 'inhale' : 'exhale';
        expect(f.labels.breath).toBe(want);
      });
    }
  });

  it('closes the loop exactly: shifting phase by one frame rotates the frames', () => {
    for (const n of [4, 5, 10, 20]) {
      const step = 100 / n;
      const a = idleBreathe.generate(rigA, { frames: n, phase: 7 });
      const b = idleBreathe.generate(rigA, { frames: n, phase: 7 + step });
      for (let i = 0; i < n; i++) expect(frameOf(a, (i + 1) % n)).toEqual(frameOf(b, i));
      expect(frameOf(a, n - 1)).not.toEqual(frameOf(a, 0));
    }
  });

  it('wraps smoothly: the last-to-first step is no bigger than the biggest inner step', () => {
    const r = idleBreathe.generate(rigA, { frames: 12, amplitude: 4, chestTilt: 6, armSway: 12 });
    const n = r.frames.length;
    for (const name of ['torso', 'head', 'upper_arm_l']) {
      const v = r.frames.map((f) => angleOf(f, name));
      const inner = Math.max(...v.slice(1).map((x, i) => Math.abs(x - must(v[i]))));
      expect(Math.abs(must(v[0]) - must(v[n - 1])), name).toBeLessThanOrEqual(inner);
    }
    const y = r.frames.map((f) => f.boneKeys[bid('torso')]?.offset?.y ?? 0);
    const inner = Math.max(...y.slice(1).map((v, i) => Math.abs(v - must(y[i]))));
    expect(Math.abs(must(y[0]) - must(y[n - 1]))).toBeLessThanOrEqual(inner);
  });

  it('with amplitude and every angle 0 nothing moves', () => {
    const r = idleBreathe.generate(rigA, { amplitude: 0, chestTilt: 0, headTilt: 0, armSway: 0 });
    for (const f of r.frames) {
      expect(f.boneKeys[bid('torso')]).toEqual({ angle: 0, offset: { x: 0, y: 0 } });
      expect(angleOf(f, 'head')).toBe(0);
    }
  });

  it('uses names, not ids, and needs only the torso', () => {
    const t = humanoidSide(SETS.default48);
    const other = rigOf({ ...t, bones: [...t.bones].reverse() }, (n) => `bon_x_${n}` as BoneId);
    const a = idleBreathe.generate(rigA);
    const b = idleBreathe.generate(other);
    expect(b.frames.map((f) => Object.keys(f.boneKeys).length)).toEqual(
      a.frames.map((f) => Object.keys(f.boneKeys).length),
    );
    b.frames.forEach((f, i) => {
      expect(f.boneKeys[`bon_x_torso` as BoneId]).toEqual(frameOf(a, i).boneKeys[bid('torso')]);
    });
    const torsoOnly = rigOf({
      ...t,
      bones: t.bones.filter((x) => x.name === 'torso' || x.name === 'root' || x.name === 'pelvis'),
    });
    expect(Object.keys(idleBreathe.generate(torsoOnly).frames[0]?.boneKeys ?? {})).toHaveLength(1);
    const noTorso = rigOf({ ...t, bones: t.bones.filter((x) => x.name !== 'torso') });
    expect(errorCode(() => idleBreathe.generate(noTorso))).toBe('UNKNOWN_BONE');
  });

  it('rejects bad parameters', () => {
    for (const bad of [
      { frames: 3 },
      { frames: 8.5 },
      { amplitude: 7 },
      { amplitude: 1.5 },
      { chestTilt: -1 },
      { phase: 100 },
      { angleQuantum: 0.1 },
      { nope: 1 },
      { frames: Number.NaN },
    ]) {
      expect(errorCode(() => idleBreathe.generate(rigA, bad))).toMatch(/BAD_VALUE|BAD_QUANTUM/);
    }
  });
});

describe('swing', () => {
  const split = (r: PresetResult): { a: number; e: number } => {
    const n = r.frames.length;
    const pa = param(r.params, 'anticipationPercent');
    const ps = param(r.params, 'strikePercent');
    const a = Math.min(n - 3, Math.max(1, Math.round((pa * (n - 1)) / 100)));
    const e = Math.min(n - 2, Math.max(a + 1, Math.round(((pa + ps) * (n - 1)) / 100)));
    return { a, e };
  };

  it('is registered, a once clip, with documented parameters', () => {
    expect(PRESET_NAMES).toContain('swing');
    expect(getPreset('swing')).toBe(swing);
    for (const spec of Object.values(SWING_PARAMS)) {
      expect(spec.description.length).toBeGreaterThan(5);
    }
    const r = swing.generate(rigA);
    expect(r.preset).toBe('swing');
    expect(r.loop).toBe('once');
    expect(r.frames).toHaveLength(8);
    expect(Object.keys(r.params).sort()).toEqual(Object.keys(SWING_PARAMS).sort());
  });

  it('writes plain FK keys, none on the pelvis or the legs; the legs stay put', () => {
    for (const { set, params } of SWING_CASES) {
      const rig = must(rigs[set]);
      const r = swing.generate(rig, params);
      checkFk(r);
      for (const f of r.frames) {
        for (const name of LEG_BONES) {
          expect(f.boneKeys[bid(name)], name).toBeUndefined();
          expect(pivot(rig, r, f, name)).toEqual(pivot(rig, r, undefined, name));
        }
      }
    }
  });

  it('has the three phases in order, split at the spec indices', () => {
    for (const { set, params } of SWING_CASES) {
      const r = swing.generate(must(rigs[set]), params);
      const { a, e } = split(r);
      expect(a).toBeGreaterThanOrEqual(1);
      expect(e).toBeGreaterThan(a);
      expect(e).toBeLessThanOrEqual(r.frames.length - 2);
      r.frames.forEach((f, i) => {
        const want = i < a ? 'anticipation' : i < e ? 'strike' : 'follow-through';
        expect(f.labels.phase, `${set} frame ${String(i)}`).toBe(want);
      });
    }
  });

  it('hits the keyframes: rest, wind-up peak, strike end, follow-through end (upper arm, torso)', () => {
    for (const { params } of SWING_CASES) {
      const side = params.side === 1 ? 'l' : 'r';
      const r = swing.generate(rigA, params);
      const q = r.angleQuantum;
      const { a, e } = split(r);
      const raise = param(r.params, 'raise');
      const reach = param(r.params, 'reach');
      const follow = param(r.params, 'follow');
      const twist = param(r.params, 'twist');
      const up = (i: number): number => angleOf(frameOf(r, i), `upper_arm_${side}`);
      const torso = (i: number): number => angleOf(frameOf(r, i), 'torso');
      expect(up(0)).toBe(0);
      expect(torso(0)).toBe(0);
      expect(up(a)).toBe(quantizeAngle(-raise, q));
      expect(up(e)).toBe(quantizeAngle(-reach, q));
      expect(up(r.frames.length - 1)).toBe(quantizeAngle(-(reach + follow), q));
      expect(torso(a)).toBe(quantizeAngle(-twist, q));
      expect(torso(e)).toBe(quantizeAngle(twist, q));
      expect(torso(r.frames.length - 1)).toBe(quantizeAngle(1.5 * twist, q));
      // Monotone inside each phase (the arm lifts, sweeps down, then carries on).
      for (let i = 1; i <= a; i++) expect(up(i)).toBeLessThanOrEqual(up(i - 1));
      for (let i = a + 1; i <= e; i++) expect(up(i)).toBeGreaterThanOrEqual(up(i - 1));
      for (let i = e + 1; i < r.frames.length; i++) expect(up(i)).toBeLessThanOrEqual(up(i - 1));
    }
  });

  it('is fastest in the strike (the biggest per-frame arm turn)', () => {
    for (const frames of [8, 12, 24]) {
      const r = swing.generate(rigA, { frames });
      const { a, e } = split(r);
      const step = (i: number): number =>
        Math.abs(angleOf(frameOf(r, i), 'upper_arm_r') - angleOf(frameOf(r, i - 1), 'upper_arm_r'));
      const all = r.frames.slice(1).map((_, i) => step(i + 1));
      const strike = Math.max(...Array.from({ length: e - a }, (_, i) => step(a + 1 + i)));
      expect(strike).toBe(Math.max(...all));
    }
  });

  it('moves the hand through the FK: above the shoulder at the wind-up, in front and below at the strike', () => {
    const r = swing.generate(rigA);
    const { a, e } = split(r);
    const shoulder = pivot(rigA, r, undefined, 'upper_arm_r');
    const handAt = (i: number) => pivot(rigA, r, frameOf(r, i), 'hand_r');
    expect(handAt(0).y).toBeGreaterThan(shoulder.y); // hangs below
    expect(handAt(a).y).toBeLessThan(shoulder.y); // raised over the shoulder
    expect(handAt(e).x).toBeGreaterThan(shoulder.x); // in front
    expect(handAt(e).y).toBeGreaterThan(shoulder.y); // below the shoulder
    // The head and the other arm counter-move.
    const f = frameOf(r, a);
    expect(angleOf(f, 'head')).toBeGreaterThan(0);
    expect(angleOf(f, 'upper_arm_l')).toBeGreaterThan(0);
    expect(angleOf(f, 'upper_arm_r')).toBeLessThan(0);
  });

  it('side 1 swings the left arm', () => {
    const l = swing.generate(rigA, { side: 1 });
    const r = swing.generate(rigA, { side: 0 });
    expect(l.frames.map((f) => angleOf(f, 'upper_arm_l'))).toEqual(
      r.frames.map((f) => angleOf(f, 'upper_arm_r')),
    );
    expect(l.frames.map((f) => f.labels.arm)).toEqual(l.frames.map(() => 'left'));
  });

  it('rejects bad parameters and rigs', () => {
    for (const bad of [
      { side: 2 },
      { side: 0.5 },
      { frames: 3 },
      { anticipationPercent: 9 },
      { anticipationPercent: 60, strikePercent: 30 },
      { raise: 10 },
      { reach: 130 },
      { nope: 1 },
    ]) {
      expect(errorCode(() => swing.generate(rigA, bad))).toBe('BAD_VALUE');
    }
    const t = humanoidSide(SETS.default48);
    const noArm = rigOf({
      ...t,
      bones: t.bones.filter((b) => b.name !== 'lower_arm_r' && b.name !== 'hand_r'),
    });
    expect(errorCode(() => swing.generate(noArm))).toBe('UNKNOWN_BONE');
    expect(swing.generate(noArm, { side: 1 }).frames).toHaveLength(8);
  });
});

describe('E3.2a: determinism (ADR-010)', () => {
  function table(): unknown[] {
    const out: unknown[] = [];
    for (const [preset, cases] of [
      [idleBreathe, IDLE_CASES],
      [swing, SWING_CASES],
    ] as const) {
      for (const { set, params } of cases) {
        const r = preset.generate(must(rigs[set]), params);
        out.push([
          preset.name,
          set,
          r.params,
          r.frames.map((f) => [f.boneKeys, f.rootMotion, f.labels]),
        ]);
      }
    }
    return out;
  }
  const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

  it('gives the same result every time', () => {
    expect(table()).toEqual(table());
  });

  it('matches the committed hash of the case tables', () => {
    // Pinned on macOS (2026-11-02); CI must reproduce it on Linux (ADR-010).
    expect(hash(table())).toBe('15ade9a63540bf673aa9835295db4054e2b95190d85714cbd68e4f558e5e4773');
  });

  it('uses no Math trig, no Math.sqrt, no Math.random and no clock', () => {
    const before = hash(table());
    for (const n of [
      'random',
      'sin',
      'cos',
      'tan',
      'atan',
      'atan2',
      'sqrt',
      'hypot',
      'pow',
      'exp',
      'log',
    ] as const) {
      vi.spyOn(Math, n).mockImplementation(() => {
        throw new Error(`Math.${n} called by a preset`);
      });
    }
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now called by a preset');
    });
    expect(hash(table())).toBe(before);
  });
});
