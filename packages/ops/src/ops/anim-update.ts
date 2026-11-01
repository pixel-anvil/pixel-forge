/**
 * `anim.update`: rename an animation or change its loop mode, angle quantum and post-passes (I6).
 * @packageDocumentation
 */
import { jsonEqual } from '@pixel-forge/core';
import { AngleQuantum, DirectionName, LoopMode, Name, PostPasses } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { AnimRef, DocRef, animationLabel, resolveAnimation } from '../refs.js';

/** `anim.update` (MCP `anim_update`, CLI `pf anim update`). */
export const animUpdate = defineOp({
  name: 'anim.update',
  safety: 'mutate',
  summary:
    'Rename an animation (group, direction), set its loop mode, angle quantum or post-passes.',
  description:
    "(group, direction) must stay unique (I6). Renaming the group of a source animation renames its mirrors too (a mirror shares its source's group); a mirror's group cannot be changed on its own. Loop, angleQuantum and postPasses belong to the source: a mirror has none. null clears direction, angleQuantum or postPasses. Frame durations, markers and events: frame_set_meta.",
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    group: Name.optional().describe('New group name.'),
    direction: DirectionName.nullable()
      .optional()
      .describe('New direction; null makes it undirected.'),
    loop: LoopMode.optional().describe('"loop", "once" or "pingpong".'),
    angleQuantum: AngleQuantum.nullable()
      .optional()
      .describe(
        'Rig angle quantum, deg (multiple of 0.25 dividing 360); null restores the default.',
      ),
    postPasses: PostPasses.nullable()
      .optional()
      .describe(
        'Post-passes after the rig render: {removeOrphans: {}, outline: {color: [r,g,b,a], outsideOnly?, corners?}}; null removes them.',
      ),
  }),
  output: z.strictObject({
    animation: z.string().describe('Animation id.'),
    label: z.string().describe('"group/direction" afterwards.'),
    changed: z.array(z.string()).describe('Fields that changed; empty when nothing did.'),
    mirrors: z.array(z.string()).describe('Labels of the mirror animations renamed with it.'),
  }),
  examples: [
    {
      title: 'Make the hero idle a ping-pong',
      input: { doc: 'doc_g1ed5q', animation: { group: 'default' }, loop: 'pingpong' },
      output: { animation: 'anm_5q60kk', label: 'default', changed: ['loop'], mirrors: [] },
    },
  ],
  handler: (ctx, input) => {
    const { index, animation } = resolveAnimation(ctx.doc, input.animation);
    const mirror = 'mirrorOf' in animation;
    const refuse = (reason: string, message: string): OpError =>
      new OpError('REFUSED', message, { reason, animation: animation.id });
    if (mirror && input.group !== undefined && input.group !== animation.group) {
      throw refuse(
        'mirror-group',
        `${animationLabel(animation)} is a mirror and shares its source's group; rename the source`,
      );
    }
    if (
      mirror &&
      (input.loop !== undefined ||
        input.angleQuantum !== undefined ||
        input.postPasses !== undefined)
    ) {
      throw refuse(
        'mirror-animation',
        `${animationLabel(animation)} is a mirror: loop, angleQuantum and postPasses come from its source`,
      );
    }
    const group = input.group ?? animation.group;
    const direction =
      input.direction === undefined ? animation.direction : (input.direction ?? undefined);
    const mirrors = mirror
      ? []
      : ctx.doc.animations
          .map((a, i) => ({ a, i }))
          .filter(({ a }) => 'mirrorOf' in a && a.mirrorOf === animation.id);

    // I6 over the final state: every (group, direction) once.
    const keys = new Map<string, string>();
    ctx.doc.animations.forEach((a, i) => {
      const g = i === index || mirrors.some((m) => m.i === i) ? group : a.group;
      const d = i === index ? direction : a.direction;
      const key = `${g}\u0000${d ?? ''}`;
      const clash = keys.get(key);
      if (clash !== undefined) {
        throw refuse(
          'animation-exists',
          `animation ${animationLabel({ group: g, ...(d === undefined ? {} : { direction: d }) })} already exists`,
        );
      }
      keys.set(key, a.id);
    });

    const changed: string[] = [];
    if (group !== animation.group) changed.push('group');
    if (direction !== animation.direction) changed.push('direction');
    if (!mirror) {
      if (
        input.loop !== undefined &&
        input.loop !== ('loop' in animation ? animation.loop : undefined)
      ) {
        changed.push('loop');
      }
      if (input.angleQuantum !== undefined) {
        const next = input.angleQuantum ?? undefined;
        if (next !== ('angleQuantum' in animation ? animation.angleQuantum : undefined)) {
          changed.push('angleQuantum');
        }
      }
      if (input.postPasses !== undefined) {
        const next = input.postPasses ?? undefined;
        const had = 'postPasses' in animation ? animation.postPasses : undefined;
        if (!jsonEqual(next ?? null, had ?? null)) changed.push('postPasses');
      }
    }
    if (changed.length > 0) {
      ctx.tx.update((d) => {
        const a = d.animations[index];
        if (a === undefined) return;
        a.group = group;
        if (direction === undefined) delete a.direction;
        else a.direction = direction;
        if ('frames' in a) {
          if (input.loop !== undefined) a.loop = input.loop;
          if (input.angleQuantum === null) delete a.angleQuantum;
          else if (input.angleQuantum !== undefined) a.angleQuantum = input.angleQuantum;
          if (input.postPasses === null) delete a.postPasses;
          else if (input.postPasses !== undefined) a.postPasses = input.postPasses;
        }
        for (const m of mirrors) {
          const ma = d.animations[m.i];
          if (ma !== undefined) ma.group = group;
        }
      });
    }
    const after = ctx.doc.animations[index];
    return {
      animation: animation.id,
      label: animationLabel(after ?? animation),
      changed,
      mirrors: changed.includes('group')
        ? mirrors.map((m) => animationLabel(ctx.doc.animations[m.i] ?? m.a))
        : [],
    };
  },
});
