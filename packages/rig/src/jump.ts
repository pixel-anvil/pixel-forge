/**
 * The `jump` motion preset (FR-RIG-15): a side-view standing jump as plain FK keys, played once
 * (`loop: 'once'`, so the keys do not interpolate across the wrap).
 *
 * **Timeline.** Frame `f` of `n` is at `u = 100 f / (n − 1)` percent of the animation (frame 0 is 0%,
 * the last frame 100%; exact rationals, no float time). Seven phases, each at least one frame long for
 * `n ≥ 10`, with the boundaries {@link JUMP_PHASES}:
 *
 * | phase          | % of time | pelvis offset y (down is +)                                |
 * | -------------- | --------- | ---------------------------------------------------------- |
 * | `anticipation` | 0..25     | 0 to `crouch` (smoothstep), arms swing back, torso leans   |
 * | `pushoff`      | 25..36    | `crouch` to 0 (smoothstep); feet still planted             |
 * | `rise`         | 36..52    | `−height · (2s − s²)`: takes off, slows to the apex        |
 * | `apex`         | 52..62    | `−height`: the hang                                        |
 * | `fall`         | 62..78    | `−height · (1 − s²)`: speeds up to the ground              |
 * | `land`         | 78..90    | 0 to `landDepth` (smoothstep): the legs absorb the landing |
 * | `recover`      | 90..100   | `landDepth` to 0 (smoothstep): stands up                   |
 *
 * `s` is the progress through the phase. Between take-off (36%) and landing (78%) the feet are in the
 * air: their ankle target is the rest ankle plus the pelvis offset (the legs hang straight) lifted by
 * `tuck · sin(π · progress through the flight)` px, so the knees fold at the apex and the legs
 * extend again for the landing. On the ground the ankles are planted on their rest pixels by two-bone
 * IK ({@link placeLeg}), which bends the knees in the crouches. Arms, elbows and the torso follow
 * keyframe tracks (smoothstep between the keys); the head stays level.
 *
 * **Root motion.** `rootMotion.dx` is 0 on every frame unless `travel` is given: then the body moves
 * `travel` px forward during the flight at constant speed (the planted feet are on the same canvas
 * pixels before take-off and after landing, so the ground-contact frames never slide). `dy` is 0: the
 * height is in the pelvis offset.
 *
 * All maths is integer; sine and cosine come from raster's Q16 table (ADR-010).
 * @packageDocumentation
 */
import type { BoneId, BoneKey, Point } from '@pixel-forge/schema';
import { quantizeAngle } from './angle.js';
import { RigError } from './errors.js';
import {
  type Preset,
  type PresetFrame,
  type PresetParamSpecs,
  type PresetParams,
  type PresetResult,
  type PresetRig,
  commonParams,
  divRound,
  param,
  placeLeg,
  presetContext,
  resolveParams,
  restLength,
  scaleInt,
  turnSin,
} from './preset.js';
import type { PoseKey } from './snap.js';
import { clampTo } from './walk.js';

/** The phases of a jump in order, with the percent of the animation at which each one starts. */
export const JUMP_PHASES = [
  { name: 'anticipation', from: 0 },
  { name: 'pushoff', from: 25 },
  { name: 'rise', from: 36 },
  { name: 'apex', from: 52 },
  { name: 'fall', from: 62 },
  { name: 'land', from: 78 },
  { name: 'recover', from: 90 },
] as const;

