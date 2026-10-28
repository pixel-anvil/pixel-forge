/**
 * The joint coverage check (FR-RIG-05), implementing `docs/contracts/JOINT_CHECK.md` (T3.0). `jointGaps` is
 * the pure predicate on alpha masks (the section 3.1 / 4 / 5 definition); `jointCheck` builds its inputs
 * from a rig with `renderParts` and reports every joint (section 3.2 / 6.2). Integer maths only: the
 * outer-side test uses raster's Q16 trig table and every other test is a mask comparison.
 * @packageDocumentation
 */
import { IndexedImage, cosQ16, sinQ16 } from '@pixel-forge/raster';
import type { Palette, RgbaImage, RotatableImage } from '@pixel-forge/raster';
import {
  ANGLE_QUANTUM_DEFAULT,
  JOINT_STEP_DEG_DEFAULT,
  JOINT_SWEEP_DEG_DEFAULT,
} from '@pixel-forge/schema';
import type { Bone, BoneId, FrameId, PartId, PartKey } from '@pixel-forge/schema';
import { JointCheckError, RigError } from './errors.js';
import { renderParts } from './render.js';
import type {
  PartAnimation,
  PartRender,
  PartRenderCache,
  PartRig,
  PartView,
  RenderPartsInput,
} from './render.js';
import { createPartCache } from './render.js';
import type { ImageLookup } from './overrides.js';
import { selectView, snapSkeleton } from './snap.js';

/** Default window radius `r` of {@link jointCheck}, in pixels (contract section 3.2): limbs up to about 8 px wide. */
export const JOINT_RADIUS_DEFAULT = 4;

/** Most angles one sweep may check (a guard against a tiny `stepDeg`). */
const MAX_SWEEP_ANGLES = 1440;

/** A canvas pixel `[x, y]`. */
export type Px = readonly [x: number, y: number];

/** Input of {@link jointGaps} (contract section 3.1). All images are layers of one canvas. */
export interface JointGapInput {
  /** The parent's part(s) at rest, canvas space. Only alpha matters (opaque means alpha > 0). */
  readonly parent: RgbaImage;
  /** The child's part(s) at θ = 0, canvas space. */
  readonly childRest: RgbaImage;
  /** The child at each checked θ ≠ 0, already rotated and placed, canvas space. Any order. */
  readonly frames: readonly { readonly angle: number; readonly child: RgbaImage }[];
  /** The joint pivot `P`: the child bone's snapped pivot at rest, a canvas pixel (it may lie off the canvas). */
  readonly pivot: Px;
  /** `a0`: the child bone's rest WORLD angle in degrees (a multiple of 0.25). */
  readonly childDir: number;
  /** `r`: the Chebyshev window radius, an integer ≥ 1. */
  readonly radius: number;
}

/** The gap pixels of one checked angle, sorted by y then x. */
export interface JointAngleGaps {
  readonly angle: number;
  readonly gaps: Px[];
}

/** Result of {@link jointGaps}, and the exact shape of each `fixtures/joint/*.expected.json`. Key order is stable. */
export interface JointGapResult {
  readonly pivot: Px;
  /** Every checked angle, ascending, including those without gaps. */
  readonly angles: JointAngleGaps[];
  /** Σ `angles[i].gaps.length`: (pixel, angle) pairs. */
  readonly gapCount: number;
  /** The distinct gap pixels over all angles, sorted by y then x. */
  readonly union: Px[];
}

const LINES = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
] as const;

const P_FLAG = 1;
const C_FLAG = 2;

interface MaskFrame {
  readonly angle: number;
  readonly child: Uint8Array;
}

