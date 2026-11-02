/**
 * The pose clipboard (FR-RIG-17): copy the bone keys of one frame, paste them onto a frame of the
 * same or another document, optionally mirrored. Pure: it reads a rig and returns keys; core's
 * `pastePoseTx` writes them.
 *
 * A pose is the frame's **bone keys** (angle, offset, flipX, interp). Part keys (variant, z,
 * visibility) are not part of it. The clip is keyed by bone **name**, so it survives a paste into
 * another document, and the `_l`/`_r` swap is a name rule.
 *
 * Mirrored paste: the bone named `x_l` receives the keys copied from `x_r` and the reverse; a bone
 * with no side suffix keeps its own name. On every pasted key `angle` is negated and the offset's `x`
 * is negated (`y` kept), the rule that mirroring a rig uses (README, "Determinism"); `flipX` and
 * `interp` are kept (the `_r` part art is already the mirror of the `_l` art). Angles are relative to
 * rest, and quantisation is odd, so the pasted pose resolves to exactly the negated rotations.
 * @packageDocumentation
 */
import type { Bone, BoneId, BoneKey } from '@pixel-forge/schema';
import { RigError } from './errors.js';
import { mirrorBoneName } from './names.js';

/** A copied pose: the bone keys of one frame, by bone name. */
export interface PoseClip {
  readonly bones: Readonly<Record<string, Readonly<BoneKey>>>;
}

/** The bones a clipboard function reads. A schema `Rig` fits. */
export interface PoseRig {
  readonly bones: readonly Readonly<Pick<Bone, 'id' | 'name'>>[];
}

/** Options of {@link pastePose}. */
export interface PastePoseOptions {
  /** Swap `_l`/`_r` bones and negate angles and offset `x`. Default `false`. */
  readonly mirrored?: boolean;
}

/** The result of {@link pastePose}. */
export interface PastedPose {
  /** The keys to set, by bone of the target rig. */
  readonly keys: Readonly<Record<BoneId, BoneKey>>;
  /** Names in the clip that no bone of the target rig matched (after the swap), in clip order. */
  readonly skipped: readonly string[];
}

const dup = (name: string): RigError =>
  new RigError('BAD_VALUE', `bone name ${name} is used twice`);

const copyKey = (k: Readonly<BoneKey>): BoneKey => ({
  ...k,
  ...(k.offset === undefined ? {} : { offset: { x: k.offset.x, y: k.offset.y } }),
});

const neg = (n: number): number => (n === 0 ? 0 : -n);

function mirrorKey(k: Readonly<BoneKey>): BoneKey {
  const out = copyKey(k);
  if (out.angle !== undefined) out.angle = neg(out.angle);
  if (out.offset !== undefined) out.offset = { x: neg(out.offset.x), y: out.offset.y };
  return out;
}

/**
 * Copies the bone keys of `frame` into a clip by bone name. Keys of bones the rig does not have are
 * left out.
 * @throws RigError `BAD_VALUE` for a bone name used twice.
 */
export function copyPose(
  rig: PoseRig,
  frame: { readonly boneKeys: Readonly<Partial<Record<BoneId, Readonly<BoneKey>>>> },
): PoseClip {
  const bones: Record<string, BoneKey> = {};
  for (const b of rig.bones) {
    if (Object.hasOwn(bones, b.name)) throw dup(b.name);
    const k = frame.boneKeys[b.id];
    if (k !== undefined) bones[b.name] = copyKey(k);
  }
  return { bones };
}

/**
 * Maps `clip` onto `rig`'s bones. Not mirrored: by the same name. Mirrored: each key moves to the
 * partner bone (see the module comment) and is mirrored. Clip entries with no bone of the target
 * name are returned in `skipped` (a one-sided rig, a missing partner).
 * @throws RigError `BAD_VALUE` for a bone name used twice in `rig`.
 */
export function pastePose(rig: PoseRig, clip: PoseClip, opts: PastePoseOptions = {}): PastedPose {
  const mirrored = opts.mirrored === true;
  const byName = new Map<string, BoneId>();
  for (const b of rig.bones) {
    if (byName.has(b.name)) throw dup(b.name);
    byName.set(b.name, b.id);
  }
  const keys: Record<BoneId, BoneKey> = {};
  const skipped: string[] = [];
  for (const [name, key] of Object.entries(clip.bones)) {
    const id = byName.get(mirrored ? mirrorBoneName(name) : name);
    if (id === undefined) skipped.push(name);
    else keys[id] = mirrored ? mirrorKey(key) : copyKey(key);
  }
  return { keys, skipped };
}
