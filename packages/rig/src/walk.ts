/**
 * The `walk` motion preset (FR-RIG-15): a side-view walk cycle as plain FK keys.
 *
 * **Model.** The character faces +x and stays on the spot; the ground moves under it, which is what
 * `Frame.rootMotion` records (the root's displacement during the frame, FR-ANIM-08). One foot is
 * planted for `stancePercent` of the cycle and travels `strideLength` px relative to the body while it
 * is. The body therefore moves `strideLength · 100 / stancePercent` px per cycle, at a constant speed.
 * The left foot runs half a cycle after the right one. Time is exact: frame `f` of a cycle of `n`
 * frames is at `100 f + phase · n` units of a `100 n` unit cycle, and the sine and cosine come from
 * raster's Q16 table (no floating-point trig, ADR-010, ADR-012).
 *
 * **Feet.** The target of an ankle is a canvas pixel. In stance it is `G − B(f)`, where `B` is the
 * (integer) distance the body has travelled by frame `f` and `G` the ground position of this step, so
 * `ankle.x + B` is constant over the stance: the foot does not slide. In swing the ankle eases from the
 * last stance position to the next touchdown with a sine lift. Two-bone IK (E1.1, {@link placeLeg})
 * turns each target into thigh and shin angles, the foot key keeps the foot flat. Only the angles are
 * kept: the output is FK.
 *
 * **Body.** The pelvis dips by `bob` px at touchdown (0% and 50% of the cycle, the contact poses,
 * whatever the stance percentage) and is highest a quarter cycle later (two bobs per cycle), so the
 * legs can reach: the stride is limited by the leg length and the bob (`RigError('BAD_VALUE')` when a
 * foot cannot be reached, or cannot stay planted within 1 px at the angle quantum). The arms swing against the legs: the arm
 * on the side of the forward leg is back. The torso leans by `lean` degrees and the head stays level.
 *
 * **Loop.** Frame `n` would be frame 0: every quantity is periodic in the frame index, so the last
 * frame is one step before frame 0 and no frame is duplicated.
 * @packageDocumentation
 */
import type { BoneId, BoneKey, Point } from '@pixel-forge/schema';
import { RigError } from './errors.js';
import {
  CYCLE_UNITS,
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
  scaleAngle,
  scaleInt,
  turnCos,
  turnSin,
} from './preset.js';
import type { PoseKey } from './snap.js';

/** Parameters of {@link walk} (see {@link WALK_PARAMS}). */
export const WALK_PARAMS: PresetParamSpecs = {
  ...commonParams(8),
  strideLength: {
    kind: 'int',
    min: 1,
    max: 256,
    description:
      'Px a planted foot travels relative to the body (the step span); default half the shorter leg',
  },
  stancePercent: {
    kind: 'int',
    min: 50,
    max: 90,
    default: 60,
    description:
      'Percent of the cycle one foot is on the ground (above 50: both feet down for a while)',
  },
  bob: {
    kind: 'int',
    min: 0,
    max: 32,
    description:
      'Px the pelvis dips at touchdown (peak to peak); default the smallest dip from a tenth of the shorter leg (at least 1) with which the feet reach and stay planted',
  },
  lift: {
    kind: 'int',
    min: 0,
    max: 64,
    description: 'Px the swinging foot rises; default a fifth of the shorter leg',
  },
  armSwing: {
    kind: 'number',
    min: 0,
    max: 90,
    default: 25,
    description: 'Degrees each upper arm swings either side of hanging straight',
  },
  elbowBend: {
    kind: 'number',
    min: 0,
    max: 120,
    default: 15,
    description: 'Degrees the elbow bends at the forward end of the arm swing',
  },
  lean: {
    kind: 'number',
    min: -30,
    max: 30,
    default: 3,
    description: 'Degrees the torso leans forward (clockwise); the head stays level',
  },
};

const REQUIRED = ['pelvis', 'thigh_l', 'shin_l', 'foot_l', 'thigh_r', 'shin_r', 'foot_r'] as const;

