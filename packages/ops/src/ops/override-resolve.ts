/**
 * `override.resolve`: keep, re-base or discard stale overrides (FR-RIG-22).
 * @packageDocumentation
 */
import { checkOverrides, discardOverrides, rebaseOverrides } from '@pixel-forge/core';
import type { OverrideId } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { partRenderer } from '../part-renderer.js';
import { DocRef } from '../refs.js';

/** `override.resolve` (MCP `override_resolve`, CLI `pf override resolve`). */
export const overrideResolve = defineOp({
  name: 'override.resolve',
  safety: 'mutate',
  group: 'rig',
  summary: 'Resolve overrides: "keep" them, "rebase" onto the current art, or "discard" them.',
  description:
    'Name overrides by id (from override_list) or pass allStale: true. "keep" changes nothing (a stale override is still applied) and just confirms the ids exist. "rebase" accepts the art under the override as the new base, so it stops being stale; the frame must render. "discard" deletes the override and its pixels. With allStale, overrides that fail to render or have no target are left out of a rebase and listed in skipped. Check the frame with render_frame after a discard.',
  input: z.strictObject({
    doc: DocRef,
    action: z.enum(['keep', 'rebase', 'discard']).describe('What to do with them.'),
    overrides: z.array(z.string().min(1)).optional().describe('Override ids ("ovr_...").'),
    allStale: z
      .boolean()
      .default(false)
      .describe('Also include every stale override of the document (default false).'),
  }),
  output: z.strictObject({
    action: z.enum(['keep', 'rebase', 'discard']),
    resolved: z.array(z.string()).describe('Override ids the action applied to.'),
    skipped: z
      .array(z.string())
      .describe('allStale rebase: ids left out because they fail to render or have no target.'),
  }),
  examples: [
    {
      title: 'Re-base every stale override after reviewing the render',
      input: { doc: 'doc_g1ed5q', action: 'rebase', allStale: true },
      output: { action: 'rebase', resolved: [], skipped: [] },
    },
  ],
  handler: (ctx, input) => {
    const ids = [...(input.overrides ?? [])] as OverrideId[];
    if (ids.length === 0 && !input.allStale) {
      throw new OpError('BAD_INPUT', 'name overrides or pass allStale: true', {
        issues: [{ path: 'overrides', message: 'give override ids, or allStale: true' }],
      });
    }
    const rig = partRenderer(ctx);
    const opts = rig === undefined ? {} : { rig };
    const skipped: string[] = [];
    if (input.allStale) {
      for (const s of checkOverrides(ctx.view, opts)) {
        if (!s.stale || ids.includes(s.overrideId)) continue;
        // A rebase needs a rendered target: one that fails to render, or has none, is left out.
        if (input.action === 'rebase' && (s.reason === 'error' || s.reason === 'no-target')) {
          skipped.push(s.overrideId);
        } else ids.push(s.overrideId);
      }
    }
    if (input.action === 'rebase') rebaseOverrides(ctx.tx, ids, opts);
    else if (input.action === 'discard') discardOverrides(ctx.tx, ids);
    else {
      // keep: nothing to change, but unknown ids are still an error.
      const known = new Set(ctx.doc.animations.flatMap((a) => a.overrides.map((o) => o.id)));
      const missing = ids.find((id) => !known.has(id));
      if (missing !== undefined) {
        throw new OpError('NOT_FOUND', `no override ${missing}`, {
          kind: 'override',
          ref: missing,
          available: [...known].slice(0, 50),
        });
      }
    }
    return { action: input.action, resolved: ids, skipped };
  },
});