/** The reference algorithm of contract section 5 on 0/1 masks of size `w × h`. */
function gapsOnMasks(
  w: number,
  h: number,
  parent: Uint8Array,
  childRest: Uint8Array,
  frames: readonly MaskFrame[],
  pivot: Px,
  childDir: number,
  r: number,
): JointGapResult {
  const [px, py] = pivot;
  const c0 = cosQ16(childDir);
  const s0 = sinQ16(childDir);
  const inWin = (x: number, y: number): boolean => Math.abs(x - px) <= r && Math.abs(y - py) <= r;
  const on = (m: Uint8Array, x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] !== 0;
  const rest = (x: number, y: number): boolean => on(parent, x, y) || on(childRest, x, y);

  const angles: JointAngleGaps[] = [];
  const seen = new Set<number>();
  const sorted = [...frames].sort((a, b) => a.angle - b.angle);
  for (const f of sorted) {
    const theta = f.angle;
    const childNow = f.child;
    const comp = (x: number, y: number): boolean => on(parent, x, y) || on(childNow, x, y);
    /** 0 = none, else P_FLAG | C_FLAG bits of the first covered pixel along the ray. */
    const ray = (x: number, y: number, ux: number, uy: number): number => {
      let tx = x + ux;
      let ty = y + uy;
      for (;;) {
        if (!inWin(tx, ty)) return 0;
        const p = on(parent, tx, ty);
        const c = on(childNow, tx, ty);
        if (p || c) return (p ? P_FLAG : 0) | (c ? C_FLAG : 0);
        if (!rest(tx, ty)) return 0;
        tx += ux;
        ty += uy;
      }
    };
    const pinched = (x: number, y: number): boolean => {
      for (const [ux, uy] of LINES) {
        const a = ray(x, y, ux, uy);
        if (a === 0) continue;
        const b = ray(x, y, -ux, -uy);
        if (b === 0) continue;
        if (
          ((a & P_FLAG) !== 0 && (b & C_FLAG) !== 0) ||
          ((a & C_FLAG) !== 0 && (b & P_FLAG) !== 0)
        ) {
          return true;
        }
      }
      return false;
    };
    const gaps: Px[] = [];
    for (let y = Math.max(0, py - r); y <= Math.min(h - 1, py + r); y++) {
      for (let x = Math.max(0, px - r); x <= Math.min(w - 1, px + r); x++) {
        if (comp(x, y) || !rest(x, y)) continue;
        // Outer side: s = dy·C0 − dx·S0; θ > 0 outer iff s < 0, θ < 0 iff s > 0, s = 0 never.
        const s = (y - py) * c0 - (x - px) * s0;
        if (theta > 0 ? !(s < 0) : !(s > 0)) continue;
        if (pinched(x, y)) {
          gaps.push([x, y]);
          seen.add(y * w + x);
        }
      }
    }
    angles.push({ angle: theta, gaps });
  }
  const union: Px[] = [...seen].sort((a, b) => a - b).map((k): Px => [k % w, Math.floor(k / w)]);
  return {
    pivot: [px, py],
    angles,
    gapCount: angles.reduce((n, a) => n + a.gaps.length, 0),
    union,
  };
}

function alphaMask(img: RgbaImage, what: string, w: number, h: number): Uint8Array {
  if (img.width !== w || img.height !== h || img.data.length !== w * h * 4) {
    throw new JointCheckError(
      'SIZE_MISMATCH',
      `${what} is ${String(img.width)}×${String(img.height)} (${String(img.data.length)} bytes), expected ${String(w)}×${String(h)} RGBA8`,
    );
  }
  const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = (img.data[i * 4 + 3] ?? 0) > 0 ? 1 : 0;
  return m;
}

/**
 * The joint-gap predicate of `docs/contracts/JOINT_CHECK.md` (T3.0), sections 3.1, 4 and 5: for each
 * checked angle θ, the pixels `q` within Chebyshev distance `radius` of the pivot that are open in the
 * composite at θ, were covered at rest, lie strictly on the outer side of the bend (relative to the
 * child's rest direction `childDir`) and are pinched, along a row, column or diagonal, between a parent
 * pixel and a child pixel across pixels vacated since rest. The caller supplies the rotated child, so the
 * result does not depend on the rotation algorithm. Pure, integer maths, deterministic. `frames` may come
 * in any order; the output is sorted by angle, then by y and x.
 *
 * Throws {@link JointCheckError}: `SIZE_MISMATCH`, `BAD_ANGLE` (a frame angle that is 0, not finite or
 * duplicated, or a `childDir` that is not a multiple of 0.25), `BAD_RADIUS`, `BAD_PIVOT`.
 */
