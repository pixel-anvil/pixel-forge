/**
 * References used by the operation API (spec 6.3). Indices are resolved to ids at the boundary.
 * @packageDocumentation
 */
import { z } from 'zod';
import { AnimationId, FrameId } from './ids.js';
import { DirectionName, Name } from './primitives.js';

/** An animation by `(group, direction)`; a missing direction means the undirected animation. */
export const AnimKeyRef = z.strictObject({
  group: Name,
  direction: DirectionName.exactOptional(),
});
/** An animation by `(group, direction)`. */
export type AnimKeyRef = z.infer<typeof AnimKeyRef>;

/** An animation by id. */
export const AnimIdRef = z.strictObject({ id: AnimationId });
/** An animation by id. */
export type AnimIdRef = z.infer<typeof AnimIdRef>;

/** An animation reference: `{group, direction?}` or `{id}`. */
export const AnimRef = z.union([AnimKeyRef, AnimIdRef]);
/** An animation reference. */
export type AnimRef = z.infer<typeof AnimRef>;

/** A frame reference within an animation: a 0-based index or a {@link FrameId}. */
export const FrameRef = z.union([z.int().min(0), FrameId]);
/** A frame reference within an animation. */
export type FrameRef = z.infer<typeof FrameRef>;
