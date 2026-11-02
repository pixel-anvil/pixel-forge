/**
 * Motion presets (FR-RIG-15): the shared API of the generators that turn a few parameters into plain
 * FK bone keys. A preset is a pure function of a skeleton (bones that carry the template names of
 * {@link HUMANOID_BONES}, plus a view's rest pose) and numeric parameters. Its output is one
 * {@link PresetFrame} per frame: sparse bone keys on every frame (angles already quantised to the angle
 * quantum), the root motion of the frame, and labels (for example which feet are planted). Nothing in
 * it is IK state: a preset may use IK inside (to plant a foot) but it only ever writes FK keys, like
 * `rig_set_pose` does for end-effector targets (FR-RIG-13).
 *
 * **How to add a preset.** Describe the numeric parameters as {@link PresetParamSpecs} (include
 * {@link commonParams}), call {@link resolveParams} to validate and to fill the defaults (a default that
 * depends on the skeleton is passed as `auto`), look up the bones with {@link presetContext}, build the
 * frames, and wrap everything in {@link Preset}. Phases are exact integers: a cycle is
 * {@link CYCLE_UNITS} · `frames` units long (`phaseUnits`), and {@link turnCos} / {@link turnSin} read
 * raster's Q16 table at `round(1440 · turns)` steps, so no preset uses floating-point trig (ADR-010,
 * ADR-012).
 * @packageDocumentation
 */
import { cosQ16, sinQ16 } from '@pixel-forge/raster';
import type {
  BoneId,
  BoneKey,
  Delta,
  FrameId,
  LoopMode,
  Point,
  RestTransform,
} from '@pixel-forge/schema';
import { quantizeAngle, roundHalfAway } from './angle.js';
import { RigError } from './errors.js';
import { isqrt, solveIk } from './ik.js';
import type { PoseAnimation } from './keys.js';
import { type Pose, type PoseKey, type RestPose, snapSkeleton } from './snap.js';

/** A bone of the skeleton a preset runs on: a schema `Bone` fits. */
export interface PresetBone {
  readonly id: BoneId;
  /** The template name (`thigh_l`, `foot_r`, ...) the preset looks the bone up by. */
  readonly name: string;
  readonly parentId?: BoneId;
}

/**
 * The skeleton of a preset run: the bones and the rest pose of **one view**. A preset reads only
 * the rest offsets of the bones it uses, so any proportions work. Side-view presets such as walk
 * expect the character to face +x (as {@link humanoidSide} does).
 */
export interface PresetRig {
  readonly bones: readonly PresetBone[];
  readonly view: RestPose;
}

/** One frame of a preset: the FK keys, the root motion, and labels. */
export interface PresetFrame {
  /** Sparse keys by bone id. Angles are multiples of the animation's angle quantum. */
  readonly boneKeys: Readonly<Partial<Record<BoneId, BoneKey>>>;
  /** The root's displacement during this frame, integer px (`Frame.rootMotion`, FR-ANIM-08). */
  readonly rootMotion: Delta;
  /** What the frame shows, by template bone name or topic, for example `{ foot_l: 'stance' }`. */
  readonly labels: Readonly<Record<string, string>>;
}

/** What {@link Preset.generate} returns. */
export interface PresetResult {
  readonly preset: string;
  /** How the frames are meant to play. `loop` presets end one frame before they would repeat frame 0. */
  readonly loop: LoopMode;
  /** The angle quantum the angles were rounded to, degrees. */
  readonly angleQuantum: number;
  /** Every parameter with its default filled in (numbers only). */
  readonly params: Readonly<Record<string, number>>;
  readonly frames: readonly PresetFrame[];
}

/** One numeric parameter of a preset. */
export interface PresetParamSpec {
  /** `int` only accepts integers. */
  readonly kind: 'int' | 'number';
  readonly min: number;
  readonly max: number;
  /** Missing: the default depends on the skeleton and the preset computes it (`auto`). */
  readonly default?: number;
  readonly description: string;
}

/** The parameters of a preset by name. */
export type PresetParamSpecs = Readonly<Record<string, PresetParamSpec>>;

/** Parameter values as a caller gives them (every key optional). */
export type PresetParams = Readonly<Partial<Record<string, number>>>;

