/**
 * `override.list`: every override with its state, stale ones apart from render errors (CORE-03).
 * @packageDocumentation
 */
import { checkOverrides } from '@pixel-forge/core';
import type { OverrideStatus } from '@pixel-forge/core';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { partRenderer } from '../part-renderer.js';
import { AnimRef, DocRef, animationLabel, partNamer } from '../refs.js';

const Entry = z.strictObject({
  id: z.string().describe('Override id (for override_resolve).'),
  animation: z.string().describe('"group/direction" of the animation owning it.'),
  frameIndex: z.int().describe("Frame index in the animation (the source's for a mirror)."),
  frameId: z.string(),
  target: z.string().describe('"final" (whole composite) or the part layer name.'),
  mirror: z.boolean().describe("True for a mirror animation's own final override."),
  reason: z
    .enum(['hash', 'no-target', 'error'])
    .optional()
    .describe(
      '"hash": the pixels under it changed; "no-target": nothing to compare with (hidden part, deleted frame); "error": it could not be rendered.',
    ),
  errorCode: z.string().optional().describe('reason "error": the core error code.'),
  errorMessage: z.string().optional().describe('reason "error": why the render failed.'),
});

/** `override.list` (MCP `override_list`, CLI `pf override list`). */
export const overrideList = defineOp({
  name: 'override.list',
  safety: 'read',
  group: 'rig',
  summary:
    'List overrides: stale ones (art under them changed) and ones that fail to render, apart.',
  description:
    'Renders the frames that have overrides. "stale" overrides are still applied; decide with override_resolve (keep, rebase = accept the current art, discard). "errors" cannot be judged because their frame does not render (missing image, no view for the direction...): fix the rig first, they cannot be rebased until it renders. Part overrides of mirror animations are never rendered and not listed.',
  input: z.strictObject({
    doc: DocRef,
    animations: z.array(AnimRef).optional().describe('Only these animations (default: all).'),
  }),
  output: z.strictObject({
    counts: z.strictObject({
      total: z.int(),
      valid: z.int(),
      stale: z.int().describe('Stale, excluding render errors.'),
      errors: z.int().describe('Overrides whose render failed.'),
    }),
    stale: z.array(Entry).describe('Stale overrides (reason "hash" or "no-target").'),
    errors: z.array(Entry).describe('Overrides whose render failed (reason "error").'),
    valid: z.array(z.string()).describe('Ids of the overrides that are up to date.'),
  }),
  examples: [{ title: 'List the hero overrides', input: { doc: 'doc_g1ed5q' } }],
  handler: (ctx, input) => {
    const doc = ctx.doc;
    const rig = partRenderer(ctx);
    const statuses = checkOverrides(ctx.view, {
      ...(input.animations === undefined ? {} : { animations: input.animations }),
      ...(rig === undefined ? {} : { rig }),
    });
    const nameOf = doc.rig === undefined ? undefined : partNamer(doc);
    const entry = (s: OverrideStatus): z.infer<typeof Entry> => {
      const anim = doc.animations.find((a) => a.id === s.animationId);
      const source =
        anim !== undefined && 'mirrorOf' in anim
          ? doc.animations.find((a) => a.id === anim.mirrorOf)
          : anim;
      const frames = source !== undefined && 'frames' in source ? source.frames : [];
      const target =
        s.target === 'final'
          ? 'final'
          : (() => {
              const partId = s.target.partId;
              const part = doc.rig?.parts.find((p) => p.id === partId);
              return part === undefined || nameOf === undefined ? partId : nameOf(part);
            })();
      return {
        id: s.overrideId,
        animation: anim === undefined ? s.animationId : animationLabel(anim),
        frameIndex: frames.findIndex((f) => f.id === s.frameId),
        frameId: s.frameId,
        target,
        mirror: s.mirror,
        ...(s.reason === undefined ? {} : { reason: s.reason }),
        ...(s.errorCode === undefined ? {} : { errorCode: s.errorCode }),
        ...(s.errorMessage === undefined ? {} : { errorMessage: s.errorMessage }),
      };
    };
    const errors = statuses.filter((s) => s.reason === 'error').map(entry);
    const stale = statuses.filter((s) => s.stale && s.reason !== 'error').map(entry);
    const valid = statuses.filter((s) => !s.stale).map((s) => s.overrideId);
    return {
      counts: {
        total: statuses.length,
        valid: valid.length,
        stale: stale.length,
        errors: errors.length,
      },
      stale,
      errors,
      valid,
    };
  },
});
