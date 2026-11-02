/**
 * Forward kinematics with hierarchical snapping (FR-RIG-10, FR-RIG-20 step 2; ADR-012).
 * @packageDocumentation
 */
import { ANGLE_STEPS, rotatePoint } from '@pixel-forge/raster';
import {
  ANGLE_QUANTUM_DEFAULT,
  type BoneId,
  type FrameRef,
  type Point,
  type RestTransform,
} from '@pixel-forge/schema';
import {
  type Dyadic,
  ZERO,
  addDyadic,
  quantizeDyadic,
  quantumSteps,
  safeSteps,
  stepsToDeg,
  toDyadic,
  wrapSteps,
} from './angle.js';
import { RigError } from './errors.js';
import {
  type PoseAnimation,
  type PoseOptions,
  type PreparedAnimation,
  type ResolvedBoneKey,
  checkCoord,
  ensurePrepared,
  own,
  resolvePrepared,
} from './keys.js';
import { type BoneGraph, boneOrder } from './order.js';

/** The part of a view that FK needs: the rest pose. A schema `View` (or a deep-readonly one) fits. */
export interface RestPose {
  readonly rest: Readonly<Partial<Record<BoneId, Readonly<RestTransform>>>>;
}

/** One bone's input to {@link snapSkeleton}; a missing channel takes its rest value. */
export interface PoseKey {
  /** Degrees relative to rest, clockwise; quantised half away from zero. */
  readonly angle?: number;
  /** Integer translation of the pivot, canvas pixels. */
  readonly offset?: Readonly<Point>;
  readonly flipX?: boolean;
}

/** Input of {@link snapSkeleton}: keys by bone. A {@link ResolvedPose} fits; missing bones are at rest. */
export type Pose = ReadonlyMap<BoneId, PoseKey>;

/** Options of {@link snapSkeleton}. */
export interface SnapOptions {
  /** Angle quantum in degrees; missing means `ANGLE_QUANTUM_DEFAULT` (1°). */
  readonly angleQuantum?: number;
}

/**
 * A bone's place on the canvas after snapping. Angles are degrees, clockwise, 0° along +x, multiples of
 * the quantum, normalised to `[0, 360)`.
 */
export interface WorldTransform {
  /** Snapped pivot pixel on the canvas (integers). Parts align their variant pivot pixel here. */
  readonly pivot: Readonly<Point>;
  /**
   * Rotation away from the rest pose: the sum of the quantised key angles of the bone and all its
   * ancestors. It rotates this bone's parts drawn at rest (their residual when `drawnAngle` is
   * missing) and the rest offsets of its children.
   */
  readonly rotation: number;
  /** World direction at rest: the rest angles of the bone and its ancestors, summed exactly, quantised. */
  readonly restAngle: number;
  /** World direction now: `restAngle + rotation`, normalised (variant auto-select, gizmos, IK). */
  readonly worldAngle: number;
  /** Mirror this bone's own parts about the pivot; never inherited by children (spec 3.4.7). */
  readonly flipX: boolean;
}

/** One bone of a {@link SnappedSkeleton}. */
export interface SnappedBone extends WorldTransform {
  readonly id: BoneId;
  readonly parentId?: BoneId;
  /**
   * `false` when the view has no rest entry for the bone: the bone is unused and its parts are hidden
   * in this view (schema `View`). It is still evaluated with rest `{x: 0, y: 0, angle: 0}`, so it
   * passes its parent's pivot and rotation through to any children.
   */
  readonly inView: boolean;
  /** The bone's resolved, quantised key: its local angle relative to rest, offset and flip. */
  readonly key: ResolvedBoneKey;
}

/** The evaluated skeleton of one frame. */
export interface SnappedSkeleton {
  /** The quantum the angles were snapped to, in degrees. */
  readonly angleQuantum: number;
  /** Every bone of the rig, in {@link boneOrder} (parents first), keyed by id. */
  readonly bones: ReadonlyMap<BoneId, SnappedBone>;
}

