/**
 * Drawing for the render ops (FR-AI-12): a scaled frame on a checkerboard, and the bone and pivot
 * overlay. Everything is integer maths on dense RGBA8 buffers. Bone tips use raster's table-driven
 * `rotatePoint` (no floating-point trig, ADR-010/012).
 * @packageDocumentation
 */
import { evaluatePose } from '@pixel-forge/rig';
import { rotatePoint } from '@pixel-forge/raster';
import type { AnimRef } from '@pixel-forge/schema';
import type { OpContext } from './context.js';
import { MAX_IMAGE_EDGE } from './image-output.js';
import type { RgbaBuffer } from './image-output.js';
import { OpError } from './errors.js';
import { resolveAnimation, resolveFrame, requireRig, viewForAnimation } from './refs.js';

type Color = readonly [number, number, number, number];

/** Overlay colours: bone lines, pivot fill and pivot outline. */
export const BONE_COLOR: Color = [255, 230, 0, 255];
/** Pivot marker fill. */
export const PIVOT_COLOR: Color = [255, 40, 40, 255];
/** Pivot marker outline. */
export const PIVOT_OUTLINE: Color = [0, 0, 0, 255];
const CHECK_A: Color = [200, 200, 200, 255];
const CHECK_B: Color = [150, 150, 150, 255];
const CHECK_SIZE = 4;

/** One bone of a frame's skeleton in canvas pixels (see {@link boneMarks}). */
export interface BoneMark {
  /** Bone name. */
  readonly name: string;
  /** Parent bone name; missing for a root. */
  readonly parent?: string;
  /** Snapped pivot pixel. */
  readonly pivot: readonly [number, number];
  /** Pixel `length` px from the pivot along the bone's world direction. */
  readonly tip: readonly [number, number];
}

/** Where a frame sits in a dense buffer: top-left corner and integer scale. */
export interface FramePlacement {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  /** Frame size in canvas pixels; drawing is clipped to `size * scale` from the corner. */
  readonly width: number;
  readonly height: number;
}

/**
 * The largest integer scale `<= requested` (default 16) at which a `width` x `height` canvas stays
 * within {@link MAX_IMAGE_EDGE}.
 * @throws OpError `REFUSED` (`reason: 'too-large'`) when even scale 1 does not fit.
 */
export function fitScale(width: number, height: number, requested = 16): number {
  const fit = Math.floor(MAX_IMAGE_EDGE / Math.max(width, height));
  if (fit < 1) {
    throw new OpError(
      'REFUSED',
      `a ${String(width)}x${String(height)} canvas is wider than the ${String(MAX_IMAGE_EDGE)} px image limit`,
      { reason: 'too-large', max: MAX_IMAGE_EDGE },
    );
  }
  return Math.min(requested, fit);
}

/** The frame index (within the source animation) a {@link AnimRef} and frame reference name. */
export function frameIndexOf(
  ctx: OpContext,
  animation: AnimRef,
  frame: Parameters<typeof resolveFrame>[1],
): number {
  const { animation: resolved } = resolveAnimation(ctx.doc, animation);
  const source =
    'mirrorOf' in resolved ? ctx.doc.animations.find((a) => a.id === resolved.mirrorOf) : resolved;
  if (source === undefined || !('frames' in source)) {
    throw new OpError('REFUSED', 'the mirror source has no frames', { reason: 'broken-mirror' });
  }
  return resolveFrame(source, frame).index;
}

/**
 * The skeleton of one frame in canvas pixels, parents first (a mirror animation is its source's
 * skeleton flipped about the document origin, as its render is). Bones the animation's view does not
 * use are left out.
 * @throws OpError `REFUSED` (`no-rig`), `NOT_FOUND` (no view draws the animation's direction).
 */
export function boneMarks(ctx: OpContext, animation: AnimRef, frameIndex: number): BoneMark[] {
  const doc = ctx.doc;
  const rig = requireRig(doc);
  const { animation: resolved } = resolveAnimation(doc, animation);
  const mirrored = 'mirrorOf' in resolved;
  const source = mirrored ? doc.animations.find((a) => a.id === resolved.mirrorOf) : resolved;
  if (source === undefined || !('frames' in source)) {
    throw new OpError('REFUSED', 'the mirror source has no frames', { reason: 'broken-mirror' });
  }
  const view = viewForAnimation(doc, source);
  const skeleton = evaluatePose(rig, view, source, frameIndex);
  const nameOf = new Map(rig.bones.map((b) => [b.id, b.name]));
  const lengthOf = new Map(rig.bones.map((b) => [b.id, b.length]));
  const flipX = (x: number): number => (mirrored ? 2 * doc.meta.origin.x - x : x);
  const out: BoneMark[] = [];
  for (const bone of skeleton.bones.values()) {
    if (!bone.inView) continue;
    const [dx, dy] = rotatePoint(lengthOf.get(bone.id) ?? 0, 0, bone.worldAngle);
    const parent = bone.parentId === undefined ? undefined : nameOf.get(bone.parentId);
    out.push({
      name: nameOf.get(bone.id) ?? bone.id,
      ...(parent === undefined ? {} : { parent }),
      pivot: [flipX(bone.pivot.x), bone.pivot.y],
      tip: [flipX(bone.pivot.x + dx), bone.pivot.y + dy],
    });
  }
  return out;
}

