/**
 * Binding parts to bones by geometric overlap (FR-RIG-03). Never guesses: a part is assigned only
 * when one bone clearly wins; otherwise the candidates are returned for a human or the LLM to pick.
 *
 * Method. A bone's segment runs from its rest pivot to its tip (`pivot + rotatePoint(length, 0,
 * restAngle)`, ADR-012: the rest angle is the bone's world direction at rest). Every opaque pixel of
 * the part (pixel centres, integer canvas coordinates, the same convention as pivots) votes for the
 * bone whose segment is nearest to it, provided that segment is within `reach` pixels; pixels
 * equidistant from several segments split their vote exactly (integer weights). A bone's share is
 * its votes over **all** opaque pixels, so pixels far from every bone count as weak overlap.
 * Distances are exact (BigInt rationals), so mirrored limbs tie exactly.
 * @packageDocumentation
 */
import { rotatePoint } from '@pixel-forge/raster';
import type { BoneId, LayerId, RestTransform } from '@pixel-forge/schema';
import { RigError } from './errors.js';
import { snapSkeleton } from './snap.js';

/** The pixels of one candidate part in canvas coordinates. */
export interface PartShape {
  readonly layerId: LayerId;
  /** Canvas position of the top-left pixel of the `w x h` box. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** `w * h` values in row-major order; a pixel is opaque when its value is > 0. Missing: the whole box is opaque. */
  readonly alpha?: ArrayLike<number>;
}

/** Thresholds of {@link bindByOverlap}. */
export interface OverlapOptions {
  /** A pixel votes for a segment only within this distance (px, pixel centres). Default 4. */
  readonly reach?: number;
  /** The winner needs at least this share of all opaque pixels. Default 0.5. */
  readonly minShare?: number;
  /** The winner's share must exceed the runner-up's by at least this much. Default 0.2. */
  readonly margin?: number;
  /** Bones with at least this share are listed as candidates of an ambiguous part. Default 0.15. */
  readonly candidateShare?: number;
}

/** Defaults of {@link OverlapOptions}. */
export const DEFAULT_OVERLAP: Required<OverlapOptions> = {
  reach: 4,
  minShare: 0.5,
  margin: 0.2,
  candidateShare: 0.15,
};

/** The skeleton {@link bindByOverlap} reads: bones with lengths, and the view's rest pose. */
export interface BindSkeleton {
  readonly bones: readonly {
    readonly id: BoneId;
    readonly parentId?: BoneId;
    readonly length: number;
  }[];
  readonly view: { readonly rest: Readonly<Partial<Record<BoneId, Readonly<RestTransform>>>> };
}

/** Result of {@link bindByOverlap}. */
export interface OverlapResult {
  /** Clear winners, in input order. `share` is the winner's share of the part's opaque pixels. */
  readonly assignments: readonly { layerId: LayerId; boneId: BoneId; share: number }[];
  /** Parts with no clear winner: the bones with a share >= `candidateShare`, best first (ties by id). */
  readonly ambiguous: readonly { layerId: LayerId; candidates: BoneId[] }[];
  /** Parts with no opaque pixel, or none within reach of any bone. */
  readonly unmatched: readonly LayerId[];
}

interface Frac {
  n: bigint;
  d: bigint;
}

const less = (a: Frac, b: Frac): boolean => a.n * b.d < b.n * a.d;
const same = (a: Frac, b: Frac): boolean => a.n * b.d === b.n * a.d;

// lcm(1..17): every tie size up to the 17 humanoid bones divides it, so split votes stay integers.
const VOTE = 12252240;

interface Seg {
  id: BoneId;
  ax: bigint;
  ay: bigint;
  bx: bigint;
  by: bigint;
  len2: bigint;
}

function dist2(s: Seg, px: bigint, py: bigint): Frac {
  const wx = px - s.ax;
  const wy = py - s.ay;
  if (s.len2 === 0n) return { n: wx * wx + wy * wy, d: 1n };
  const dot = wx * (s.bx - s.ax) + wy * (s.by - s.ay);
  if (dot <= 0n) return { n: wx * wx + wy * wy, d: 1n };
  if (dot >= s.len2) {
    const ux = px - s.bx;
    const uy = py - s.by;
    return { n: ux * ux + uy * uy, d: 1n };
  }
  return { n: (wx * wx + wy * wy) * s.len2 - dot * dot, d: s.len2 };
}

