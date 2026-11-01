/**
 * The shared path from an edited rendered frame to overrides: `pixels.writeGrid` (a text grid) and
 * `override.import` (an edited PNG) both end here, so the attribution call, the renderer and the
 * report shape live once.
 * @packageDocumentation
 */
import { attributeEditTxReport } from '@pixel-forge/core';
import type { Transaction } from '@pixel-forge/core';
import type { Rgba, TiledImage } from '@pixel-forge/raster';
import type { OpContext } from './context.js';
import { partRenderer } from './part-renderer.js';
import type { AnimRef } from './refs.js';

/** Two colours are the same when every channel matches; all alpha-0 colours are one. */
export const sameColor = (a: Rgba, b: Rgba): boolean =>
  (a[3] === 0 && b[3] === 0) || (a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]);

/** What {@link attributeFrameEdit} created. */
export interface FrameEditResult {
  /** Ids of the overrides created, in order. */
  readonly overrides: string[];
  /** Ids of earlier overrides the edit made stale (still applied). */
  readonly newlyStale: string[];
}

/**
 * Writes the differences between the exported render of a frame and `edited` as overrides
 * (`attributeEdit`: a part override where one part owns the change, else a final one).
 * @param tx the transaction to write in (`ctx.tx`, or the one `ctx.transact` hands out)
 * @param edited the rendered frame (`ctx.renderFrame(..., {exportOnly: true})`) with the edits applied
 * @throws CoreError from `attributeEdit` (`BAD_ARGUMENT`, `BAD_VALUE`), mapped by the registry.
 */
export function attributeFrameEdit(
  ctx: OpContext,
  tx: Transaction,
  animation: AnimRef,
  frameIndex: number,
  edited: TiledImage,
): FrameEditResult {
  const rig = partRenderer(ctx);
  const report = attributeEditTxReport(
    tx,
    animation,
    frameIndex,
    edited,
    rig === undefined ? {} : { rig },
  );
  return { overrides: [...report.ids], newlyStale: report.newlyStale.map((s) => s.overrideId) };
}