/** A motion preset: a named generator from parameters to FK keys. */
export interface Preset {
  /** `walk`, `run`, ... */
  readonly name: string;
  /** One line for tool descriptions and docs. */
  readonly summary: string;
  readonly loop: LoopMode;
  readonly params: PresetParamSpecs;
  /**
   * Generates the frames. Throws `RigError`: `UNKNOWN_BONE` (a bone the preset needs is missing),
   * `BAD_VALUE` (an unknown, non-finite or out-of-range parameter, or a combination the skeleton
   * cannot do, such as a stride the legs cannot reach), `BAD_QUANTUM`, and everything `snapSkeleton`
   * throws.
   */
  generate(rig: PresetRig, params?: PresetParams): PresetResult;
}

/** Phase units per frame in a cycle: a cycle of `n` frames is `CYCLE_UNITS · n` units. */
export const CYCLE_UNITS = 100;

/**
 * The parameters every cyclic preset has: `frames` (the cycle length; the last frame is the one
 * before frame 0 repeats), `phase` (percent of the cycle that frame 0 shows) and `angleQuantum`.
 * `defaultFrames` is the preset's own default length.
 */
export function commonParams(defaultFrames: number): PresetParamSpecs {
  return {
    frames: {
      kind: 'int',
      min: 4,
      max: 64,
      default: defaultFrames,
      description: 'Frames in the cycle; the cycle closes after the last frame',
    },
    phase: {
      kind: 'int',
      min: 0,
      max: 99,
      default: 0,
      description: 'Percent of the cycle shown by frame 0',
    },
    angleQuantum: {
      kind: 'number',
      min: 0.25,
      max: 90,
      default: 1,
      description: 'Angle quantum in degrees (a multiple of 0.25 that divides 360)',
    },
  };
}

/**
 * Validates `input` against `specs` and returns every parameter: the given value, else the spec
 * default, else `auto[name]`. Throws `RigError('BAD_VALUE')` for an unknown name, a value that is not
 * finite, not an integer for an `int`, or outside `min..max`, and for a parameter that has no value.
 */
export function resolveParams(
  specs: PresetParamSpecs,
  input: PresetParams = {},
  auto: Readonly<Record<string, number>> = {},
): Record<string, number> {
  for (const k of Object.keys(input)) {
    if (!Object.hasOwn(specs, k)) {
      throw new RigError(
        'BAD_VALUE',
        `unknown preset parameter "${k}" (known: ${Object.keys(specs).join(', ')})`,
      );
    }
  }
  const out: Record<string, number> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const given = Object.hasOwn(input, name) ? input[name] : undefined;
    const v = given ?? spec.default ?? auto[name];
    if (v === undefined) {
      throw new RigError('BAD_VALUE', `preset parameter "${name}" has no value and no default`);
    }
    if (!Number.isFinite(v) || (spec.kind === 'int' && !Number.isInteger(v))) {
      throw new RigError(
        'BAD_VALUE',
        `preset parameter "${name}" must be ${spec.kind === 'int' ? 'an integer' : 'a finite number'}, got ${String(v)}`,
      );
    }
    if (v < spec.min || v > spec.max) {
      throw new RigError(
        'BAD_VALUE',
        `preset parameter "${name}" must be in ${String(spec.min)}..${String(spec.max)}, got ${String(v)}`,
      );
    }
    out[name] = v + 0;
  }
  return out;
}

/** The value of parameter `name` in the result of {@link resolveParams} (`RigError('BAD_VALUE')` when absent). */
export function param(params: Readonly<Record<string, number>>, name: string): number {
  const v = params[name];
  if (v === undefined) throw new RigError('BAD_VALUE', `no preset parameter "${name}"`);
  return v;
}

/** What a preset reads from the skeleton: ids and rest positions by template name. */
export interface PresetContext {
  readonly rig: PresetRig;
  /** The angle quantum, degrees. */
  readonly quantum: number;
  /** The id of the bone named `name`. Throws `RigError('UNKNOWN_BONE')` when the rig has none. */
  id(name: string): BoneId;
  /** Whether the rig has a bone with this template name. */
  has(name: string): boolean;
  /** The snapped rest pose (no keys): every pivot is where the view authored it. */
  readonly restPivot: (name: string) => Readonly<Point>;
  /**
   * The bones from the root down to `id` (a sub-rig, cached per context): snapping it gives the same
   * pivots for those bones as snapping the whole rig, because a pivot only depends on its ancestors.
   */
  chainRig(id: BoneId): PresetRig;
}

/**
 * The lookup tables of one preset run. `required` names bones the preset cannot work without
 * (`RigError('UNKNOWN_BONE')` when one is missing, or has no rest entry in the view). Two bones with
 * one name are `RigError('BAD_VALUE')`.
 */