export function jointGaps(input: JointGapInput): JointGapResult {
  const { parent, childRest, frames, pivot, childDir, radius } = input;
  const w = parent.width;
  const h = parent.height;
  const pm = alphaMask(parent, 'parent', w, h);
  const cm = alphaMask(childRest, 'childRest', w, h);
  const angles = new Set<number>();
  const mf: MaskFrame[] = frames.map((f) => {
    if (!Number.isFinite(f.angle) || f.angle === 0) {
      throw new JointCheckError(
        'BAD_ANGLE',
        `checked angle ${String(f.angle)} must be finite and non-zero`,
      );
    }
    if (angles.has(f.angle)) {
      throw new JointCheckError('BAD_ANGLE', `angle ${String(f.angle)} is checked twice`);
    }
    angles.add(f.angle);
    return { angle: f.angle, child: alphaMask(f.child, `frame ${String(f.angle)}`, w, h) };
  });
  if (!Number.isInteger(radius) || radius < 1) {
    throw new JointCheckError('BAD_RADIUS', `radius must be an integer ≥ 1, got ${String(radius)}`);
  }
  if (!Number.isInteger(pivot[0]) || !Number.isInteger(pivot[1])) {
    throw new JointCheckError(
      'BAD_PIVOT',
      `pivot must have integer coordinates, got ${String(pivot)}`,
    );
  }
  if (!Number.isSafeInteger(childDir * 4)) {
    throw new JointCheckError(
      'BAD_ANGLE',
      `childDir must be a finite multiple of 0.25 degrees, got ${String(childDir)}`,
    );
  }
  return gapsOnMasks(w, h, pm, cm, mf, [pivot[0], pivot[1]], childDir, radius);
}

/** A bone the joint check reads: a schema `Bone` (or a deep-readonly one) fits. */
export type JointBone = Readonly<Pick<Bone, 'id' | 'name' | 'parentId'>>;

/** The rig {@link jointCheck} reads: a {@link PartRig} whose bones and views carry names. */
export interface JointRig extends PartRig {
  readonly bones: readonly JointBone[];
  readonly views: readonly (PartView & { readonly name: string })[];
}

/** Input of {@link jointCheck}. */
export interface JointCheckInput {
  readonly rig: JointRig;
  /** Variant images by id. */
  readonly images: ImageLookup;
  /** The document canvas, pixels (content clipped by its edge is transparent). */
  readonly canvas: { readonly w: number; readonly h: number };
  /** The direction whose view is checked (`selectView`); missing: `views[0]`. */
  readonly direction?: string;
  /**
   * Part keys (variant, visibility, z) applied at rest and at every θ; missing: none, so every part
   * is drawn with its view's default variant. Overrides, post-passes and skins are never applied.
   */
  readonly partKeys?: Readonly<Partial<Record<PartId, Readonly<PartKey>>>>;
  /** Palette that resolves indexed variant images to alpha; missing: the transparent index is empty. */
  readonly palette?: Palette;
  /** The quantum of the sweep's key angles and of the rest direction; default `ANGLE_QUANTUM_DEFAULT`. */
  readonly angleQuantum?: number;
  /** `R`, degrees > 0; default `JOINT_SWEEP_DEG_DEFAULT` (30). */
  readonly rangeDeg?: number;
  /** `S`, degrees > 0; default `JOINT_STEP_DEG_DEFAULT` (5). */
  readonly stepDeg?: number;
  /** `r`, an integer ≥ 1; default {@link JOINT_RADIUS_DEFAULT} (4). */
  readonly radius?: number;
  /** Reuse rotations across calls; missing: a private cache for this call. */
  readonly cache?: PartRenderCache;
}

/** One joint of a {@link JointCheckReport}: the child bone, its parent and the {@link JointGapResult}. */
export interface JointCheckJoint extends JointGapResult {
  /** The child bone's name. */
  readonly bone: string;
  /** The parent bone's name. */
  readonly parent: string;
}

