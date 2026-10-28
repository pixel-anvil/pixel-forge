/**
 * Skeleton templates (FR-RIG-02): the humanoid bone set with a side view and a front / back view.
 * Pure data generators: a template names its bones and parents; `core` turns it into ids.
 *
 * Geometry: every pivot is first placed as an absolute height above the feet row (`h`, up is
 * positive) and an x offset from the origin, rounded to whole pixels once; rest offsets are then
 * the differences of those rounded canvas positions (ADR-012: rest positions are canvas offsets at
 * rest, child pivot - parent pivot), so a child pivot is exactly `parent.pivot + rest` and every
 * pivot is where it was authored at any angle quantum. Rest angles are parent-relative bone
 * directions (0 deg = +x, clockwise, 90 deg = pointing down) and never move a pivot.
 * @packageDocumentation
 */
import { RigError } from './errors.js';

/** Bone names of the humanoid template, parents first (spec FR-RIG-02). */
export const HUMANOID_BONES = [
  'root',
  'pelvis',
  'torso',
  'neck',
  'head',
  'upper_arm_l',
  'lower_arm_l',
  'hand_l',
  'upper_arm_r',
  'lower_arm_r',
  'hand_r',
  'thigh_l',
  'shin_l',
  'foot_l',
  'thigh_r',
  'shin_r',
  'foot_r',
] as const;

/**
 * Proportions as fractions of the character height. Vertical fractions `ankle + shin + thigh +
 * pelvis + torso + neck + head` sum to 1 (feet row to top of the head). Defaults, for a 48 px
 * character: ankle 2 px above the feet row, shin 10, thigh 10 (hip 22 px up), pelvis 3, torso 12,
 * neck 2, head 9 (about 5.3 heads tall); shoulder 1 px below the top of the torso, upper arm 7,
 * lower arm 6, hand 2, foot 6 long; front views: shoulders 6 px and hips 2 px either side of the
 * centre line.
 */
export interface HumanoidProportions {
  readonly ankle: number;
  readonly shin: number;
  readonly thigh: number;
  readonly pelvis: number;
  readonly torso: number;
  readonly neck: number;
  readonly head: number;
  readonly shoulderDrop: number;
  readonly upperArm: number;
  readonly lowerArm: number;
  readonly hand: number;
  readonly footLength: number;
  readonly shoulderHalfWidth: number;
  readonly hipHalfWidth: number;
}

/** The default {@link HumanoidProportions}. */
export const DEFAULT_PROPORTIONS: HumanoidProportions = {
  ankle: 0.04,
  shin: 0.21,
  thigh: 0.21,
  pelvis: 0.06,
  torso: 0.26,
  neck: 0.04,
  head: 0.18,
  shoulderDrop: 0.03,
  upperArm: 0.14,
  lowerArm: 0.12,
  hand: 0.05,
  footLength: 0.12,
  shoulderHalfWidth: 0.12,
  hipHalfWidth: 0.05,
};

/** Options of the template generators. */
export interface TemplateOptions {
  /** Character height in px, feet row to top of head. Default 48. Integer 8..1024. */
  readonly height?: number;
  /** Canvas pixel of the root pivot: `x` the centre line, `y` the feet row. Default (0, 0). */
  readonly origin?: { readonly x: number; readonly y: number };
  /** Overrides of {@link DEFAULT_PROPORTIONS}. */
  readonly proportions?: Partial<HumanoidProportions>;
}

/** One bone of a template. `rest`: root = canvas pivot; child = canvas offset from the parent pivot. */
export interface TemplateBone {
  readonly name: string;
  readonly parent?: string;
  /** Pixels from the pivot to the tip (integer >= 0). */
  readonly length: number;
  readonly rest: { readonly x: number; readonly y: number; readonly angle: number };
}