const REST_DEFAULT: RestTransform = { x: 0, y: 0, angle: 0 };

/** Internal per-bone state while walking the tree. */
interface Walk {
  readonly pivot: Readonly<Point>;
  /** Rotation from rest in table steps, `0..1439`. */
  readonly rotation: number;
  /** Exact world rest angle (sum of rest angles down the chain). */
  readonly restSum: Dyadic;
}

/**
 * FR-RIG-20 step 2: the snapped skeleton of `pose` in `view` (ADR-012). For every bone, in
 * {@link boneOrder}:
 *
 * ```text
 * a        = round(key.angle / q) · q                      (half away from zero; local, relative to rest)
 * rotation = parent.rotation + a                           (root: a)
 * pivot    = root:  rest.(x, y) + key.offset
 *            child: parent.pivot + rotatePoint(rest.x, rest.y, parent.rotation) + key.offset
 * restAngle  = round(Σ rest.angle over the bone and its ancestors / q) · q   (exact sum, rounded once)
 * worldAngle = restAngle + rotation                        (normalised to [0, 360))
 * ```
 *
 * A child's rest `(x, y)` is its pivot's canvas offset from the parent's pivot **in the rest pose**,
 * and it turns with the parent's rotation away from rest. `rotatePoint` is raster's fixed-point
 * rotation (Q16 table, each coordinate rounded half away from zero), and it is the only rounding of a
 * child pivot: the rounded offset is added to the parent's **snapped** pivot, never to an unrounded
 * one. Consequences: with no keys every pivot is exactly its authored rest position, whatever the rest
 * angles and the quantum; the vector from a parent to a child depends only on the parent's rotation,
 * so a translation of the parent moves the child by exactly the same integers.
 *
 * Throws `RigError`: `UNKNOWN_BONE` (a pose or rest entry for a bone not in the rig), `BAD_VALUE`
 * (non-integer or out-of-range rest position or offset, `|v| > 2^31`; non-finite angle; a quantised
 * angle of 2^51° or more), `BAD_QUANTUM`, and the {@link boneOrder} errors.
 */
export function snapSkeleton(
  rig: BoneGraph,
  view: RestPose,
  pose: Pose,
  opts: SnapOptions = {},
): SnappedSkeleton {
  return snapOrdered(rig, boneOrder(rig), view, pose, opts.angleQuantum ?? ANGLE_QUANTUM_DEFAULT);
}