/** Result of {@link jointCheck} (contract section 6.2). A rig passes when `summary.gapCount === 0`. */
export interface JointCheckReport {
  /** The checked view's name. */
  readonly view: string;
  readonly params: { readonly rangeDeg: number; readonly stepDeg: number; readonly radius: number };
  /** One entry per joint, sorted by `bone` name in code-unit order. */
  readonly joints: JointCheckJoint[];
  readonly summary: {
    readonly joints: number;
    readonly jointsWithGaps: number;
    readonly gapCount: number;
    readonly unionCount: number;
  };
}

/** The angles `k·S`, `k ≠ 0`, `|k·S| ≤ R`, ascending (contract section 3.2). */
function sweepAngles(range: number, step: number): number[] {
  if (!Number.isFinite(range) || range <= 0) {
    throw new RigError('BAD_VALUE', `rangeDeg must be a finite number > 0, got ${String(range)}`);
  }
  if (!Number.isFinite(step) || step <= 0) {
    throw new RigError('BAD_VALUE', `stepDeg must be a finite number > 0, got ${String(step)}`);
  }
  let n = Math.floor(range / step);
  while ((n + 1) * step <= range) n++;
  while (n > 0 && n * step > range) n--;
  if (n > MAX_SWEEP_ANGLES) {
    throw new RigError(
      'BAD_VALUE',
      `the sweep has ${String(2 * n)} angles (at most ${String(2 * MAX_SWEEP_ANGLES)})`,
    );
  }
  const out: number[] = [];
  for (let k = -n; k <= n; k++) if (k !== 0) out.push(k * step);
  return out;
}

/** Adds the opaque pixels of `part`'s pre-override render (clipped to the canvas) to `mask`. */
function paint(
  mask: Uint8Array,
  w: number,
  h: number,
  part: PartRender,
  palette: Palette | undefined,
): void {
  const img: RotatableImage = part.base.image;
  const { x: ox, y: oy } = part.base.offset;
  let opaque: (x: number, y: number) => boolean;
  if (img instanceof IndexedImage) {
    const idx = img.toIndices();
    const t = img.transparentIndex;
    opaque = (x, y) => {
      const i = idx[y * img.width + x] ?? t;
      if (palette === undefined) return i !== t;
      const c = palette[i];
      if (c === undefined) {
        throw new RigError(
          'BAD_VALUE',
          `part ${part.partId}: index ${String(i)} is not in the palette`,
        );
      }
      return c[3] > 0;
    };
  } else {
    const data = img.toRGBA().data;
    opaque = (x, y) => (data[(y * img.width + x) * 4 + 3] ?? 0) > 0;
  }
  for (let y = Math.max(0, -oy); y < Math.min(img.height, h - oy); y++) {
    for (let x = Math.max(0, -ox); x < Math.min(img.width, w - ox); x++) {
      if (opaque(x, y)) mask[(y + oy) * w + x + ox] = 1;
    }
  }
}

