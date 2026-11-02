/**
 * The overlap helper (FR-RIG-07, T3.5; `docs/contracts/JOINT_CHECK.md` section 7): for a joint with
 * gaps, the pixels a human or an LLM can paint on the part that is drawn **lower** so that every gap
 * is covered while the composite at rest does not change a single pixel.
 *
 * Definitions (all integer maths on alpha masks; opaque means alpha > 0, except that only a **solid**
 * pixel hides paint: alpha 255 on a layer of effective opacity 255):
 *
 * - The **painted part** is the one of the two joint parts that is drawn lower at rest. The other is the
 *   **upper** part. Painting a pixel under a solid pixel of the upper part is invisible at rest, whatever
 *   the painted part held there. Under a translucent upper pixel (alpha < 255, or a layer below full
 *   opacity) the paint would show through, so such a pixel never counts as covering.
 * - **Child under the parent** (paint the child). For every checked angle θ and gap `q` with
 *   `d = q − P`, the nearest-sample source is `src = P + (rnd(C·dx + S·dy), rnd(−S·dx + C·dy))`
 *   with `[C, S] = trigQ16(θ)` (the inverse of the child's rotation about the pivot `P`). The mask is
 *   the union over all gaps of the 3×3 block around `src` restricted to `hidden(t) = solid(parent)(t) ∧
 *   ¬child₀(t)`: pixels the parent covers solidly and the child does not draw at rest. The 3×3 dilation is
 *   there because RotSprite rounds convex corners, so the exact source pixel can already be opaque.
 * - **Child over the parent** (paint the parent). Gaps never move and are child-covered at rest, so the
 *   mask is the gap union restricted to the pixels where the child is solid.
 * - `uncovered` lists the gaps no hidden pixel can serve: in the child-under case the source block holds no
 *   hidden pixel, in the child-over case the child is translucent there. They need a visible art change:
 *   no invisible paint can close them.
 *
 * By construction `mask ⊆ {t : solid upper(t) ∧ ¬painted₀(t)}`, so **painting any subset of the mask leaves
 * the rest composite unchanged**. {@link checkOverlapPaint} reports paint outside the mask.
 * @packageDocumentation
 */
import { cosQ16, roundQ16, sinQ16 } from '@pixel-forge/raster';
import type { RgbaImage } from '@pixel-forge/raster';
import type { BoneId, LayerId, PartId, VariantId } from '@pixel-forge/schema';
import { JointCheckError } from './errors.js';
import { alphaMask, paint as paintMask, sweepJoints } from './joint.js';
import type { JointCheckInput, JointGapResult, Px } from './joint.js';
import type { PartRender } from './render.js';

/** Which part {@link overlapMask} paints: the one drawn lower at rest. */
export type OverlapPaint = 'child' | 'parent';

/** Input of {@link overlapMask}. All images are layers of one canvas. */
export interface OverlapMaskInput {
  /** The joint's gaps, from `jointGaps` / `jointCheck`; its `pivot` is `P`. */
  readonly gaps: JointGapResult;
  /** The parent's part(s) at rest, canvas space. */
  readonly parent: RgbaImage;
  /** The child's part(s) at θ = 0, canvas space. */
  readonly childRest: RgbaImage;
  /** `child`: the child is drawn under the parent. `parent`: the child is drawn over it. */
  readonly paint: OverlapPaint;
  /** Canvas position of pixel (0, 0) of the painted part's variant image (`pivot − variant pivot`). */
  readonly imageOrigin: Px;
}

/** Result of {@link overlapMask}. Every list is sorted by y, then x, without duplicates. */
export interface OverlapMaskResult {
  /** The part to paint (the one drawn lower). */
  readonly paint: OverlapPaint;
  /** Canvas pixels where painting hides under the upper part and can close a gap. */
  readonly mask: Px[];
  /** `mask` in the painted variant's image coordinates (`mask − imageOrigin`); may lie outside the image. */
  readonly local: Px[];
  /** Gap pixels no hidden pixel can serve: they need a visible change. */
  readonly uncovered: Px[];
}

const byYX = (a: Px, b: Px): number => a[1] - b[1] || a[0] - b[0];

