/**
 * Bone graph checks and the evaluation order (I1).
 * @packageDocumentation
 */
import type { Bone, BoneId } from '@pixel-forge/schema';
import { RigError } from './errors.js';

/** The part of a rig that FK needs: its bones. A schema `Rig` (or a deep-readonly one) fits. */
export interface BoneGraph {
  readonly bones: readonly Readonly<Pick<Bone, 'id' | 'parentId'>>[];
}

/** Code-unit comparison of ids: locale-independent, so the order is the same everywhere. */
const byId = (a: BoneId, b: BoneId): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The bones of `rig` in evaluation order: **depth-first pre-order**, roots sorted by id, the children
 * of every bone sorted by id (code-unit order, not locale order). Every parent comes before its
 * children and each subtree is contiguous, so the order suits both FK and an outliner.
 *
 * Checks the forest invariant (I1) and throws a `RigError`: `DUPLICATE_BONE` for a repeated id,
 * `UNKNOWN_BONE` for a `parentId` that is not a bone of the rig, `CYCLE` when a bone is its own
 * ancestor (a self-parent included). Iterative, so deep chains cannot overflow the stack.
 */
export function boneOrder(rig: BoneGraph): BoneId[] {
  const ids = new Set<BoneId>();
  for (const bone of rig.bones) {
    if (ids.has(bone.id)) throw new RigError('DUPLICATE_BONE', `duplicate bone id "${bone.id}"`);
    ids.add(bone.id);
  }
  const roots: BoneId[] = [];
  const children = new Map<BoneId, BoneId[]>();
  for (const bone of rig.bones) {
    const parent = bone.parentId;
    if (parent === undefined) {
      roots.push(bone.id);
      continue;
    }
    if (!ids.has(parent)) {
      throw new RigError('UNKNOWN_BONE', `bone "${bone.id}" has unknown parent "${parent}"`);
    }
    const list = children.get(parent);
    if (list) list.push(bone.id);
    else children.set(parent, [bone.id]);
  }
  const order: BoneId[] = [];
  // Push in reverse sorted order so the smallest id pops first.
  const stack = [...roots].sort(byId).reverse();
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    order.push(id);
    const kids = children.get(id);
    if (kids) stack.push(...[...kids].sort(byId).reverse());
  }
  if (order.length !== ids.size) {
    // Every bone has at most one parent, so a bone unreachable from the roots lies on, or hangs off, a cycle.
    const reached = new Set(order);
    const stuck = rig.bones.map((b) => b.id).filter((id) => !reached.has(id));
    throw new RigError(
      'CYCLE',
      `the bone graph has a cycle through ${stuck.sort(byId).join(', ')}`,
    );
  }
  return order;
}
