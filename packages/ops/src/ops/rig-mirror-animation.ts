/**
 * `rig.mirrorAnimation`: add a derived, horizontally flipped copy of an animation under another direction.
 * @packageDocumentation
 */
import { DirectionName } from '@pixel-forge/schema';
import type { MirrorAnimation } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { AnimRef, DocRef, animationLabel, resolveAnimation } from '../refs.js';

/** `rig.mirrorAnimation` (MCP `rig_mirror_animation`, CLI `pf rig mirror-animation`). */
export const rigMirrorAnimation = defineOp({
  name: 'rig.mirrorAnimation',
  safety: 'mutate',
  summary:
    'Add a mirror of an animation under a new direction: same group, flipped around the origin.',
  description:
    "The mirror stores no frames or pixels: it plays the source flipped horizontally about the document origin (markers flip too, names stay), so editing the source updates it. Asymmetric art needs a separate animation. The mirror takes the source's group and loop; the direction must be new for that group (I6). A source cannot be a mirror itself. Final overrides of the mirror can be added later with pixels_write_grid on the mirror.",
  input: z.strictObject({
    doc: DocRef,
    source: AnimRef.describe('The animation to mirror (an authored one, not itself a mirror).'),
    direction: DirectionName.describe('Direction of the mirror, e.g. "left" for a "right" source.'),
  }),
  output: z.strictObject({
    animation: z.string().describe('Id of the new mirror animation.'),
    label: z.string().describe('"group/direction" of the mirror.'),
    mirrorOf: z.string().describe('Label of the source.'),
  }),
  examples: [
    {
      title: 'Mirror the hero idle as its left-facing twin',
      input: { doc: 'doc_g1ed5q', source: { group: 'default' }, direction: 'left' },
    },
  ],
  handler: (ctx, input) => {
    const { animation: src } = resolveAnimation(ctx.doc, input.source);
    if ('mirrorOf' in src) {
      throw new OpError('REFUSED', `${animationLabel(src)} is itself a mirror; mirror its source`, {
        reason: 'mirror-of-mirror',
        animation: src.id,
      });
    }
    const taken = ctx.doc.animations.find(
      (a) => a.group === src.group && a.direction === input.direction,
    );
    if (taken !== undefined) {
      throw new OpError(
        'REFUSED',
        `animation ${animationLabel(taken)} already exists; pick another direction`,
        { reason: 'animation-exists', animation: taken.id },
      );
    }
    const id = ctx.tx.newId('animation');
    const mirror: MirrorAnimation = {
      id,
      group: src.group,
      direction: input.direction,
      mirrorOf: src.id,
      overrides: [],
    };
    ctx.tx.update((d) => {
      d.animations.push(mirror);
    });
    return { animation: id, label: animationLabel(mirror), mirrorOf: animationLabel(src) };
  },
});