/**
 * `childRest` is an alpha > 0 mask; `parentSolid` and `childSolid` mark the pixels that
 * hide paint (alpha 255 on a layer of opacity 255).
 */
function overlapOnMasks(
  w: number,
  h: number,
  masks: {
    readonly childRest: Uint8Array;
    readonly parentSolid: Uint8Array;
    readonly childSolid: Uint8Array;
  },
  gaps: JointGapResult,
  paint: OverlapPaint,
  origin: Px,
): OverlapMaskResult {
  const { childRest, parentSolid, childSolid } = masks;
  const mask = new Set<number>();
  const uncovered = new Set<number>();
  const on = (m: Uint8Array, x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] !== 0;
  if (paint === 'parent') {
    for (const [x, y] of gaps.union) {
      if (on(childSolid, x, y)) mask.add(y * w + x);
      else uncovered.add(y * w + x);
    }
  } else {
    const [px, py] = gaps.pivot;
    for (const { angle, gaps: list } of gaps.angles) {
      if (list.length === 0) continue;
      if (!Number.isSafeInteger(angle * 4)) {
        throw new JointCheckError(
          'BAD_ANGLE',
          `checked angle ${String(angle)} is not a multiple of 0.25 degrees`,
        );
      }
      const c = cosQ16(angle);
      const s = sinQ16(angle);
      for (const [x, y] of list) {
        const dx = x - px;
        const dy = y - py;
        const sx = px + roundQ16(c * dx + s * dy);
        const sy = py + roundQ16(-s * dx + c * dy);
        let served = false;
        for (let ty = sy - 1; ty <= sy + 1; ty++) {
          for (let tx = sx - 1; tx <= sx + 1; tx++) {
            if (on(parentSolid, tx, ty) && !on(childRest, tx, ty)) {
              mask.add(ty * w + tx);
              served = true;
            }
          }
        }
        if (!served) uncovered.add(y * w + x);
      }
    }
  }
  const px = (k: number): Px => [k % w, Math.floor(k / w)];
  const canvas = [...mask].map(px).sort(byYX);
  return {
    paint,
    mask: canvas,
    local: canvas.map(([x, y]): Px => [x - origin[0], y - origin[1]]),
    uncovered: [...uncovered].map(px).sort(byYX),
  };
}

/**
 * The overlap mask of one joint (contract section 7): where to paint hidden overlap so the gaps of
 * `gaps` close without changing the rest composite. See the module comment for the exact definition.
 * Pure and deterministic; the inputs are not changed. `paint: 'child'` paints the child (the usual
 * case), `'parent'` the parent. Painting any subset of `mask` leaves the composite at rest unchanged.
 * Only alpha 255 of the upper image hides paint: scale its alpha by the layer's effective opacity before
 * the call (see {@link OverlapMasksInput.layerOpacity}); translucent upper pixels never enter the mask and
 * their gaps are `uncovered`.
 *
 * Throws {@link JointCheckError}: `SIZE_MISMATCH` (image sizes differ), `BAD_ANGLE` (a gap angle that is
 * not a multiple of 0.25), `BAD_PIVOT` (a non-integer pivot, `imageOrigin` or gap pixel).
 */
export function overlapMask(input: OverlapMaskInput): OverlapMaskResult {
  const { gaps, parent, childRest, paint, imageOrigin } = input;
  const w = parent.width;
  const h = parent.height;
  const cm = alphaMask(childRest, 'childRest', w, h);
  const ps = alphaMask(parent, 'parent', w, h, 255);
  const cs = alphaMask(childRest, 'childRest', w, h, 255);
  const ints = [...gaps.pivot, ...imageOrigin, ...gaps.union.flat()];
  if (!ints.every(Number.isInteger)) {
    throw new JointCheckError('BAD_PIVOT', 'pivot, imageOrigin and gap pixels must be integers');
  }
  return overlapOnMasks(w, h, { childRest: cm, parentSolid: ps, childSolid: cs }, gaps, paint, [
    imageOrigin[0],
    imageOrigin[1],
  ]);
}

