/**
 * The core adapter of the part render pipeline (T3.3): `rig`'s pure `renderParts` (FR-RIG-20 steps 1
 * to 4) behind the {@link RigRenderer} hook that `renderFrame` calls. Core keeps steps 5 to 8.
 * @packageDocumentation
 */
import { RasterError } from '@pixel-forge/raster';
import { PART_RENDER_KEY, RigError, createPartCache, renderParts } from '@pixel-forge/rig';
import type { PartRender, PartRenderCache } from '@pixel-forge/rig';
import type { AuthoredAnimation, LayerId } from '@pixel-forge/schema';
import { CoreError } from './errors.js';
import type { DeepReadonly } from './json.js';
import type { RenderedPart, RigFrameContext, RigRenderer } from './rig-hook.js';
import type { DocumentView } from './view.js';

/**
 * The document's rig renderer: a {@link RigRenderer} for `renderFrame` plus the full part renders
 * that override checks need. One instance (one rotation cache) serves any number of views and
 * document versions; the op context owns one per document host.
 */
export interface PartRenderer extends RigRenderer {
  /** Always set: `PART_RENDER_KEY`, so `renderInputKey` narrows the rig part of the key. */
  readonly renderKey: string;
  /** The `(variant, angle)` rotation cache shared by every call. */
  readonly cache: PartRenderCache;
  /**
   * Every visible part of one frame, whatever the layer visibility and filters, with its
   * pre-override render (`base`): the targets of the part overrides' `baseHash` (FR-RIG-22). Empty
   * when the document has no rig.
   */
  frameParts(
    view: DocumentView,
    animation: DeepReadonly<AuthoredAnimation>,
    frameIndex: number,
  ): readonly PartRender[];
}

/** Runs `fn`, turning rig and raster errors into `CoreError`s (`IMAGE_MISSING`, or `BAD_VALUE` with reason `BAD_RIG`). */
export function rigCall<R>(fn: () => R): R {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RigError) {
      if (e.code === 'IMAGE_MISSING') throw new CoreError('IMAGE_MISSING', e.message);
      if (e.code === 'BAD_ARGUMENT') {
        throw new CoreError('BAD_ARGUMENT', `rig: ${e.message}`, {
          reason: e.reason ?? 'BAD_RIG',
          rigCode: e.code,
        });
      }
      throw new CoreError('BAD_VALUE', `rig: ${e.message}`, { reason: 'BAD_RIG', rigCode: e.code });
    }
    if (e instanceof RasterError) {
      throw new CoreError('BAD_VALUE', `rig: ${e.message}`, {
        reason: 'BAD_RIG',
        rasterCode: e.code,
      });
    }
    throw e;
  }
}

/**
 * A {@link RigRenderer} over parts that were already rendered (`frameParts` of one frame): it hands
 * `renderFrame` the parts whose layer is among `ctx.partLayers`, so one frame's parts are computed
 * once for both the render and the part-override targets.
 */
export function rendererOver(parts: () => readonly PartRender[]): RigRenderer {
  return {
    renderParts(ctx: RigFrameContext): readonly RenderedPart[] {
      const layers = new Set(ctx.partLayers.map((l) => l.id));
      return parts()
        .filter((p) => layers.has(p.layerId))
        .map((p) => ({
          layerId: p.layerId,
          partId: p.partId,
          z: p.z,
          image: p.image,
          offset: p.offset,
        }));
    },
  };
}

/**
 * Creates the rig renderer to pass as `renderFrame(view, anim, frame, { rig })`. `renderParts`
 * renders the part layers `renderFrame` hands over (`ctx.partLayers`) with `rig`'s `renderParts`:
 * pose and hierarchical snapping, the variant (explicit, else the view default), RotSprite aligned on
 * the snapped pivot, cached per `(variant, angle)`, and the frame's part overrides anchored to the
 * pivot. Core then composites, runs the post-passes, applies the final overrides, flips mirrors and
 * applies the skin (steps 5 to 8). A document without a rig renders no parts; a part layer that no
 * part draws into stays empty.
 *
 * Errors become `CoreError`s: a missing variant or override image is `IMAGE_MISSING`; any other rig
 * or raster refusal (unknown variant, unknown view, bad pivot, an oversized RotSprite source, ...) is
 * `BAD_VALUE` with `details.reason` `BAD_RIG` and `details.rigCode` / `rasterCode`.
 */
export function createRigRenderer(): PartRenderer {
  const cache = createPartCache();
  const render = (
    view: DocumentView,
    animation: DeepReadonly<AuthoredAnimation>,
    frameIndex: number,
    layers: readonly LayerId[] | undefined,
  ): readonly PartRender[] => {
    const rig = view.doc.rig;
    if (rig === undefined) return [];
    return rigCall(() =>
      renderParts({
        rig,
        animation,
        frame: frameIndex,
        images: view,
        cache,
        ...(layers === undefined ? {} : { layers }),
      }),
    );
  };
  return {
    cache,
    renderKey: PART_RENDER_KEY,
    renderParts(ctx: RigFrameContext): readonly RenderedPart[] {
      const layers = ctx.partLayers.map((l) => l.id);
      return rendererOver(() =>
        render(ctx.view, ctx.animation, ctx.frameIndex, layers),
      ).renderParts(ctx);
    },
    frameParts(view, animation, frameIndex) {
      return render(view, animation, frameIndex, undefined);
    },
  };
}