/** {@link snapSkeleton} with the bone order already computed (`order` is `boneOrder(rig)`). */
function snapOrdered(
  rig: BoneGraph,
  order: readonly BoneId[],
  view: RestPose,
  pose: Pose,
  angleQuantum: number,
): SnappedSkeleton {
  const qSteps = quantumSteps(angleQuantum);
  const parents = new Map<BoneId, BoneId | undefined>(rig.bones.map((b) => [b.id, b.parentId]));
  for (const id of pose.keys()) {
    if (!parents.has(id)) throw new RigError('UNKNOWN_BONE', `the pose has unknown bone "${id}"`);
  }
  for (const id of Object.keys(view.rest)) {
    // An entry whose value is undefined is skipped, as resolvePose skips undefined bone keys.
    if (own(view.rest, id) !== undefined && !parents.has(id as BoneId)) {
      throw new RigError('UNKNOWN_BONE', `the view's rest pose has unknown bone "${id}"`);
    }
  }
  const walk = new Map<BoneId, Walk>();
  const bones = new Map<BoneId, SnappedBone>();
  for (const id of order) {
    const parentId = parents.get(id);
    const parent = parentId === undefined ? undefined : walk.get(parentId);
    const restEntry = own(view.rest, id);
    const rest = restEntry ?? REST_DEFAULT;
    checkCoord(rest.x, `rest x of bone "${id}"`);
    checkCoord(rest.y, `rest y of bone "${id}"`);
    const key = pose.get(id) ?? {};
    const offset = key.offset ?? { x: 0, y: 0 };
    checkCoord(offset.x, `offset x of bone "${id}"`);
    checkCoord(offset.y, `offset y of bone "${id}"`);
    const aSteps =
      key.angle === undefined
        ? 0n
        : quantizeDyadic(toDyadic(key.angle, `angle of bone "${id}"`), qSteps);
    const angle = stepsToDeg(safeSteps(aSteps, `angle of bone "${id}"`));
    const rotation = wrapSteps(BigInt(parent?.rotation ?? 0) + aSteps);
    const restSum = addDyadic(
      parent?.restSum ?? ZERO,
      toDyadic(rest.angle, `rest angle of bone "${id}"`),
    );
    const restAngle = wrapSteps(quantizeDyadic(restSum, qSteps));
    let pivot: Point;
    if (parent === undefined) {
      pivot = { x: rest.x + offset.x + 0, y: rest.y + offset.y + 0 };
    } else {
      const [dx, dy] = rotatePoint(rest.x, rest.y, stepsToDeg(parent.rotation));
      pivot = { x: parent.pivot.x + dx + offset.x + 0, y: parent.pivot.y + dy + offset.y + 0 };
    }
    walk.set(id, { pivot, rotation, restSum });
    const bone: SnappedBone = {
      id,
      ...(parentId === undefined ? {} : { parentId }),
      inView: restEntry !== undefined,
      pivot,
      rotation: stepsToDeg(rotation),
      restAngle: stepsToDeg(restAngle),
      worldAngle: stepsToDeg((restAngle + rotation) % ANGLE_STEPS),
      flipX: key.flipX ?? false,
      key: { angle, offset: { x: offset.x + 0, y: offset.y + 0 }, flipX: key.flipX ?? false },
    };
    bones.set(id, bone);
  }
  return { angleQuantum, bones };
}

/**
 * FR-RIG-20 steps 1 and 2: the snapped skeleton of `animation` at `frame` (a frame id or index) in
 * `view`. Exactly `snapSkeleton(rig, view, resolvePose(rig, animation, frame, opts), {angleQuantum})`
 * with the animation's quantum (`opts.angleQuantum ?? animation.angleQuantum ?? 1`). `Frame.rootMotion`
 * is engine data (FR-ANIM-08) and does not move the skeleton.
 *
 * Throws the `RigError`s of {@link resolvePose} and {@link snapSkeleton}.
 */
export function evaluatePose(
  rig: BoneGraph,
  view: RestPose,
  animation: PoseAnimation | PreparedAnimation,
  frame: FrameRef,
  opts: PoseOptions = {},
): SnappedSkeleton {
  const prepared = ensurePrepared(rig, animation, opts);
  return snapOrdered(
    rig,
    prepared.order,
    view,
    resolvePrepared(prepared, frame),
    prepared.angleQuantum,
  );
}

/** The part of a rig that view selection needs. A schema `Rig` (or a deep-readonly one) fits. */
export interface ViewSet<V> {
  readonly views: readonly V[];
}

/**
 * The view an animation is drawn in (spec 3.4.7, ADR-011): `views[0]` for an undirected animation
 * (`direction` undefined), else the first view whose `directions` contain `direction`. Direction
 * fallback chains are document data and are applied by the caller. Throws
 * `RigError('UNKNOWN_VIEW')` when no view matches.
 */
export function selectView<V extends { readonly directions: readonly string[] }>(
  rig: ViewSet<V>,
  direction?: string,
): V {
  const view =
    direction === undefined
      ? rig.views[0]
      : rig.views.find((v) => v.directions.includes(direction));
  if (view === undefined) {
    throw new RigError(
      'UNKNOWN_VIEW',
      direction === undefined ? 'the rig has no views' : `no view draws direction "${direction}"`,
    );
  }
  return view;
}