/** Input of {@link checkOverlapPaint}. */
export interface OverlapPaintInput {
  /** The `mask` of an {@link OverlapMaskResult} (canvas pixels). */
  readonly mask: readonly Px[];
  /**
   * The upper part's rest image in canvas space: paint under a pixel of alpha 255 is invisible. Scale the
   * alpha by the layer's effective opacity first (a layer below 255 hides nothing).
   */
  readonly upper: RgbaImage;
  /** Canvas pixels the author painted (added or changed) on the painted part. */
  readonly painted: readonly Px[];
}

/** Result of {@link checkOverlapPaint}; every list is sorted by y, then x, without duplicates. */
export interface OverlapPaintReport {
  /** Painted pixels inside the mask: hidden by construction. */
  readonly inside: Px[];
  /** Outside the mask, but under the upper part: harmless at rest, yet useless for the gaps. */
  readonly outsideHidden: Px[];
  /** Outside the mask and not covered by the upper part: **they change the composite at rest**. */
  readonly outsideVisible: Px[];
}

/**
 * Reports paint made outside an overlap mask. A painted pixel is `inside` the mask, `outsideHidden`
 * (the upper part covers it solidly, so the rest composite is unchanged) or `outsideVisible` (it changes the
 * composite at rest and should be undone). Only alpha 255 of `upper` hides paint, as in {@link overlapMask}:
 * a translucent upper pixel lets the paint show. Pixels off the canvas count as visible. Pure.
 */