/** The rest segment of every in-view bone, pivot to tip, in canvas pixels. */
function segments(skeleton: BindSkeleton): Seg[] {
  const snapped = snapSkeleton(skeleton, skeleton.view, new Map());
  const out: Seg[] = [];
  for (const bone of skeleton.bones) {
    const sb = snapped.bones.get(bone.id);
    if (!sb?.inView) continue;
    if (!Number.isInteger(bone.length) || bone.length < 0) {
      throw new RigError('BAD_VALUE', `bone ${bone.id} has a bad length ${String(bone.length)}`);
    }
    const [dx, dy] = rotatePoint(bone.length, 0, sb.restAngle);
    out.push({
      id: bone.id,
      ax: BigInt(sb.pivot.x),
      ay: BigInt(sb.pivot.y),
      bx: BigInt(sb.pivot.x + dx),
      by: BigInt(sb.pivot.y + dy),
      len2: BigInt(dx * dx + dy * dy),
    });
  }
  return out;
}

/**
 * Assigns each part to the bone whose rest segment it overlaps most, or reports candidates.
 * Thresholds: see {@link OverlapOptions} / {@link DEFAULT_OVERLAP}. Only bones that have a rest
 * entry in `skeleton.view` take part. Deterministic; ties never resolve silently.
 * @throws RigError `BAD_VALUE` for a bad shape or threshold, plus those of `snapSkeleton`.
 */
export function bindByOverlap(
  parts: readonly PartShape[],
  skeleton: BindSkeleton,
  options: OverlapOptions = {},
): OverlapResult {
  const o = { ...DEFAULT_OVERLAP, ...options };
  if (
    !(o.reach >= 0) ||
    !(o.minShare > 0 && o.minShare <= 1) ||
    !(o.margin >= 0 && o.margin <= 1)
  ) {
    throw new RigError('BAD_VALUE', 'bad overlap thresholds');
  }
  if (!(o.candidateShare > 0 && o.candidateShare <= 1)) {
    throw new RigError('BAD_VALUE', 'candidateShare must be in (0, 1]');
  }
  const segs = segments(skeleton);
  const reach2: Frac = { n: BigInt(Math.floor(o.reach * o.reach * 1024)), d: 1024n };
  const assignments: { layerId: LayerId; boneId: BoneId; share: number }[] = [];
  const ambiguous: { layerId: LayerId; candidates: BoneId[] }[] = [];
  const unmatched: LayerId[] = [];

  for (const part of parts) {
    const { x, y, w, h, alpha } = part;
    if (![x, y, w, h].every(Number.isInteger) || w < 0 || h < 0) {
      throw new RigError('BAD_VALUE', `part ${part.layerId} has a bad box`);
    }
    if (alpha !== undefined && alpha.length !== w * h) {
      throw new RigError('BAD_VALUE', `part ${part.layerId}: alpha must have w*h values`);
    }
    const votes = new Map<BoneId, number>();
    let opaque = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (alpha !== undefined && !((alpha[j * w + i] ?? 0) > 0)) continue;
        opaque++;
        const px = BigInt(x + i);
        const py = BigInt(y + j);
        let best: Frac | undefined;
        let tied: BoneId[] = [];
        for (const s of segs) {
          const d = dist2(s, px, py);
          if (best === undefined || less(d, best)) {
            best = d;
            tied = [s.id];
          } else if (same(d, best)) tied.push(s.id);
        }
        if (best === undefined || less(reach2, best)) continue;
        for (const id of tied) votes.set(id, (votes.get(id) ?? 0) + VOTE / tied.length);
      }
    }
    if (opaque === 0 || votes.size === 0) {
      unmatched.push(part.layerId);
      continue;
    }
    const total = opaque * VOTE;
    const ranked = [...votes.entries()].sort((a, b) =>
      b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    );
    const [top, second] = ranked;
    const topShare = (top?.[1] ?? 0) / total;
    const secondShare = (second?.[1] ?? 0) / total;
    if (top !== undefined && topShare >= o.minShare && topShare - secondShare >= o.margin) {
      assignments.push({ layerId: part.layerId, boneId: top[0], share: topShare });
    } else {
      const candidates = ranked.filter(([, v]) => v / total >= o.candidateShare).map(([id]) => id);
      if (candidates.length === 0) unmatched.push(part.layerId);
      else ambiguous.push({ layerId: part.layerId, candidates });
    }
  }
  return { assignments, ambiguous, unmatched };
}
