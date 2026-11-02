/**
 * The `run` motion preset (FR-RIG-15): a side-view run cycle as plain FK keys.
 *
 * **Model.** Like {@link walk} (same foot plan, same body travel, same planting by two-bone IK and the
 * same left-after-right timing), with these differences. Each foot is on the ground for less than half
 * of the cycle (`stancePercent` 10..49), so for `50 − stancePercent` percent of the cycle **neither**
 * foot touches the ground: the flight phase. The stride is longer and the swing foot rises higher
 * (`lift`), so the knee folds more; the elbows stay bent at about a right angle and the arms swing wider;
 * the torso leans forward. The pelvis is lowest in the middle of a stance (the leg absorbs the weight)
 * and highest in the middle of the flight, whatever the stance percentage: two bobs per cycle,
 * `dy = bob · (1 + cos(2π · 2 (t − stancePercent · n / 2) / cycle)) / 2` with `t` the right foot's time
 * in units (`100 f + phase · n`), computed from raster's Q16 table (no floating-point trig, ADR-010).
 *
 * **Guarantees**, each checked while generating (`RigError('BAD_VALUE')` otherwise, naming the
 * parameter to change): every foot is reached; a planted foot lands on the ground row and slides at most
 * 1 px (`ankle.x` plus the root motion sum); at least one frame has both feet above the ground row
 * (`labels.flight` is `air`).
 *
 * **Loop.** As for walk: every value is periodic in the frame index and the last frame is one step
 * before frame 0.
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
  turnCos,
} from './preset.js';
import type { PoseKey } from './snap.js';
import { clampTo, footPlan, travel, worstSlide } from './walk.js';

/** Parameters of {@link run} (see {@link RUN_PARAMS}). */
export const RUN_PARAMS: PresetParamSpecs = {
  ...commonParams(8),
  strideLength: {
    kind: 'int',
    min: 1,
    max: 256,
    description:
      'Px a planted foot travels relative to the body; default four fifths of the shorter leg',
  },
  stancePercent: {
    kind: 'int',
    min: 10,
    max: 49,
    default: 35,
    description:
      'Percent of the cycle one foot is on the ground (below 50: both feet are off the ground for the rest)',
  },
  bob: {
    kind: 'int',
    min: 0,
    max: 32,
    description:
      'Px the pelvis drops in mid stance, peak to peak; default the smallest dip from a sixth of the shorter leg (at least 2) with which the feet reach and stay planted',
  },
  lift: {
    kind: 'int',
    min: 0,
    max: 64,
    description: 'Px the swinging foot rises; default a quarter of the shorter leg',
  },
  armSwing: {
    kind: 'number',
    min: 0,
    max: 90,
    default: 50,
    description: 'Degrees each upper arm swings either side of hanging straight',
  },
  elbowBend: {
    kind: 'number',
    min: 0,
    max: 120,
    default: 85,
    description:
      'Degrees the elbow bends at the forward end of the arm swing (60% of it at the back)',
  },
  lean: {
    kind: 'number',
    min: -30,
    max: 30,
    default: 10,
    description: 'Degrees the torso leans forward (clockwise); the head stays level',
  },
};