/** Where a foot is in one frame. */
export interface FootStep {
  readonly x: number;
  readonly y: number;
  readonly stance: boolean;
}

export interface FootPlanInput {
  readonly frames: number;
  readonly stancePercent: number;
  /** Phase offset of this foot in units (`0 .. 100 · frames − 1`). */
  readonly offset: number;
  readonly stride: number;
  /** The animation's clock: the right foot's offset in units. */
  readonly bodyOffset: number;
  readonly restX: number;
  readonly groundY: number;
  readonly lift: number;
}

/**
 * Px the body has travelled by frame `fe` (any `fe ≥ 0`). A function of the cycle time of the whole
 * animation (`100 fe + offset` units, offset = the right foot's), so shifting `phase` shifts every
 * value with it. Periodic: one cycle always adds the same `cycle` px.
 */
export function travel(
  frames: number,
  stride: number,
  stancePercent: number,
  offset: number,
  fe: number,
): number {
  const cycleUnits = CYCLE_UNITS * frames;
  const cycle = divRound(stride * 100, stancePercent);
  const t = CYCLE_UNITS * fe + offset;
  return (
    Math.floor(t / cycleUnits) * cycle + divRound(stride * (t % cycleUnits), stancePercent * frames)
  );
}

/** The canvas targets of one ankle over a cycle. */
export function footPlan(a: FootPlanInput): FootStep[] {
  const { frames: n, stancePercent: pct, offset } = a;
  const cycleUnits = CYCLE_UNITS * n;
  const isStance = (fe: number): boolean => (CYCLE_UNITS * fe + offset) % cycleUnits < pct * n;
  const body = (fe: number): number => travel(n, a.stride, pct, a.bodyOffset, fe);
  for (let f = 0; f < n; f++) {
    if (!isStance(f)) break;
    if (f === n - 1) {
      throw new RigError('BAD_VALUE', 'walk: stancePercent leaves no swing frame; add frames');
    }
  }
  // The middle cycle of three: a run of stance frames (at most n - 1 long) never leaves [0, 3n).
  const stanceX = (fe: number): number => {
    let lo = fe;
    while (isStance(lo - 1)) lo--;
    let hi = fe;
    while (isStance(hi + 1)) hi++;
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += body(k);
    return a.restX + divRound(sum, hi - lo + 1) - body(fe);
  };
  const out: FootStep[] = [];
  for (let f = 0; f < n; f++) {
    const fe = n + f;
    if (isStance(fe)) {
      out.push({ x: stanceX(fe), y: a.groundY, stance: true });
      continue;
    }
    let fa = fe;
    while (!isStance(fa)) fa--;
    let fb = fe;
    while (!isStance(fb)) fb++;
    const xa = stanceX(fa);
    const xb = stanceX(fb);
    const num = fe - fa;
    const den = fb - fa;
    // Smoothstep 3s² − 2s³ with s = num / den, exactly.
    const ease = 3 * num * num * den - 2 * num * num * num;
    const x = xa + divRound((xb - xa) * ease, den * den * den);
    const rise = scaleInt(a.lift, turnSin(num, 2 * den));
    out.push({ x, y: a.groundY - rise, stance: false });
  }
  return out;
}

/** `v` limited to the range of a parameter spec. */
export function clampTo(spec: PresetParamSpecs[string] | undefined, v: number): number {
  if (spec === undefined) return v;
  return Math.min(spec.max, Math.max(spec.min, v));
}

/**
 * The largest spread of `ankle.x + B` over a run of planted frames, for one foot. The cycle is
 * unrolled three times and the runs that touch its ends are skipped, so a run that wraps the cycle
 * boundary is measured whole. `B` is the body travel (the sum of the root motion).
 */
