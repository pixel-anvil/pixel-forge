/**
 * The host's rig renderer as the override functions of `core` want it.
 * @packageDocumentation
 */
import type { PartRenderer } from '@pixel-forge/core';
import type { OpContext } from './context.js';

/**
 * The host renderer as a `PartRenderer` (the override checks need its `frameParts`), so they share
 * its `(variant, angle)` cache (KNOWN_ISSUES CORE-03). A host with a plain `RigRenderer` gets
 * `undefined`: core then builds a private renderer for the call (correct, only uncached).
 */
export function partRenderer(ctx: OpContext): PartRenderer | undefined {
  const r = ctx.renderer as Partial<PartRenderer>;
  return typeof r.frameParts === 'function' && r.cache !== undefined
    ? (ctx.renderer as PartRenderer)
    : undefined;
}