/** Parameters of {@link jump} (see {@link JUMP_PARAMS}). */
export const JUMP_PARAMS: PresetParamSpecs = {
  frames: {
    kind: 'int',
    min: 10,
    max: 64,
    default: 12,
    description: 'Frames in the whole jump (at least 10 so that every phase has a frame)',
  },
  ...Object.fromEntries(
    Object.entries(commonParams(8)).filter(([name]) => name === 'angleQuantum'),
  ),
  height: {
    kind: 'int',
    min: 1,
    max: 128,
    description:
      'Px the pelvis rises above its rest height at the apex; default 60% of the shorter leg',
  },
  crouch: {
    kind: 'int',
    min: 0,
    max: 64,
    description: 'Px the pelvis drops in the anticipation; default a quarter of the shorter leg',
  },
  landDepth: {
    kind: 'int',
    min: 0,
    max: 64,
    description:
      'Px the pelvis drops when the legs absorb the landing; default the value of crouch',
  },
  tuck: {
    kind: 'int',
    min: 0,
    max: 64,
    description:
      'Px each foot is pulled up towards the body at the middle of the flight (knees fold); default a fifth of the shorter leg',
  },
  travel: {
    kind: 'int',
    min: -256,
    max: 256,
    default: 0,
    description:
      'Px the body travels forward during the flight (root motion dx; 0 is a jump on the spot)',
  },
  armSwing: {
    kind: 'number',
    min: 0,
    max: 90,
    default: 60,
    description:
      'Degrees the upper arms swing back in the anticipation (forward and up in the flight is 140% of it)',
  },
  elbowBend: {
    kind: 'number',
    min: 0,
    max: 120,
    default: 60,
    description: 'Degrees the elbows bend at the most (in the flight)',
  },
  lean: {
    kind: 'number',
    min: -30,
    max: 30,
    default: 15,
    description:
      'Degrees the torso leans forward (clockwise) in the crouches; the head stays level',
  },
};

const REQUIRED = ['pelvis', 'thigh_l', 'shin_l', 'foot_l', 'thigh_r', 'shin_r', 'foot_r'] as const;

/** Phase boundaries in percent: `JUMP_PHASES` starts, then 100. */
const BOUNDS: readonly number[] = [...JUMP_PHASES.map((ph) => ph.from), 100];
const TAKEOFF = 36;
const LANDING = 78;

/** A track of keyframes `[percent of time, value in percent of the amplitude]`. */
type Track = readonly (readonly [number, number])[];

// Positive arm angles swing back, negative forward and up (as in walk).
const ARM_TRACK: Track = [
  [0, 0],
  [25, 100],
  [36, -100],
  [52, -140],
  [62, -140],
  [78, -60],
  [90, 60],
  [100, 0],
];
const ELBOW_TRACK: Track = [
  [0, 20],
  [25, 10],
  [36, 60],
  [52, 100],
  [62, 100],
  [78, 70],
  [90, 30],
  [100, 20],
];
const LEAN_TRACK: Track = [
  [0, 0],
  [25, 100],
  [36, 40],
  [52, 0],
  [62, 0],
  [78, 30],
  [90, 100],
  [100, 0],
];

/** Where frame `f` of `n` sits in the phase it starts or lies in: `num / den` is the progress (exact). */
interface Seg {
  readonly index: number;
  readonly num: number;
  readonly den: number;
}

function segOf(f: number, n: number): Seg {
  const m = n - 1;
  let index = 0;
  for (let i = 0; i < BOUNDS.length - 1; i++) {
    if (100 * f >= (BOUNDS[i] ?? 0) * m) index = i;
  }
  const a = BOUNDS[index] ?? 0;
  const b = BOUNDS[index + 1] ?? 100;
  return { index, num: 100 * f - a * m, den: (b - a) * m };
}

/** `amp · smoothstep(num / den)`, an integer rounded half away from zero (smoothstep `3s² − 2s³`). */
function ease(amp: number, num: number, den: number): number {
  return divRound(amp * (3 * num * num * den - 2 * num * num * num), den * den * den);
}