export function worstSlide(
  xs: readonly number[],
  plan: readonly FootStep[],
  body: (fe: number) => number,
): number {
  const n = plan.length;
  let worst = 0;
  let lo = 0;
  let hi = 0;
  let open = false;
  let touchesStart = false;
  for (let fe = 0; fe <= 3 * n; fe++) {
    const planted = fe < 3 * n && plan[fe % n]?.stance === true;
    if (planted) {
      const v = (xs[fe % n] ?? 0) + body(fe);
      if (!open) {
        open = true;
        touchesStart = fe === 0;
        lo = v;
        hi = v;
      } else {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      continue;
    }
    if (open && !touchesStart && fe < 3 * n) worst = Math.max(worst, hi - lo);
    open = false;
  }
  return worst;
}

function generate(rig: PresetRig, input: PresetParams = {}): PresetResult {
  // Auto defaults come from the shorter leg of the rest pose (so both can reach); the quantum does
  // not change a rest pivot.
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
  if (legLength < 2) throw new RigError('BAD_VALUE', 'walk: the legs are too short');
  // An auto default is kept inside the range of its spec, so a tall rig never fails on a value the
  // caller did not give (a value the caller gives is checked as it is).
  const autoStride = clampTo(WALK_PARAMS.strideLength, Math.max(2, divRound(legLength, 2)));
  const autoLift = clampTo(WALK_PARAMS.lift, Math.max(1, divRound(legLength, 5)));
  const firstBob = clampTo(WALK_PARAMS.bob, Math.max(1, divRound(legLength, 10)));
  const p = resolveParams(WALK_PARAMS, input, {
    strideLength: autoStride,
    bob: firstBob, // replaced below by the smallest dip that works when the caller gave none
    lift: autoLift,
  });
  const n = param(p, 'frames');
  const quantum = param(p, 'angleQuantum');
  const stride = param(p, 'strideLength');
  const pct = param(p, 'stancePercent');
  const ctx = presetContext(rig, REQUIRED, quantum);

  const cycleUnits = CYCLE_UNITS * n;
  const offsetR = param(p, 'phase') * n;
  const offsetL = (offsetR + 50 * n) % cycleUnits; // the left foot runs half a cycle behind
  const plans = {
    r: footPlan({
      frames: n,
      stancePercent: pct,
      offset: offsetR,
      stride,
      bodyOffset: offsetR,
      restX: ctx.restPivot('foot_r').x,
      groundY: ctx.restPivot('foot_r').y,
      lift: param(p, 'lift'),
    }),
    l: footPlan({
      frames: n,
      stancePercent: pct,
      offset: offsetL,
      stride,
      bodyOffset: offsetR,
      restX: ctx.restPivot('foot_l').x,
      groundY: ctx.restPivot('foot_l').y,
      lift: param(p, 'lift'),
    }),
  };
  const offsets = { r: offsetR, l: offsetL };
  const body = (fe: number): number => travel(n, stride, pct, offsetR, fe);
  const sideName = (side: 'l' | 'r'): string => (side === 'l' ? 'left' : 'right');

  /**
   * The frames for a pelvis dip of `bob` px. Throws `RigError('BAD_VALUE')` when a foot is out of
   * reach, a planted foot is off the ground row, or a planted foot slides more than 1 px.
   */
  const build = (bob: number): PresetFrame[] => {
    const frames: PresetFrame[] = [];
    const ankleXs: Record<'l' | 'r', number[]> = { l: [], r: [] };
    for (let f = 0; f < n; f++) {
      const keys: Partial<Record<BoneId, BoneKey>> = {};
      const labels: Record<string, string> = {};
      // Pelvis: lowest at touchdown (the right foot's at 0% of the cycle, the left foot's at 50%),
      // highest a quarter cycle later: two bobs per cycle, whatever the stance percentage. Time is
      // the right foot's: `tR` units into the cycle.
      const tR = (CYCLE_UNITS * f + offsetR) % cycleUnits;
      const bobCos = turnCos(2 * tR, cycleUnits);
      const dy = divRound(bob * (65536 + bobCos), 131072);
      keys[ctx.id('pelvis')] = { offset: { x: 0, y: dy } };
      const pose = new Map<BoneId, PoseKey>([[ctx.id('pelvis'), { offset: { x: 0, y: dy } }]]);

      for (const side of ['l', 'r'] as const) {
        const step = plans[side][f];
        if (step === undefined) throw new RigError('BAD_VALUE', 'walk: frame out of range');
        const target: Point = { x: step.x, y: step.y };
        const leg = placeLeg(ctx, pose, side, target, { planted: step.stance });
        if (!leg.reached) {
          throw new RigError(
            'BAD_VALUE',
            `walk: with bob ${String(bob)} the ${sideName(side)} foot cannot reach (${String(target.x)}, ${String(target.y)}) in frame ${String(f)}; shorten strideLength or raise bob`,
          );
        }
        ankleXs[side].push(leg.ankle.x);
        keys[ctx.id(`thigh_${side}`)] = { angle: leg.thigh };
        keys[ctx.id(`shin_${side}`)] = { angle: leg.shin };
        keys[ctx.id(`foot_${side}`)] = { angle: leg.foot };
        labels[`foot_${side}`] = step.stance ? 'stance' : 'swing';

        // Arms: contralateral. Turns of this side's leg cycle; the arm is back (+) at touchdown.
        const t = (CYCLE_UNITS * f + offsets[side]) % cycleUnits;
        const c = turnCos(t, cycleUnits);
        if (ctx.has(`upper_arm_${side}`)) {
          keys[ctx.id(`upper_arm_${side}`)] = {
            angle: scaleAngle(param(p, 'armSwing'), c, quantum),
          };
        }
        if (ctx.has(`lower_arm_${side}`)) {
          keys[ctx.id(`lower_arm_${side}`)] = {
            angle: scaleAngle(-param(p, 'elbowBend') / 2, 65536 - c, quantum),
          };
        }
      }
      const lean = param(p, 'lean');
      if (ctx.has('torso')) keys[ctx.id('torso')] = { angle: scaleAngle(lean, 65536, quantum) };
      if (ctx.has('head')) keys[ctx.id('head')] = { angle: scaleAngle(-lean, 65536, quantum) };

      const dx =
        travel(n, stride, pct, offsetR, n + f + 1) - travel(n, stride, pct, offsetR, n + f);
      frames.push({ boneKeys: keys, rootMotion: { dx, dy: 0 }, labels });
    }
    // The planted foot must not slide beyond 1 px, in every case.
    for (const side of ['l', 'r'] as const) {
      const slide = worstSlide(ankleXs[side], plans[side], body);
      if (slide > 1) {
        throw new RigError(
          'BAD_VALUE',
          `walk: with bob ${String(bob)} the planted ${sideName(side)} foot slides ${String(slide)} px (at most 1) at angleQuantum ${String(quantum)}; use a finer angleQuantum, or change strideLength or bob`,
        );
      }
    }
    return frames;
  };

  const max = WALK_PARAMS.bob?.max ?? 32;
  const bobGiven = input.bob !== undefined;
  let frames: PresetFrame[] | undefined;
  if (bobGiven) {
    frames = build(param(p, 'bob'));
  } else {
    // No bob given: the smallest dip from a tenth of the leg length (at least 1 px) up to the
    // maximum with which every foot is reached and no planted foot slides; each candidate is built once.
    for (let bob = firstBob; bob <= max && frames === undefined; bob++) {
      try {
        frames = build(bob);
        p.bob = bob;
      } catch (e) {
        if (!(e instanceof RigError) || e.code !== 'BAD_VALUE') throw e;
      }
    }
    if (frames === undefined) {
      throw new RigError(
        'BAD_VALUE',
        `walk: no bob from ${String(firstBob)} to ${String(max)} lets both feet reach and keep the planted foot within 1 px at angleQuantum ${String(quantum)}; use a finer angleQuantum, or shorten strideLength`,
      );
    }
  }
  return { preset: 'walk', loop: 'loop', angleQuantum: quantum, params: p, frames };
}

/** The side-view walk preset (FR-RIG-15). */
export const walk: Preset = {
  name: 'walk',
  summary:
    'Side-view walk cycle: planted feet by IK, pelvis bob, contralateral arm swing, left foot half a cycle after the right',
  loop: 'loop',
  params: WALK_PARAMS,
  generate,
};