function fill(
  dst: RgbaBuffer,
  clip: readonly [number, number, number, number],
  x: number,
  y: number,
  w: number,
  h: number,
  c: Color,
): void {
  const x0 = Math.max(clip[0], x);
  const y0 = Math.max(clip[1], y);
  const x1 = Math.min(clip[2], x + w);
  const y1 = Math.min(clip[3], y + h);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) dst.data.set(c, (yy * dst.width + xx) * 4);
  }
}

/** A blank buffer of `width` x `height` filled with the checkerboard used behind transparent pixels. */
export function checkerBuffer(width: number, height: number): RgbaBuffer {
  const data = new Uint8Array(width * height * 4);
  const buf = { width, height, data };
  for (let y = 0; y < height; y += CHECK_SIZE) {
    for (let x = 0; x < width; x += CHECK_SIZE) {
      const c = ((x + y) / CHECK_SIZE) % 2 === 0 ? CHECK_A : CHECK_B;
      fill(buf, [0, 0, width, height], x, y, CHECK_SIZE, CHECK_SIZE, c);
    }
  }
  return buf;
}

/**
 * Draws `src` (straight alpha) over `dst` with its top-left at `(x, y)`, every pixel enlarged to a
 * `scale` x `scale` block; clipped to `dst`.
 */
export function blitOver(
  dst: RgbaBuffer,
  src: RgbaBuffer,
  x: number,
  y: number,
  scale: number,
): void {
  for (let sy = 0; sy < src.height; sy++) {
    for (let sx = 0; sx < src.width; sx++) {
      const o = (sy * src.width + sx) * 4;
      const a = src.data[o + 3] ?? 0;
      if (a === 0) continue;
      const r = src.data[o] ?? 0;
      const g = src.data[o + 1] ?? 0;
      const b = src.data[o + 2] ?? 0;
      for (let dy = 0; dy < scale; dy++) {
        const yy = y + sy * scale + dy;
        if (yy < 0 || yy >= dst.height) continue;
        for (let dx = 0; dx < scale; dx++) {
          const xx = x + sx * scale + dx;
          if (xx < 0 || xx >= dst.width) continue;
          const p = (yy * dst.width + xx) * 4;
          if (a === 255) {
            dst.data.set([r, g, b, 255], p);
            continue;
          }
          const inv = 255 - a;
          const blend = (s: number, d: number): number => Math.round((s * a + d * inv) / 255);
          dst.data.set(
            [
              blend(r, dst.data[p] ?? 0),
              blend(g, dst.data[p + 1] ?? 0),
              blend(b, dst.data[p + 2] ?? 0),
              255,
            ],
            p,
          );
        }
      }
    }
  }
}

/**
 * Draws the bone lines (pivot to tip, yellow) and then the pivot markers (red squares with a black
 * outline) of one frame into `dst`, clipped to the frame's rectangle. A canvas pixel `(px, py)` is
 * drawn through its centre.
 */
export function paintMarks(
  dst: RgbaBuffer,
  at: FramePlacement,
  marks: readonly BoneMark[],
  options: { bones: boolean; pivots: boolean },
): void {
  const clip = [
    Math.max(0, at.x),
    Math.max(0, at.y),
    Math.min(dst.width, at.x + at.width * at.scale),
    Math.min(dst.height, at.y + at.height * at.scale),
  ] as const;
  const k = at.scale;
  const centre = (p: readonly [number, number]): [number, number] => [
    at.x + p[0] * k + Math.floor(k / 2),
    at.y + p[1] * k + Math.floor(k / 2),
  ];
  const brush = k >= 8 ? 2 : 1;
  if (options.bones) {
    for (const m of marks) {
      const [x0, y0] = centre(m.pivot);
      const [x1, y1] = centre(m.tip);
      // Bresenham line in buffer pixels.
      const dx = Math.abs(x1 - x0);
      const dy = -Math.abs(y1 - y0);
      // A tip far outside the canvas (a huge bone length) is not worth walking.
      if (Math.max(dx, -dy) > 8 * MAX_IMAGE_EDGE) continue;
      const sx = x0 < x1 ? 1 : -1;
      const sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      let x = x0;
      let y = y0;
      for (;;) {
        fill(dst, clip, x, y, brush, brush, BONE_COLOR);
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) {
          err += dy;
          x += sx;
        }
        if (e2 <= dx) {
          err += dx;
          y += sy;
        }
      }
    }
  }
  if (options.pivots) {
    const size = Math.max(3, k);
    for (const m of marks) {
      const [cx, cy] = centre(m.pivot);
      const x = cx - Math.floor(size / 2);
      const y = cy - Math.floor(size / 2);
      fill(dst, clip, x - 1, y - 1, size + 2, size + 2, PIVOT_OUTLINE);
      fill(dst, clip, x, y, size, size, PIVOT_COLOR);
    }
  }
}
