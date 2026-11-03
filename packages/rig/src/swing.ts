/**
 * The `swing` motion preset (FR-RIG-15): an arm (or held weapon) swing as plain FK keys, played once.
 *
 * **Model.** Side view, the character faces +x, the arm hangs at rest. "Forward" below is the angle in
 * degrees from straight down, towards +x; an upper-arm key is its negative (keys are clockwise).
 * The clip has three phases, split at two key frames (integers, so the peaks are real frames):
 *
 * 1. **anticipation** (frames `0 .. a − 1`): the arm lifts to `raise` forward degrees (past 180 is
 *    over the head and back), the elbow bends by `elbowBend`, the wrist cocks, the torso leans back
 *    by `twist`. Smoothstep.
 * 2. **strike** (frames `a .. e − 1`): the arm sweeps down to `reach` forward degrees, the elbow
 *    straightens, the torso comes forward by `twist` past its start. Quadratic ease-in (it accelerates).
 * 3. **follow-through** (frames `e .. n − 1`): the arm carries on by `follow` more degrees and settles,
 *    the torso adds half of `twist`. Quadratic ease-out.
 *
 * `a = round(anticipationPercent · (n − 1) / 100)` limited to `1 .. n − 3`, and
 * `e = round((anticipationPercent + strikePercent) · (n − 1) / 100)` limited to `a + 1 .. n − 2`, so each
 * phase has at least one frame, frame `a` is the peak of the wind-up and frame `e` the end of the strike.
 * The head counter-rotates by half the torso angle, the other arm swings the opposite way by a quarter.
 * The legs get no key. `loop` is `once`: the last frame is the end of the follow-through.
 *
 * All easing is integer (Q16), so there is no floating-point trig (ADR-010, ADR-012).
 * @packageDocumentation
 */
import type { BoneId, BoneKey } from '@pixel-forge/schema';
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
  presetContext,
  resolveParams,
} from './preset.js';

const COMMON = commonParams(8);

/** Parameters of {@link swing}. */
export const SWING_PARAMS: PresetParamSpecs = {
  ...(COMMON.frames === undefined ? {} : { frames: COMMON.frames }),
  ...(COMMON.angleQuantum === undefined ? {} : { angleQuantum: COMMON.angleQuantum }),
  side: {
    kind: 'int',
    min: 0,
    max: 1,
    default: 0,
    description: 'The swinging arm: 0 the right arm (`*_r`), 1 the left arm (`*_l`)',
  },
  raise: {
    kind: 'number',
    min: 30,
    max: 270,
    default: 190,
    description:
      'Degrees forward of straight down the upper arm reaches at the top of the wind-up (180 is straight up)',
  },
  reach: {
    kind: 'number',
    min: 0,
    max: 120,
    default: 45,
    description: 'Degrees forward of straight down the upper arm has at the end of the strike',
  },
  follow: {
    kind: 'number',
    min: 0,
    max: 90,
    default: 30,
    description: 'Degrees the upper arm carries on past the strike',
  },
  twist: {
    kind: 'number',
    min: 0,
    max: 45,
    default: 12,
    description:
      'Degrees the torso leans back in the wind-up (and forward by the same in the strike)',
  },
  elbowBend: {
    kind: 'number',
    min: 0,
    max: 120,
    default: 40,
    description: 'Degrees the elbow bends at the top of the wind-up',
  },
  wrist: {
    kind: 'number',
    min: 0,
    max: 60,
    default: 20,
    description: 'Degrees the hand cocks back in the wind-up (and snaps forward by the same)',
  },
  anticipationPercent: {
    kind: 'int',
    min: 10,
    max: 60,
    default: 35,
    description: 'Percent of the clip (first to last frame) before the strike starts',
  },
  strikePercent: {
    kind: 'int',
    min: 10,
    max: 50,
    default: 25,
    description: 'Percent of the clip the strike lasts; the rest is the follow-through',
  },
};