export function presetContext(
  rig: PresetRig,
  required: readonly string[],
  quantum: number,
): PresetContext {
  const ids = new Map<string, BoneId>();
  for (const b of rig.bones) {
    if (ids.has(b.name)) {
      throw new RigError('BAD_VALUE', `two bones are named "${b.name}"`);
    }
    ids.set(b.name, b.id);
  }
  const rest = snapSkeleton(rig, rig.view, new Map<BoneId, PoseKey>(), { angleQuantum: quantum });
  const id = (name: string): BoneId => {
    const found = ids.get(name);
    if (found === undefined) {
      throw new RigError('UNKNOWN_BONE', `the rig has no bone named "${name}"`);
    }
    return found;
  };
  const restPivot = (name: string): Readonly<Point> => {
    const b = rest.bones.get(id(name));
    if (b === undefined) throw new RigError('UNKNOWN_BONE', `the rig has no bone named "${name}"`);
    return b.pivot;
  };
  for (const name of required) {
    const b = rest.bones.get(id(name));
    if (!b?.inView) {
      throw new RigError('UNKNOWN_BONE', `bone "${name}" has no rest pose in the view`);
    }
  }
  const parentOf = new Map<BoneId, PresetBone>(rig.bones.map((b) => [b.id, b]));
  const chains = new Map<BoneId, PresetRig>();
  const chainRig = (boneId: BoneId): PresetRig => {
    const cached = chains.get(boneId);
    if (cached !== undefined) return cached;
    const bones: PresetBone[] = [];
    const seen = new Set<BoneId>();
    for (let b = parentOf.get(boneId); b !== undefined && !seen.has(b.id);) {
      seen.add(b.id);
      bones.push(b);
      b = b.parentId === undefined ? undefined : parentOf.get(b.parentId);
    }
    bones.reverse();
    const restOfChain: Record<BoneId, RestTransform> = {};
    for (const b of bones) {
      const entry = rig.view.rest[b.id];
      if (entry !== undefined) restOfChain[b.id] = entry;
    }
    const sub: PresetRig = { bones, view: { rest: restOfChain } };
    chains.set(boneId, sub);
    return sub;
  };
  return { rig, quantum, id, has: (name) => ids.has(name), restPivot, chainRig };
}

/** `n / d` rounded half away from zero (`d > 0`, integers). */
export function divRound(n: number, d: number): number {
  return Number(roundHalfAway(BigInt(n), BigInt(d))) + 0;
}

/**
 * Q16 `sin` of `turns` full turns, where `turns = num / den` exactly: the table step is
 * `round(1440 · num / den)`. `num` may be negative or larger than `den`.
 */
export function turnSin(num: number, den: number): number {
  return sinQ16(divRound(1440 * num, den) / 4);
}

/** Q16 `cos` of `num / den` full turns (see {@link turnSin}). */
export function turnCos(num: number, den: number): number {
  return cosQ16(divRound(1440 * num, den) / 4);
}

/** `amp · q16 / 65536` for an integer `amp`, rounded half away from zero: an integer. */
export function scaleInt(amp: number, q16: number): number {
  return divRound(amp * q16, 65536);
}

/**
 * `amp · q16 / 65536` degrees (`amp` any finite number), rounded half away from zero to the angle
 * quantum, exactly (a double product, then {@link quantizeAngle}'s exact rounding).
 */
export function scaleAngle(amp: number, q16: number, quantum: number): number {
  return quantizeAngle((amp * q16) / 65536, quantum) + 0;
}

/** A leg bent forward by IK: key angles of `thigh`, `shin` and `foot`, and where the ankle landed. */
export interface LegPlacement {
  readonly thigh: number;
  readonly shin: number;
  /** Keeps the foot at its rest world angle (the sum of the three is 0 when the pelvis does not turn). */
  readonly foot: number;
  /** The snapped ankle pivot these angles give. */
  readonly ankle: Readonly<Point>;
  /** True when the ankle is within 1 px of the target on both axes. */
  readonly reached: boolean;
}

/** How far {@link placeLeg} searches around the IK angles, in angle quanta, per joint. */
const LEG_SEARCH_QUANTA = 3;

/** Options of {@link placeLeg}. */
export interface PlaceLegOptions {
  /**
   * The foot is on the ground: an error along x costs 4 times an error along y (squared distance
   * with x weighted 16), so a planted foot lands on its pixel column first. Default false.
   */
  readonly planted?: boolean;
}