/** The track's value at frame `f`, degrees: `amp · value% `, smoothstep between keys, quantised. */
function trackAngle(track: Track, f: number, n: number, amp: number, quantum: number): number {
  const m = n - 1;
  let i = 0;
  for (let k = 0; k < track.length - 1; k++) {
    if (100 * f >= (track[k]?.[0] ?? 0) * m) i = k;
  }
  const a = track[i];
  const b = track[i + 1] ?? a;
  if (a === undefined || b === undefined) throw new RigError('BAD_VALUE', 'jump: empty track');
  const den = (b[0] - a[0]) * m;
  const num = 100 * f - a[0] * m;
  const e = divRound(65536 * (3 * num * num * den - 2 * num * num * num), den * den * den);
  const t = a[1] * 65536 + (b[1] - a[1]) * e; // percent · Q16
  return quantizeAngle((amp * t) / (100 * 65536), quantum) + 0;
}

function generate(rig: PresetRig, input: PresetParams = {}): PresetResult {
  const probe = presetContext(rig, REQUIRED, 1);
  const legOf = (side: 'l' | 'r'): number => {
    const hip = probe.restPivot(`thigh_${side}`);
    const knee = probe.restPivot(`shin_${side}`);
    const ankle = probe.restPivot(`foot_${side}`);
    return (
      restLength(knee.x - hip.x, knee.y - hip.y) + restLength(ankle.x - knee.x, ankle.y - knee.y)
    );
  };
  const legLength = Math.min(legOf('l'), legOf('r'));
  if (legLength < 2) throw new RigError('BAD_VALUE', 'jump: the legs are too short');
  const autoCrouch = clampTo(JUMP_PARAMS.crouch, divRound(legLength, 4));
  const first = resolveParams(JUMP_PARAMS, input, {
    height: clampTo(JUMP_PARAMS.height, Math.max(1, divRound(3 * legLength, 5))),
    crouch: autoCrouch,
    landDepth: autoCrouch,
    tuck: clampTo(JUMP_PARAMS.tuck, divRound(legLength, 5)),
  });
  // landDepth follows a given crouch unless it is given itself.
  const p = input.landDepth === undefined ? { ...first, landDepth: param(first, 'crouch') } : first;
  const n = param(p, 'frames');
  const quantum = param(p, 'angleQuantum');
  const height = param(p, 'height');
  const crouch = param(p, 'crouch');
  const landDepth = param(p, 'landDepth');
  const tuck = param(p, 'tuck');
  const travelPx = param(p, 'travel');
  const ctx = presetContext(rig, REQUIRED, quantum);
  const m = n - 1;

  const pelvisDy = (seg: Seg): number => {
    const { num, den } = seg;
    switch (JUMP_PHASES[seg.index]?.name) {
      case 'anticipation':
        return ease(crouch, num, den);
      case 'pushoff':
        return crouch - ease(crouch, num, den);
      case 'rise':
        return -divRound(height * (2 * num * den - num * num), den * den);
      case 'apex':
        return -height;
      case 'fall':
        return -divRound(height * (den * den - num * num), den * den);
      case 'land':
        return ease(landDepth, num, den);
      default:
        return landDepth - ease(landDepth, num, den);
    }
  };

  /** Px of root motion reached by time index `g` (frame boundaries `g = 0..n`): constant speed in flight. */
  const reach = (g: number): number => {
    const den = (LANDING - TAKEOFF) * m;
    const num = Math.min(den, Math.max(0, 100 * g - TAKEOFF * m));
    return divRound(travelPx * num, den);
  };

  const frames: PresetFrame[] = [];
  const planted: Record<'l' | 'r', { x: number; y: number; run: number }[]> = { l: [], r: [] };
  for (let f = 0; f < n; f++) {
    const seg = segOf(f, n);
    const phase = JUMP_PHASES[seg.index]?.name ?? 'recover';
    const air = (phase === 'rise' && seg.num > 0) || phase === 'apex' || phase === 'fall';
    const dy = pelvisDy(seg);
    const keys: Partial<Record<BoneId, BoneKey>> = {};
    const labels: Record<string, string> = { phase };
    keys[ctx.id('pelvis')] = { offset: { x: 0, y: dy } };
    const pose = new Map<BoneId, PoseKey>([[ctx.id('pelvis'), { offset: { x: 0, y: dy } }]]);

    // Progress through the flight 0..1 as num / den (exact), for the tuck.
    const flightDen = (LANDING - TAKEOFF) * m;
    const flightNum = Math.min(flightDen, Math.max(0, 100 * f - TAKEOFF * m));
    const lift = air ? scaleInt(tuck, turnSin(flightNum, 2 * flightDen)) : 0;

    for (const side of ['l', 'r'] as const) {
      const rest = ctx.restPivot(`foot_${side}`);
      const target: Point = { x: rest.x, y: air ? rest.y + dy - lift : rest.y };
      const leg = placeLeg(ctx, pose, side, target, { planted: !air });
      if (!leg.reached) {
        throw new RigError(
          'BAD_VALUE',
          `jump: the ${side === 'l' ? 'left' : 'right'} foot cannot reach (${String(target.x)}, ${String(target.y)}) in frame ${String(f)}; lower crouch, landDepth, height or tuck`,
        );
      }
      if (!air) {
        // Ground contact: before take-off (run 0) or from the landing on (run 1).
        planted[side].push({ x: leg.ankle.x, y: leg.ankle.y, run: 100 * f <= TAKEOFF * m ? 0 : 1 });
      }
      keys[ctx.id(`thigh_${side}`)] = { angle: leg.thigh };
      keys[ctx.id(`shin_${side}`)] = { angle: leg.shin };
      keys[ctx.id(`foot_${side}`)] = { angle: leg.foot };
      labels[`foot_${side}`] = air ? 'air' : 'ground';
      if (ctx.has(`upper_arm_${side}`)) {
        keys[ctx.id(`upper_arm_${side}`)] = {
          angle: trackAngle(ARM_TRACK, f, n, param(p, 'armSwing'), quantum),
        };
      }
      if (ctx.has(`lower_arm_${side}`)) {
        keys[ctx.id(`lower_arm_${side}`)] = {
          angle: trackAngle(ELBOW_TRACK, f, n, -param(p, 'elbowBend'), quantum),
        };
      }
    }
    if (ctx.has('torso')) {
      keys[ctx.id('torso')] = { angle: trackAngle(LEAN_TRACK, f, n, param(p, 'lean'), quantum) };
    }
    if (ctx.has('head')) {
      keys[ctx.id('head')] = { angle: trackAngle(LEAN_TRACK, f, n, -param(p, 'lean'), quantum) };
    }
    frames.push({ boneKeys: keys, rootMotion: { dx: reach(f + 1) - reach(f) + 0, dy: 0 }, labels });
  }

  // A planted foot must stay within 1 px over each contact (before take-off, after landing).
  for (const side of ['l', 'r'] as const) {
    for (const run of [0, 1]) {
      const pts = planted[side].filter((q) => q.run === run);
      for (const axis of ['x', 'y'] as const) {
        const vs = pts.map((q) => q[axis]);
        if (vs.length > 0 && Math.max(...vs) - Math.min(...vs) > 1) {
          throw new RigError(
            'BAD_VALUE',
            `jump: the planted ${side === 'l' ? 'left' : 'right'} foot slides more than 1 px at angleQuantum ${String(quantum)}; use a finer angleQuantum, or lower crouch and landDepth`,
          );
        }
      }
    }
  }
  return { preset: 'jump', loop: 'once', angleQuantum: quantum, params: p, frames };
}

/** The side-view jump preset (FR-RIG-15): crouch, push off, rise, apex, fall, land, recover; plays once. */
export const jump: Preset = {
  name: 'jump',
  summary:
    'Side-view standing jump, played once: crouch, push-off, rise, apex hang, fall, landing absorb, recover; the pelvis offset carries the height',
  loop: 'once',
  params: JUMP_PARAMS,
  generate,
};
