/**
 * The rig render hook: the contract between `renderFrame` (core, T2.3) and the part render pipeline
 * (rig `renderParts` plus its core adapter, T3.3). Types only.
 *
 * `renderFrame` takes the renderer as an option (`renderFrame(view, anim, frame, { rig })`) rather
 * than a store registration: it stays a pure function of a {@link DocumentView} (the store, a snapshot
 * or an open transaction), and one renderer instance, with its `(variant, angle)` cache, can serve
 * any number of views. The op context (T5.1) owns one renderer per document host.
 * @packageDocumentation
 */
import type {
  AuthoredAnimation,
  Frame,
  LayerId,
  PartId,
  PartLayer,
  Point,
} from '@pixel-forge/schema';
import type { StoredImage } from './images.js';
import type { DeepReadonly } from './json.js';
import type { DocumentView } from './view.js';

/** What `renderFrame` hands the rig renderer for one frame of an authored animation. */
export interface RigFrameContext {
  /** The document and images being rendered. Frozen and immutable: safe as memo keys. */
  readonly view: DocumentView;
  /**
   * The authored animation that owns the frame. For a mirror animation this is its source (the
   * mirror's flip and extra overrides are applied by `renderFrame`, T3.6).
   */
  readonly animation: DeepReadonly<AuthoredAnimation>;
  /** Index of `frame` in `animation.frames`. */
  readonly frameIndex: number;
  readonly frame: DeepReadonly<Frame>;
  /**
   * The part layers `renderFrame` will composite, bottom to top in layer-tree order, already filtered
   * by visibility (layer and ancestors), the `export` filter and the `layers` option. Never empty.
   */
  readonly partLayers: readonly DeepReadonly<PartLayer>[];
}

/** One rendered part: FR-RIG-20 steps 3 and 4 (variant, rotation, pivot alignment, part overrides). */
export interface RenderedPart {
  /** The part layer this part draws into (one of `ctx.partLayers`). */
  readonly layerId: LayerId;
  readonly partId: PartId;
  /** Composite order (step 5): ascending `z`, ties in `ctx.partLayers` order. */
  readonly z: number;
  /**
   * The part's pixels, in the document's colour mode (`TiledImage` for RGBA, `IndexedImage` for
   * indexed). Layer opacity is not applied: `renderFrame` applies the layer's and its groups' opacity.
   */
  readonly image: StoredImage;
  /** Canvas position of the image's top-left pixel (integers). */
  readonly offset: DeepReadonly<Point>;
}

/**
 * Implemented by the rig pipeline (T3.3), called by `renderFrame` (T2.3) for frames that include at
 * least one part layer. Contract:
 *
 * - **Pure and deterministic**: the result depends only on `ctx` (no clock, no randomness, integer
 *   maths, NFR-02). Caches are allowed if they key on immutable inputs: published images and frozen
 *   document nodes never change, so `WeakMap`s keyed by them stay valid across versions.
 * - **Read-only**: never mutate `ctx`, the document or any image from `ctx.view`; return new images.
 * - `renderParts` covers FR-RIG-20 steps 1 to 4 and returns the visible parts (an invisible part, by
 *   view visibility or part key, is omitted). `renderFrame` composites them in `z` order with the
 *   pixel layers (step 5).
 * - `finishFrame`, if present, covers steps 6 and 7 (post-passes, then final overrides) on the full
 *   frame composite and returns the result; it may return a new image or `composite` itself, but must
 *   not keep a reference to it. `renderFrame` then applies the skin (step 8).
 */
export interface RigRenderer {
  /** FR-RIG-20 steps 1 to 4: the visible rendered parts of `ctx.frame`. */
  renderParts(ctx: RigFrameContext): readonly RenderedPart[];
  /** FR-RIG-20 steps 6 and 7 on the whole composite (after parts and pixel layers). */
  finishFrame?(ctx: RigFrameContext, composite: StoredImage): StoredImage;
}