/** Q16 smoothstep `3u² − 2u³`, `u = num / den`. */
function smooth(num: number, den: number): number {
  return divRound(65536 * (3 * num * num * den - 2 * num * num * num), den * den * den);
}
/** Q16 ease-in `u²`. */
function easeIn(num: number, den: number): number {
  return divRound(65536 * num * num, den * den);
}
/** Q16 ease-out `1 − (1 − u)²`. */
function easeOut(num: number, den: number): number {
  return 65536 - divRound(65536 * (den - num) * (den - num), den * den);
}

function generate(rig: PresetRig, input: PresetParams = {}): PresetResult {
  const p = resolveParams(SWING_PARAMS, input);
  const n = param(p, 'frames');
  const quantum = param(p, 'angleQuantum');
  const pa = param(p, 'anticipationPercent');
  const ps = param(p, 'strikePercent');
  if (pa + ps > 85) {
    throw new RigError(
      'BAD_VALUE',
      'swing: anticipationPercent + strikePercent must be at most 85 (the follow-through needs time)',
    );
  }
  const s = param(p, 'side') === 0 ? 'r' : 'l';
  const o = s === 'r' ? 'l' : 'r';
  const ctx = presetContext(rig, ['torso', `upper_arm_${s}`, `lower_arm_${s}`], quantum);
  const a = Math.min(n - 3, Math.max(1, divRound(pa * (n - 1), 100)));
  const e = Math.min(n - 2, Math.max(a + 1, divRound((pa + ps) * (n - 1), 100)));
  const raise = param(p, 'raise');
  const reach = param(p, 'reach');
  const follow = param(p, 'follow');
  const twist = param(p, 'twist');
  const elbow = param(p, 'elbowBend');
  const wrist = param(p, 'wrist');
  const lerp = (x: number, y: number, q16: number): number => (x * (65536 - q16) + y * q16) / 65536;
  const q = (deg: number): number => quantizeAngle(deg, quantum) + 0;

  const frames: PresetFrame[] = [];
  for (let f = 0; f < n; f++) {
    let upper: number;
    let lower: number;
    let hand: number;
    let torso: number;
    let label: string;
    if (f < a) {
      const k = smooth(f, a);
      upper = lerp(0, -raise, k);
      lower = lerp(0, -elbow, k);
      hand = lerp(0, wrist, k);
      torso = lerp(0, -twist, k);
      label = 'anticipation';
    } else if (f < e) {
      const k = easeIn(f - a, e - a);
      upper = lerp(-raise, -reach, k);
      lower = lerp(-elbow, 0, k);
      hand = lerp(wrist, -wrist, k);
      torso = lerp(-twist, twist, k);
      label = 'strike';
    } else {
      const k = easeOut(f - e, n - 1 - e);
      upper = lerp(-reach, -(reach + follow), k);
      lower = lerp(0, -elbow / 4, k);
      hand = lerp(-wrist, 0, k);
      torso = lerp(twist, twist * 1.5, k);
      label = 'follow-through';
    }
    const keys: Partial<Record<BoneId, BoneKey>> = {};
    keys[ctx.id(`upper_arm_${s}`)] = { angle: q(upper) };
    keys[ctx.id(`lower_arm_${s}`)] = { angle: q(lower) };
    if (ctx.has(`hand_${s}`)) keys[ctx.id(`hand_${s}`)] = { angle: q(hand) };
    keys[ctx.id('torso')] = { angle: q(torso) };
    if (ctx.has('head')) keys[ctx.id('head')] = { angle: q(-q(torso) / 2) };
    if (ctx.has(`upper_arm_${o}`)) keys[ctx.id(`upper_arm_${o}`)] = { angle: q(-q(upper) / 4) };
    frames.push({
      boneKeys: keys,
      rootMotion: { dx: 0, dy: 0 },
      labels: { phase: label, arm: s === 'r' ? 'right' : 'left' },
    });
  }
  return { preset: 'swing', loop: 'once', angleQuantum: quantum, params: p, frames };
}

/** The arm swing preset (FR-RIG-15). */
export const swing: Preset = {
  name: 'swing',
  summary:
    'One arm or weapon swing: anticipation, strike, follow-through, with torso twist and head counter-motion',
  loop: 'once',
  params: SWING_PARAMS,
  generate,
};
