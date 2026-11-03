/**
 * `anim.create`: a new authored animation with empty frames.
 * @packageDocumentation
 */
import { AngleQuantum, DirectionName, LoopMode, Name } from '@pixel-forge/schema';
import type { AuthoredAnimation, Frame } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { DocRef, animationLabel } from '../refs.js';

/** An empty frame (no keys, no cels). */
export function emptyFrame(id: Frame['id'], durationMs: number): Frame {
  return {
    id,
    durationMs,
    markers: {},
    events: [],
    rootMotion: { dx: 0, dy: 0 },
    boneKeys: {},
    partKeys: {},
  };
}

/** `anim.create` (MCP `anim_create`, CLI `pf anim create`). */
export const animCreate = defineOp({
  name: 'anim.create',
  safety: 'mutate',
  group: 'core',
  summary: 'Create an animation (group + optional direction) with empty frames of equal duration.',
  description:
    '(group, direction) must be unique. Names: lower-case a-z 0-9 _ - up to 48 characters; omit direction for an undirected animation. Frames start empty: pose them with rig_set_pose, draw into them, or add more with frame_add. Use loop "once" for a one-shot such as a jump: in a "loop" the keys interpolate across the wrap, from the last frame to the first. For a flipped copy of a side animation use rig_mirror_animation.',
  input: z.strictObject({
    doc: DocRef,
    group: Name.describe('Animation group, e.g. "run".'),
    direction: DirectionName.optional().describe('Direction, e.g. "side" (omit for undirected).'),
    loop: LoopMode.default('loop').describe('"loop" (default), "once" or "pingpong".'),
    frames: z.int().min(1).max(1000).default(1).describe('Number of empty frames (default 1).'),
    durationMs: z
      .int()
      .min(1)
      .default(100)
      .describe('Duration of every frame in ms (default 100).'),
    angleQuantum: AngleQuantum.optional().describe(
      'Rig angle quantum, deg (a multiple of 0.25 that divides 360; default 1).',
    ),
  }),
  output: z.strictObject({
    animation: z.string().describe('Animation id.'),
    label: z.string().describe('"group/direction", or "group" when undirected.'),
    frameIds: z.array(z.string()).describe('Frame ids in play order.'),
  }),
  examples: [
    {
      title: 'A 4-frame side run loop at 100 ms',
      input: { doc: 'doc_g1ed5q', group: 'run', direction: 'side', frames: 4 },
    },
  ],
  handler: (ctx, input) => {
    const taken = ctx.doc.animations.find(
      (a) => a.group === input.group && a.direction === input.direction,
    );
    if (taken !== undefined) {
      throw new OpError(
        'REFUSED',
        `animation ${animationLabel(taken)} already exists; pick another group or direction`,
        { reason: 'animation-exists', animation: taken.id },
      );
    }
    const id = ctx.tx.newId('animation');
    const frameIds = Array.from({ length: input.frames }, () => ctx.tx.newId('frame'));
    const anim: AuthoredAnimation = {
      id,
      group: input.group,
      ...(input.direction === undefined ? {} : { direction: input.direction }),
      loop: input.loop,
      ...(input.angleQuantum === undefined ? {} : { angleQuantum: input.angleQuantum }),
      frames: frameIds.map((f) => emptyFrame(f, input.durationMs)),
      overrides: [],
    };
    ctx.tx.update((d) => {
      d.animations.push(anim);
    });
    return { animation: id, label: animationLabel(anim), frameIds };
  },
});