export function checkOverlapPaint(input: OverlapPaintInput): OverlapPaintReport {
  const { upper } = input;
  const w = upper.width;
  const h = upper.height;
  if (upper.data.length !== w * h * 4) {
    throw new JointCheckError('SIZE_MISMATCH', 'upper does not match its size');
  }
  const inMask = new Set(input.mask.map(([x, y]) => `${String(x)},${String(y)}`));
  const seen = new Set<string>();
  const inside: Px[] = [];
  const outsideHidden: Px[] = [];
  const outsideVisible: Px[] = [];
  for (const [x, y] of input.painted) {
    const key = `${String(x)},${String(y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (inMask.has(key)) inside.push([x, y]);
    else if (x >= 0 && y >= 0 && x < w && y < h && (upper.data[(y * w + x) * 4 + 3] ?? 0) === 255) {
      outsideHidden.push([x, y]);
    } else outsideVisible.push([x, y]);
  }
  return {
    inside: inside.sort(byYX),
    outsideHidden: outsideHidden.sort(byYX),
    outsideVisible: outsideVisible.sort(byYX),
  };
}

/** Input of {@link overlapMasks}: the joint check input plus the opacity of the part layers. */
export interface OverlapMasksInput extends JointCheckInput {
  /**
   * Effective opacity (0..255, the layer chain including its groups, as the frame render applies it) of
   * the part layers by id. Paint only hides under a part whose layer is at 255, so a layer below
   * 255 never covers. A layer that is not listed counts as 255.
   */
  readonly layerOpacity?: Readonly<Partial<Record<LayerId, number>>>;
  /**
   * The part layers bottom to top, which is how the frame render breaks a tie on `z`. Without it ties
   * follow `rig.parts`, which differs from the render after `part.split` (KNOWN_ISSUES SCN-03). A layer
   * that is not listed sorts first.
   */
  readonly layerOrder?: readonly LayerId[];
}

/** One joint with gaps in an {@link OverlapReport}. */
export interface OverlapJoint extends OverlapMaskResult {
  /** The child bone's name. */
  readonly bone: string;
  /** The parent bone's name. */
  readonly parent: string;
  /** The painted part: its id, layer, drawn variant and bone. */
  readonly partId: PartId;
  readonly layerId: LayerId;
  readonly variantId: VariantId;
  readonly boneId: BoneId;
}

/** A joint with gaps that {@link overlapMasks} could not handle (contract section 7 preconditions). */
export interface OverlapSkipped {
  readonly bone: string;
  readonly parent: string;
  /** `ambiguous-parts`: not exactly one visible part on each bone; `rotated-rest`: the painted part is drawn rotated at rest. */
  readonly reason: 'ambiguous-parts' | 'rotated-rest';
}

/** Result of {@link overlapMasks}. */
export interface OverlapReport {
  readonly view: string;
  readonly params: { readonly rangeDeg: number; readonly stepDeg: number; readonly radius: number };
  /** Joints with at least one gap that could be handled, sorted by `bone` in code-unit order. */
  readonly joints: OverlapJoint[];
  /** Joints with gaps that were not handled, sorted by `bone`. */
  readonly skipped: OverlapSkipped[];
}

const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The overlap masks of every joint of a rig that has gaps: runs the joint sweep (same input and
 * defaults as `jointCheck`, so the masks answer exactly the reported gaps), picks the part drawn lower
 * at rest (render order: `z`, then {@link OverlapMasksInput.layerOrder}, then rig order) and calls
 * {@link overlapMask}. Joints without gaps are
 * left out. Only solid pixels hide paint (alpha 255 on a layer whose {@link OverlapMasksInput.layerOpacity}
 * is 255); gaps that only a translucent upper part covers are `uncovered`. A joint whose bones do not
 * each have exactly one visible part, or whose painted part is
 * drawn rotated at rest (`drawnAngle` ≠ the rest angle, or flipped), is listed in `skipped`.
 * `local` is in the painted variant's own image coordinates (`mask − (pivot − variant pivot)`).
 * Pure and deterministic. Throws what `jointCheck` throws.
 */
export function overlapMasks(input: OverlapMasksInput): OverlapReport {
  const sweep = sweepJoints(input);
  const joints: OverlapJoint[] = [];
  const skipped: OverlapSkipped[] = [];
  const rank = new Map(input.layerOrder?.map((id, i) => [id, i]));
  const rankOf = (p: PartRender): number => rank.get(p.layerId) ?? -1;
  const drawn =
    input.layerOrder === undefined
      ? sweep.restParts
      : [...sweep.restParts].sort((a, b) => a.z - b.z || rankOf(a) - rankOf(b));
  const order = new Map(drawn.map((p, i) => [p.partId, i]));
  for (const j of sweep.joints) {
    if (j.result.gapCount === 0) continue;
    const names = { bone: j.bone.name, parent: j.parent.name };
    const childParts = sweep.restParts.filter((p) => p.boneId === j.bone.id);
    const parentParts = sweep.restParts.filter((p) => p.boneId === j.parent.id);
    const child = childParts[0];
    const parent = parentParts[0];
    if (childParts.length !== 1 || parentParts.length !== 1 || !child || !parent) {
      skipped.push({ ...names, reason: 'ambiguous-parts' });
      continue;
    }
    const childUnder = (order.get(child.partId) ?? 0) < (order.get(parent.partId) ?? 0);
    const painted = childUnder ? child : parent;
    const variant = input.rig.parts
      .find((p) => p.id === painted.partId)
      ?.variants.find((v) => v.id === painted.variantId);
    if (variant === undefined || painted.angle !== 0 || painted.flipX) {
      skipped.push({ ...names, reason: 'rotated-rest' });
      continue;
    }
    const origin: Px = [painted.pivot.x - variant.pivot.x, painted.pivot.y - variant.pivot.y];
    const solid = (part: PartRender): Uint8Array => {
      const m = new Uint8Array(sweep.w * sweep.h);
      if ((input.layerOpacity?.[part.layerId] ?? 255) === 255) {
        paintMask(m, sweep.w, sweep.h, part, input.palette, true);
      }
      return m;
    };
    const r = overlapOnMasks(
      sweep.w,
      sweep.h,
      {
        childRest: j.childRest,
        parentSolid: solid(parent),
        childSolid: solid(child),
      },
      j.result,
      childUnder ? 'child' : 'parent',
      origin,
    );
    joints.push({
      ...names,
      ...r,
      partId: painted.partId,
      layerId: painted.layerId,
      variantId: painted.variantId,
      boneId: painted.boneId,
    });
  }
  joints.sort((a, b) => codeUnit(a.bone, b.bone));
  skipped.sort((a, b) => codeUnit(a.bone, b.bone));
  return { view: sweep.view.name, params: sweep.params, joints, skipped };
}