/** A skeleton template: the bones (parents first), the view it is drawn for, and default part z. */
export interface SkeletonTemplate {
  readonly name: string;
  /** Suggested view name and directions. */
  readonly view: { readonly name: string; readonly directions: readonly string[] };
  readonly bones: readonly TemplateBone[];
  /** Default z per bone's part in this view (higher draws on top). */
  readonly z: Readonly<Record<string, number>>;
}

interface Spec {
  readonly view: SkeletonTemplate['view'];
  readonly name: string;
  readonly sideOn: boolean;
  /** Front: `_l` at +x on screen; back: at -x. */
  readonly leftSign: 1 | -1;
  readonly z: Readonly<Record<string, number>>;
}

const Z_SIDE: Record<string, number> = {
  upper_arm_r: 3,
  lower_arm_r: 3,
  hand_r: 4,
  upper_arm_l: -2,
  lower_arm_l: -2,
  hand_l: -1,
  thigh_r: 1,
  shin_r: 1,
  foot_r: 1,
  thigh_l: -3,
  shin_l: -3,
  foot_l: -3,
  torso: 0,
  pelvis: 0,
  neck: 0,
  head: 2,
  root: 0,
};
const Z_FRONT: Record<string, number> = {
  root: 0,
  pelvis: 0,
  torso: 0,
  neck: 0,
  head: 2,
  upper_arm_l: 1,
  lower_arm_l: 1,
  hand_l: 2,
  upper_arm_r: 1,
  lower_arm_r: 1,
  hand_r: 2,
  thigh_l: 0,
  shin_l: 0,
  foot_l: 0,
  thigh_r: 0,
  shin_r: 0,
  foot_r: 0,
};
const Z_BACK: Record<string, number> = { ...Z_FRONT, torso: 1, neck: 1, head: 3 };

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('unreachable');
  return v;
}

const wrap180 = (deg: number): number => {
  const m = ((((deg + 180) % 360) + 360) % 360) - 180;
  return m === -180 ? 180 : m;
};

interface Abs {
  parent?: string;
  x: number;
  h: number;
  world: number;
  length: number;
}