const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The joint coverage check of a rig in one view (FR-RIG-05; `docs/contracts/JOINT_CHECK.md` sections
 * 3.2 and 6.2). Every bone B with a parent bone A, both with at least one visible part in the view, is a
 * joint. With A at rest, B's parts are rendered with only B's bone key set to θ (relative to rest) for
 * every θ = k·S, k ≠ 0, |k·S| ≤ R, through `renderParts` (FR-RIG-20 steps 1 to 3: snapping, the view's
 * variant, the part's rotation algorithm, pivot alignment). Overrides, post-passes, skins, pixel layers,
 * other bones' parts and B's own children are left out. The masks go to {@link jointGaps} with
 * `pivot` = B's snapped rest pivot and `childDir` = B's rest world angle.
 *
 * Reports bone names; joints are sorted by `bone` in code-unit order. A bone without visible parts is
 * skipped and its children are not re-attached to a farther ancestor. Sweep angles are key angles: an
 * `angleQuantum` coarser than `stepDeg` rounds the rendered rotation (the report still lists θ).
 * Pure and deterministic.
 *
 * Throws `RigError` (`BAD_VALUE` for a bad `rangeDeg`, `stepDeg` or `canvas`, plus everything
 * `renderParts`, `selectView` and `snapSkeleton` throw) and {@link JointCheckError} (`BAD_RADIUS`).
 */
export function jointCheck(input: JointCheckInput): JointCheckReport {
  const { rig, images, canvas } = input;
  const rangeDeg = input.rangeDeg ?? JOINT_SWEEP_DEG_DEFAULT;
  const stepDeg = input.stepDeg ?? JOINT_STEP_DEG_DEFAULT;
  const radius = input.radius ?? JOINT_RADIUS_DEFAULT;
  const quantum = input.angleQuantum ?? ANGLE_QUANTUM_DEFAULT;
  const w = canvas.w;
  const h = canvas.h;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new RigError(
      'BAD_VALUE',
      `canvas must be at least 1×1 whole pixels, got ${String(w)}×${String(h)}`,
    );
  }
  if (!Number.isInteger(radius) || radius < 1) {
    throw new JointCheckError('BAD_RADIUS', `radius must be an integer ≥ 1, got ${String(radius)}`);
  }
  const angles = sweepAngles(rangeDeg, stepDeg);
  const view = selectView(rig, input.direction);
  const cache = input.cache ?? createPartCache();
  const partKeys = input.partKeys ?? {};
  const frameId = (i: number): FrameId => `frm_joint${String(i)}` as FrameId;
  const animation = (
    keys: readonly Partial<Record<BoneId, { angle: number }>>[],
  ): PartAnimation => ({
    ...(input.direction === undefined ? {} : { direction: input.direction }),
    loop: 'once',
    angleQuantum: quantum,
    frames: keys.map((boneKeys, i) => ({ id: frameId(i), boneKeys, partKeys })),
    overrides: [],
  });
  const render = (
    anim: PartAnimation,
    frame: number,
    layers?: RenderPartsInput['layers'],
  ): PartRender[] =>
    renderParts({
      rig,
      animation: anim,
      frame,
      images,
      cache,
      ...(layers === undefined ? {} : { layers }),
    });

  // Rest render: each bone's visible parts as one mask.
  const restMasks = new Map<BoneId, Uint8Array>();
  for (const part of render(animation([{}]), 0)) {
    let m = restMasks.get(part.boneId);
    if (m === undefined) {
      m = new Uint8Array(w * h);
      restMasks.set(part.boneId, m);
    }
    paint(m, w, h, part, input.palette);
  }
  const rest = snapSkeleton(rig, view, new Map(), { angleQuantum: quantum });
  const byId = new Map(rig.bones.map((b) => [b.id, b]));

  const joints: JointCheckJoint[] = [];
  for (const bone of rig.bones) {
    if (bone.parentId === undefined) continue;
    const parentMask = restMasks.get(bone.parentId);
    const childRest = restMasks.get(bone.id);
    const parentBone = byId.get(bone.parentId);
    const snapped = rest.bones.get(bone.id);
    if (
      parentMask === undefined ||
      childRest === undefined ||
      parentBone === undefined ||
      snapped === undefined
    ) {
      continue;
    }
    const layers = rig.parts.filter((p) => p.boneId === bone.id).map((p) => p.layerId);
    const anim = animation(angles.map((angle) => ({ [bone.id]: { angle } })));
    const frames: MaskFrame[] = angles.map((angle, i) => {
      const child = new Uint8Array(w * h);
      for (const part of render(anim, i, layers)) {
        if (part.boneId === bone.id) paint(child, w, h, part, input.palette);
      }
      return { angle, child };
    });
    const res = gapsOnMasks(
      w,
      h,
      parentMask,
      childRest,
      frames,
      [snapped.pivot.x, snapped.pivot.y],
      snapped.restAngle,
      radius,
    );
    joints.push({ bone: bone.name, parent: parentBone.name, ...res });
  }
  joints.sort((a, b) => codeUnit(a.bone, b.bone));
  return {
    view: view.name,
    params: { rangeDeg, stepDeg, radius },
    joints,
    summary: {
      joints: joints.length,
      jointsWithGaps: joints.filter((j) => j.gapCount > 0).length,
      gapCount: joints.reduce((n, j) => n + j.gapCount, 0),
      unionCount: joints.reduce((n, j) => n + j.union.length, 0),
    },
  };
}