/**
 * Plants the ankle of a leg on `target` (canvas px) by two-bone IK (FR-RIG-13), the knee bending
 * clockwise (side view, character facing +x: the shin goes back). `pose` carries the rest of the
 * frame (at least the pelvis offset), because the hip moves with it. The foot key is chosen so the
 * foot keeps its rest direction on the canvas, assuming the bones above the thigh are not rotated.
 *
 * IK gives the angles that put the ankle within a pixel; at a coarse angle quantum that is not always
 * the best pixel. When the ankle is off its target, a deterministic search over the neighbouring
 * quantised angles (±{@link LEG_SEARCH_QUANTA} quanta per joint, the real `snapSkeleton` rounding)
 * takes the pair with the smallest error, ties to the smallest change from the IK angles.
 */
export function placeLeg(
  ctx: PresetContext,
  pose: Pose,
  side: 'l' | 'r',
  target: Readonly<Point>,
  opts: PlaceLegOptions = {},
): LegPlacement {
  const footId = ctx.id(`foot_${side}`);
  const thighId = ctx.id(`thigh_${side}`);
  const shinId = ctx.id(`shin_${side}`);
  const sol = solveIk({
    rig: ctx.rig,
    view: ctx.rig.view,
    pose,
    effector: footId,
    target,
    chainLength: 2,
    solver: 'two-bone',
    bend: 'cw',
    angleQuantum: ctx.quantum,
  });
  // The search snaps only the bones from the root to the foot (a pivot depends on its ancestors only).
  const chain = ctx.chainRig(footId);
  const chainPose = new Map<BoneId, PoseKey>();
  for (const b of chain.bones) {
    const key = pose.get(b.id);
    if (key !== undefined) chainPose.set(b.id, key);
  }
  let thigh = sol.angles.get(thighId) ?? 0;
  let shin = sol.angles.get(shinId) ?? 0;
  let ankle = sol.effector;
  const wx = opts.planted === true ? 16 : 1;
  const cost = (p: Readonly<Point>): number =>
    wx * (p.x - target.x) * (p.x - target.x) + (p.y - target.y) * (p.y - target.y);
  if (ankle.x !== target.x || ankle.y !== target.y) {
    let best = cost(ankle);
    let bestMove = 0;
    const t0 = thigh;
    const s0 = shin;
    for (let i = -LEG_SEARCH_QUANTA; i <= LEG_SEARCH_QUANTA; i++) {
      for (let j = -LEG_SEARCH_QUANTA; j <= LEG_SEARCH_QUANTA; j++) {
        if (i === 0 && j === 0) continue;
        const t = t0 + i * ctx.quantum;
        const sh = s0 + j * ctx.quantum;
        const probe = new Map(chainPose);
        probe.set(thighId, { ...probe.get(thighId), angle: t });
        probe.set(shinId, { ...probe.get(shinId), angle: sh });
        const at = snapSkeleton(chain, chain.view, probe, {
          angleQuantum: ctx.quantum,
        }).bones.get(footId)?.pivot;
        if (at === undefined) continue;
        const c = cost(at);
        const move = i * i + j * j;
        if (c < best || (c === best && move < bestMove)) {
          best = c;
          bestMove = move;
          thigh = t;
          shin = sh;
          ankle = at;
        }
      }
    }
  }
  return {
    thigh,
    shin,
    foot: quantizeAngle(-(thigh + shin), ctx.quantum) + 0,
    ankle,
    reached: Math.abs(ankle.x - target.x) <= 1 && Math.abs(ankle.y - target.y) <= 1,
  };
}

/** Length of the rest offset `(x, y)`, rounded down (integer maths). */
export function restLength(x: number, y: number): number {
  return Number(isqrt(BigInt(x) * BigInt(x) + BigInt(y) * BigInt(y)));
}

/**
 * The bone keys of a preset result as a key-resolution input: with `loop` the keys wrap from the last
 * frame to the first. `ids` names the frames (one per frame). Only the bone keys and the angle quantum
 * are carried: the `Animation` schema has no field for the per-frame `rootMotion` or `labels` of a
 * {@link PresetFrame}, so a caller that stores them writes them to `Frame.rootMotion` itself.
 */
export function presetAnimation(result: PresetResult, ids: readonly FrameId[]): PoseAnimation {
  if (ids.length !== result.frames.length) {
    throw new RigError(
      'BAD_VALUE',
      `${String(ids.length)} frame ids for ${String(result.frames.length)} frames`,
    );
  }
  return {
    loop: result.loop,
    angleQuantum: result.angleQuantum,
    frames: ids.map((id, i) => {
      const frame = result.frames[i];
      if (frame === undefined) {
        throw new RigError('BAD_VALUE', `internal error: preset frame ${String(i)} is missing`);
      }
      return { id, boneKeys: frame.boneKeys };
    }),
  };
}