function build(spec: Spec, opts: TemplateOptions): SkeletonTemplate {
  const height = opts.height ?? 48;
  if (!Number.isInteger(height) || height < 8 || height > 1024) {
    throw new RigError(
      'BAD_VALUE',
      `template height must be an integer in 8..1024, got ${String(height)}`,
    );
  }
  const origin = opts.origin ?? { x: 0, y: 0 };
  if (!Number.isInteger(origin.x) || !Number.isInteger(origin.y)) {
    throw new RigError('BAD_VALUE', 'template origin must be integer pixels');
  }
  const p: HumanoidProportions = { ...DEFAULT_PROPORTIONS, ...opts.proportions };
  for (const [k, v] of Object.entries(p)) {
    if (!Number.isFinite(v) || v < 0) {
      throw new RigError('BAD_VALUE', `proportion ${k} must be a finite number >= 0`);
    }
  }
  const px = (f: number): number => Math.round(f * height);
  // Absolute heights above the feet row, cumulative so that rounding never drifts.
  const ankleH = px(p.ankle);
  const kneeH = px(p.ankle + p.shin);
  const hipH = px(p.ankle + p.shin + p.thigh);
  const pelvisTopH = px(p.ankle + p.shin + p.thigh + p.pelvis);
  const neckBaseH = px(p.ankle + p.shin + p.thigh + p.pelvis + p.torso);
  const headBaseH = px(p.ankle + p.shin + p.thigh + p.pelvis + p.torso + p.neck);
  const shoulderH = px(p.ankle + p.shin + p.thigh + p.pelvis + p.torso - p.shoulderDrop);
  const elbowH = shoulderH - px(p.upperArm);
  const wristH = elbowH - px(p.lowerArm);
  const sx = spec.sideOn ? 0 : px(p.shoulderHalfWidth);
  const hx = spec.sideOn ? 0 : px(p.hipHalfWidth);

  const abs: Record<string, Abs> = {
    root: { x: 0, h: 0, world: 0, length: 0 },
    pelvis: { parent: 'root', x: 0, h: hipH, world: -90, length: pelvisTopH - hipH },
    torso: { parent: 'pelvis', x: 0, h: pelvisTopH, world: -90, length: neckBaseH - pelvisTopH },
    neck: { parent: 'torso', x: 0, h: neckBaseH, world: -90, length: headBaseH - neckBaseH },
    head: { parent: 'neck', x: 0, h: headBaseH, world: -90, length: px(p.head) },
  };
  for (const side of ['l', 'r'] as const) {
    const s = side === 'l' ? spec.leftSign : -spec.leftSign;
    const ax = s * sx;
    const lx = s * hx;
    abs[`upper_arm_${side}`] = {
      parent: 'torso',
      x: ax,
      h: shoulderH,
      world: 90,
      length: shoulderH - elbowH,
    };
    abs[`lower_arm_${side}`] = {
      parent: `upper_arm_${side}`,
      x: ax,
      h: elbowH,
      world: 90,
      length: elbowH - wristH,
    };
    abs[`hand_${side}`] = {
      parent: `lower_arm_${side}`,
      x: ax,
      h: wristH,
      world: 90,
      length: px(p.hand),
    };
    abs[`thigh_${side}`] = { parent: 'pelvis', x: lx, h: hipH, world: 90, length: hipH - kneeH };
    abs[`shin_${side}`] = {
      parent: `thigh_${side}`,
      x: lx,
      h: kneeH,
      world: 90,
      length: kneeH - ankleH,
    };
    abs[`foot_${side}`] = {
      parent: `shin_${side}`,
      x: lx,
      h: ankleH,
      world: spec.sideOn ? 0 : 90,
      length: spec.sideOn ? px(p.footLength) : ankleH,
    };
  }

  const bones: TemplateBone[] = HUMANOID_BONES.map((name) => {
    const a = must(abs[name]); // every HUMANOID_BONES name is defined above
    const parent = a.parent === undefined ? undefined : must(abs[a.parent]);
    if (parent === undefined) {
      return {
        name,
        length: Math.max(0, a.length),
        rest: { x: origin.x + a.x, y: origin.y - a.h, angle: a.world },
      };
    }
    return {
      name,
      parent: must(a.parent),
      length: Math.max(0, a.length),
      rest: { x: a.x - parent.x, y: parent.h - a.h, angle: wrap180(a.world - parent.world) },
    };
  });
  return { name: spec.name, view: spec.view, bones, z: spec.z };
}

/**
 * The humanoid in a side view (character faces +x). Both arms and both legs sit on the centre
 * line; `_r` is the near limb (drawn on top), `_l` the far one. View `side`, direction `side`.
 */
export function humanoidSide(opts: TemplateOptions = {}): SkeletonTemplate {
  return build(
    {
      name: 'humanoid-side',
      view: { name: 'side', directions: ['side'] },
      sideOn: true,
      leftSign: 1,
      z: Z_SIDE,
    },
    opts,
  );
}

/** The humanoid seen from the front. `_l` limbs (the character's left) are at +x on screen. View `front`. */
export function humanoidFront(opts: TemplateOptions = {}): SkeletonTemplate {
  return build(
    {
      name: 'humanoid-front',
      view: { name: 'front', directions: ['front'] },
      sideOn: false,
      leftSign: 1,
      z: Z_FRONT,
    },
    opts,
  );
}

/** The humanoid seen from behind: {@link humanoidFront} with left and right swapped on screen. View `back`. */
export function humanoidBack(opts: TemplateOptions = {}): SkeletonTemplate {
  return build(
    {
      name: 'humanoid-back',
      view: { name: 'back', directions: ['back'] },
      sideOn: false,
      leftSign: -1,
      z: Z_BACK,
    },
    opts,
  );
}