const REQUIRED = ['pelvis', 'thigh_l', 'shin_l', 'foot_l', 'thigh_r', 'shin_r', 'foot_r'] as const;

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
  if (legLength < 2) throw new RigError('BAD_VALUE', 'run: the legs are too short');
  const autoStride = clampTo(RUN_PARAMS.strideLength, Math.max(2, divRound(4 * legLength, 5)));
  const autoLift = clampTo(RUN_PARAMS.lift, Math.max(2, divRound(legLength, 4)));
  const firstBob = clampTo(RUN_PARAMS.bob, Math.max(2, divRound(legLength, 6)));
  const p = resolveParams(RUN_PARAMS, input, {
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
  const offsetL = (offsetR + 50 * n) % cycleUnits;
  const offsets = { r: offsetR, l: offsetL };
  const stanceAt = (f: number, offset: number): boolean =>
    (CYCLE_UNITS * f + offset) % cycleUnits < pct * n;
  // Each foot needs a stance frame (footPlan looks for one), and the flight must show in a frame.
  for (const side of ['l', 'r'] as const) {
    let any = false;
    for (let f = 0; f < n; f++) any ||= stanceAt(f, offsets[side]);
    if (!any) {
      throw new RigError(
        'BAD_VALUE',
        `run: ${side === 'l' ? 'left' : 'right'} foot has no stance frame; raise frames or stancePercent`,
      );
    }
  }
  let flightFrames = 0;
  for (let f = 0; f < n; f++) if (!stanceAt(f, offsetL) && !stanceAt(f, offsetR)) flightFrames++;
  if (flightFrames === 0) {
    throw new RigError(
      'BAD_VALUE',
      'run: no frame has both feet off the ground; lower stancePercent or raise frames',
    );
  }

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
  const body = (fe: number): number => travel(n, stride, pct, offsetR, fe);
  const sideName = (side: 'l' | 'r'): string => (side === 'l' ? 'left' : 'right');

  const build = (bob: number): PresetFrame[] => {
    const frames: PresetFrame[] = [];
    const ankleXs: Record<'l' | 'r', number[]> = { l: [], r: [] };
    const ankleYs: Record<'l' | 'r', number[]> = { l: [], r: [] };
    for (let f = 0; f < n; f++) {
      const keys: Partial<Record<BoneId, BoneKey>> = {};
      const labels: Record<string, string> = {};
      const tR = (CYCLE_UNITS * f + offsetR) % cycleUnits;
      // Lowest in the middle of the right stance (tR = pct n / 2) and of the left one, highest between.
      const dy = divRound(bob * (65536 + turnCos(2 * tR - pct * n, cycleUnits)), 131072);
      keys[ctx.id('pelvis')] = { offset: { x: 0, y: dy } };
      const pose = new Map<BoneId, PoseKey>([[ctx.id('pelvis'), { offset: { x: 0, y: dy } }]]);
      let airborne = true;
      for (const side of ['l', 'r'] as const) {
        const step = plans[side][f];
        if (step === undefined) throw new RigError('BAD_VALUE', 'run: frame out of range');
        if (step.stance) airborne = false;
        const target: Point = { x: step.x, y: step.y };
        const leg = placeLeg(ctx, pose, side, target, { planted: step.stance });
        if (!leg.reached) {
          throw new RigError(
            'BAD_VALUE',
            `run: with bob ${String(bob)} the ${sideName(side)} foot cannot reach (${String(target.x)}, ${String(target.y)}) in frame ${String(f)}; shorten strideLength or raise bob`,
          );
        }
        if (step.stance && leg.ankle.y !== target.y) {
          // A planted foot is on the ground row: not floating, not sunk.
          throw new RigError(
            'BAD_VALUE',
            `run: with bob ${String(bob)} the planted ${sideName(side)} foot misses the ground row in frame ${String(f)} at angleQuantum ${String(quantum)}; use a finer angleQuantum, or change strideLength or bob`,
          );
        }
        ankleXs[side].push(leg.ankle.x);
        ankleYs[side].push(leg.ankle.y);
        keys[ctx.id(`thigh_${side}`)] = { angle: leg.thigh };
        keys[ctx.id(`shin_${side}`)] = { angle: leg.shin };
        keys[ctx.id(`foot_${side}`)] = { angle: leg.foot };
        labels[`foot_${side}`] = step.stance ? 'stance' : 'swing';

        const t = (CYCLE_UNITS * f + offsets[side]) % cycleUnits;
        const c = turnCos(t, cycleUnits);
        if (ctx.has(`upper_arm_${side}`)) {
          keys[ctx.id(`upper_arm_${side}`)] = {
            angle: scaleAngle(param(p, 'armSwing'), c, quantum),
          };
        }
        if (ctx.has(`lower_arm_${side}`)) {
          // 60% of elbowBend with the arm back, all of it with the arm forward.
          keys[ctx.id(`lower_arm_${side}`)] = {
            angle: scaleAngle(-param(p, 'elbowBend') / 5, 4 * 65536 - c, quantum),
          };
        }
      }
      if (airborne) {
        for (const side of ['l', 'r'] as const) {
          // The snapped ankle (what the keys give), not the target.
          if ((ankleYs[side][f] ?? Number.POSITIVE_INFINITY) >= ctx.restPivot(`foot_${side}`).y) {
            throw new RigError(
              'BAD_VALUE',
              `run: the ${sideName(side)} foot touches the ground in flight frame ${String(f)}; raise lift or frames`,
            );
          }
        }
      }
      labels.flight = airborne ? 'air' : 'ground';
      const lean = param(p, 'lean');
      if (ctx.has('torso')) keys[ctx.id('torso')] = { angle: scaleAngle(lean, 65536, quantum) };
      if (ctx.has('head')) keys[ctx.id('head')] = { angle: scaleAngle(-lean, 65536, quantum) };

      const dx =
        travel(n, stride, pct, offsetR, n + f + 1) - travel(n, stride, pct, offsetR, n + f);
      frames.push({ boneKeys: keys, rootMotion: { dx, dy: 0 }, labels });
    }
    for (const side of ['l', 'r'] as const) {
      const slide = worstSlide(ankleXs[side], plans[side], body);
      if (slide > 1) {
        throw new RigError(
          'BAD_VALUE',
          `run: with bob ${String(bob)} the planted ${sideName(side)} foot slides ${String(slide)} px (at most 1) at angleQuantum ${String(quantum)}; use a finer angleQuantum, or change strideLength or bob`,
        );
      }
    }
    return frames;
  };

  const max = RUN_PARAMS.bob?.max ?? 32;
  let frames: PresetFrame[] | undefined;
  if (input.bob !== undefined) {
    frames = build(param(p, 'bob'));
  } else {
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
        `run: no bob from ${String(firstBob)} to ${String(max)} lets both feet reach and keep the planted foot within 1 px at angleQuantum ${String(quantum)}; use a finer angleQuantum, or shorten strideLength`,
      );
    }
  }
  return { preset: 'run', loop: 'loop', angleQuantum: quantum, params: p, frames };
}

/** The side-view run preset (FR-RIG-15). */
export const run: Preset = {
  name: 'run',
  summary:
    'Side-view run cycle: a flight phase with both feet off the ground, long stride, high knee lift, bent elbows, forward lean',
  loop: 'loop',
  params: RUN_PARAMS,
  generate,
};
