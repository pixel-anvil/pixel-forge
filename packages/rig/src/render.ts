/**
 * The part render pipeline (FR-RIG-20 steps 1 to 4, FR-RIG-21, FR-RIG-22): pose and snapping, the
 * variant of each part, RotSprite (or nearest / none) aligned on the snapped pivot, the
 * `(variant, angle)` cache, and the part overrides anchored to the pivot. Compositing, post-passes,
 * final overrides, mirrors and skins are core's (`renderFrame`, steps 5 to 8).
 * @packageDocumentation
 */
import {
  IndexedImage,
  ROTSPRITE_VERSION,
  blit,
  flipH,
  prepareRotSprite,
  rotateAbout,
} from '@pixel-forge/raster';
import type { PreparedRotSprite, Rect, RotatableImage } from '@pixel-forge/raster';
import { AUTO_VARIANT } from '@pixel-forge/schema';
import type {
  BoneId,
  FrameId,
  FrameRef,
  ImageId,
  LayerId,
  OverrideId,
  PartId,
  PartKey,
  Point,
  RotationAlgorithm,
  VariantId,
  ViewId,
} from '@pixel-forge/schema';
import {
  addDyadic,
  quantizeDyadic,
  quantumSteps,
  stepsToDeg,
  toDyadic,
  wrapSteps,
} from './angle.js';
import { RigError } from './errors.js';
import {
  type PoseAnimation,
  type PoseFrame,
  type PreparedAnimation,
  checkCoord,
  frameIndex as indexOfFrame,
  keySpan,
  own,
  prepareAnimation,
} from './keys.js';
import type { BoneGraph } from './order.js';
import { paintOverride, unionRect } from './overrides.js';
import type { ImageLookup, OverrideLike, OverrideTargetRender } from './overrides.js';
import { type RestPose, type SnappedBone, evaluatePose, selectView } from './snap.js';

/**
 * Version of the {@link renderParts} output for the same input. Core's render input key (the `.pxf`
 * render cache) includes it: **bump it whenever a change to this pipeline changes any rendered
 * pixel**, so cached frames are re-rendered. A change to the rotation itself is versioned by raster's
 * `ROTSPRITE_VERSION`, which {@link PART_RENDER_KEY} includes, so it needs no bump here.
 */
export const PART_RENDER_VERSION = 1;

/**
 * The identity of the part renderer for caches: {@link PART_RENDER_VERSION} and raster's
 * `ROTSPRITE_VERSION`. Core's rig renderer exposes it as its `renderKey`.
 */
export const PART_RENDER_KEY = `rig${String(PART_RENDER_VERSION)}.rotsprite${String(ROTSPRITE_VERSION)}`;

/** What the renderer reads from a variant. A schema `Variant` (or a deep-readonly one) fits. */
export interface PartVariant {
  readonly id: VariantId;
  readonly viewId: ViewId;
  readonly imageId: ImageId;
  /** Pivot pixel in image coordinates; it may lie outside the image. */
  readonly pivot: Readonly<Point>;
  /** World angle the art was drawn at; missing: the bone's rest angle. */
  readonly drawnAngle?: number;
}

/** What the renderer reads from a part. A schema `Part` (or a deep-readonly one) fits. */
export interface RigPart {
  readonly id: PartId;
  readonly boneId: BoneId;
  readonly layerId: LayerId;
  readonly variants: readonly PartVariant[];
  /** Missing means `rotsprite`. */
  readonly rotation?: RotationAlgorithm;
}

/** What the renderer reads from a view. A schema `View` (or a deep-readonly one) fits. */
export interface PartView extends RestPose {
  readonly id: ViewId;
  readonly directions: readonly string[];
  readonly partVisibility: Readonly<Partial<Record<PartId, boolean>>>;
  readonly defaultZ: Readonly<Partial<Record<PartId, number>>>;
}

/** What the renderer reads from a rig. A schema `Rig` (or a deep-readonly one) fits. */
export interface PartRig extends BoneGraph {
  readonly parts: readonly RigPart[];
  readonly views: readonly PartView[];
}

/** A frame with its part keys. A schema `Frame` (or a deep-readonly one) fits. */
export interface PartFrame extends PoseFrame {
  readonly partKeys: Readonly<Partial<Record<PartId, Readonly<PartKey>>>>;
}

/** An override with the frame it belongs to. A schema `Override` fits. */
export interface FrameOverride extends OverrideLike {
  readonly frameId: FrameId;
}

/** What the renderer reads from an animation. A schema `AuthoredAnimation` (or a deep-readonly one) fits. */
export interface PartAnimation extends PoseAnimation {
  readonly direction?: string;
  readonly frames: readonly PartFrame[];
  readonly overrides: readonly FrameOverride[];
}

/** Input of {@link renderParts}. */
export interface RenderPartsInput {
  readonly rig: PartRig;
  readonly animation: PartAnimation;
  /** A frame id or index of `animation`. */
  readonly frame: FrameRef;
  /** Variant and override images by id. */
  readonly images: ImageLookup;
  /**
   * Render only the parts that draw into these layers; equal `z` keeps this order. Missing: every
   * part of the rig, ties in `rig.parts` order.
   */
  readonly layers?: readonly LayerId[];
  /** Reuse rotations across calls (see {@link createPartCache}). Missing: no reuse. */
  readonly cache?: PartRenderCache;
}

/** An image drawn with its top-left pixel at `offset` (canvas pixels). */
export interface PlacedImage {
  readonly image: RotatableImage;
  readonly offset: Readonly<Point>;
}

/** One rendered, visible part of a frame. */
export interface PartRender {
  readonly partId: PartId;
  readonly layerId: LayerId;
  readonly boneId: BoneId;
  readonly variantId: VariantId;
  /** Composite order: the part key's `z`, else the view's `defaultZ`, else 0. */
  readonly z: number;
  /** Residual rotation applied to the variant, degrees in `[0, 360)`, a multiple of the quantum. */
  readonly angle: number;
  /** Whether the bone's `flipX` mirrored the part about its pivot column. */
  readonly flipX: boolean;
  /** The bone's snapped pivot (canvas pixel); the variant's pivot pixel lands here. */
  readonly pivot: Readonly<Point>;
  /** The part before its overrides (step 3): the target of the part overrides' `baseHash`. */
  readonly base: PlacedImage;
  /** The part after its overrides (step 4), what core composites. May share pixels with `base`. */
  readonly image: RotatableImage;
  readonly offset: Readonly<Point>;
  /** Ids of the part overrides applied, in application order (stale ones included). */
  readonly overrides: readonly OverrideId[];
}

/**
 * The `(variant, angle)` rotation cache of {@link renderParts}. Entries are keyed by the variant
 * object and its image instance (published document nodes and images are immutable, so the keys are
 * weak and stay valid across document versions) plus the algorithm, the residual angle and the flip.
 * A new variant object (a pivot edit) or a new image misses. Treat inputs passed with a cache as
 * immutable snapshots.
 */
export interface PartRenderCache {
  /** Rotation cache hits and misses since creation or the last {@link PartRenderCache.clear}. */
  readonly stats: { hits: number; misses: number };
  /** Drops every entry and resets the stats. */
  clear(): void;
}

interface Rotated {
  readonly image: RotatableImage;
  readonly pivotOut: Readonly<Point>;
}

interface VariantEntry {
  readonly image: RotatableImage;
  readonly version: number;
  readonly px: number;
  readonly py: number;
  readonly prep: PreparedRotSprite<RotatableImage>;
  /** Pivot in the (possibly padded) prepared image. */
  readonly pivot: Readonly<Point>;
  readonly renders: Map<string, Rotated>;
}

/** What one animation needs per frame, computed once (alongside the prepared pose keys). */
interface AnimationData {
  readonly prepared: PreparedAnimation;
  /** Per part and field, the indices of the frames whose part key sets the field. */
  readonly keyed: ReadonlyMap<PartId, Readonly<Record<PartField, readonly number[]>>>;
  /** Per part, then per frame id, the part overrides in array order. */
  readonly overrides: ReadonlyMap<PartId, ReadonlyMap<FrameId, readonly FrameOverride[]>>;
}

interface CacheStore {
  variants: WeakMap<object, VariantEntry>;
  prepared: WeakMap<object, AnimationData>;
  stats: { hits: number; misses: number };
}

const PART_FIELDS = ['variant', 'z', 'visible'] as const;
type PartField = (typeof PART_FIELDS)[number];

function prepareData(rig: PartRig, animation: PartAnimation): AnimationData {
  const keyed = new Map<PartId, Record<PartField, number[]>>();
  animation.frames.forEach((f, i) => {
    for (const id of Object.keys(f.partKeys)) {
      const key = own(f.partKeys, id);
      if (key === undefined) continue;
      let lists = keyed.get(id as PartId);
      if (lists === undefined) {
        lists = { variant: [], z: [], visible: [] };
        keyed.set(id as PartId, lists);
      }
      for (const field of PART_FIELDS) if (key[field] !== undefined) lists[field].push(i);
    }
  });
  const overrides = new Map<PartId, Map<FrameId, FrameOverride[]>>();
  for (const o of animation.overrides) {
    if (o.target === 'final') continue;
    let byFrame = overrides.get(o.target.partId);
    if (byFrame === undefined) {
      byFrame = new Map();
      overrides.set(o.target.partId, byFrame);
    }
    const list = byFrame.get(o.frameId);
    if (list === undefined) byFrame.set(o.frameId, [o]);
    else list.push(o);
  }
  return { prepared: prepareAnimation(rig, animation), keyed, overrides };
}

const STORES = new WeakMap<PartRenderCache, CacheStore>();

/** A fresh {@link PartRenderCache}. Core's rig renderer owns one per document host. */
export function createPartCache(): PartRenderCache {
  const store: CacheStore = {
    variants: new WeakMap(),
    prepared: new WeakMap(),
    stats: { hits: 0, misses: 0 },
  };
  const cache: PartRenderCache = {
    get stats() {
      return store.stats;
    },
    clear(): void {
      store.variants = new WeakMap();
      store.prepared = new WeakMap();
      store.stats.hits = 0;
      store.stats.misses = 0;
    },
  };
  STORES.set(cache, store);
  return cache;
}

/**
 * The variant's image padded so the pivot pixel lies inside it (a pivot may lie outside the drawing,
 * T3.2). RotSprite treats the outside as transparent, so padding never changes the result.
 */
function prepareVariant(
  img: RotatableImage,
  px: number,
  py: number,
): Omit<VariantEntry, 'renders'> {
  const minX = Math.min(0, px);
  const minY = Math.min(0, py);
  const w = Math.max(img.width - 1, px) - minX + 1;
  const h = Math.max(img.height - 1, py) - minY + 1;
  let src = img;
  if (w !== img.width || h !== img.height) {
    const padded = img.emptyLike(w, h);
    blit(padded, img, -minX, -minY);
    src = padded;
  }
  return {
    image: img,
    version: img.version,
    px,
    py,
    prep: prepareRotSprite(src),
    pivot: { x: px - minX, y: py - minY },
  };
}

function rotated(
  store: CacheStore | undefined,
  variant: PartVariant,
  img: RotatableImage,
  angle: number,
  algo: RotationAlgorithm,
  flip: boolean,
): Rotated {
  const { x: px, y: py } = variant.pivot;
  let entry = store?.variants.get(variant);
  if (entry?.image !== img || entry.version !== img.version || entry.px !== px || entry.py !== py) {
    entry = { ...prepareVariant(img, px, py), renders: new Map() };
    store?.variants.set(variant, entry);
  }
  const key = `${algo}|${String(angle)}|${flip ? 'f' : ''}`;
  const hit = entry.renders.get(key);
  if (hit !== undefined) {
    if (store !== undefined) store.stats.hits++;
    return hit;
  }
  if (store !== undefined) store.stats.misses++;
  const r = rotateAbout(entry.prep, entry.pivot, angle, algo);
  const out: Rotated = flip
    ? { image: flipH(r.img), pivotOut: { x: r.img.width - 1 - r.pivotOut.x, y: r.pivotOut.y } }
    : { image: r.img, pivotOut: r.pivotOut };
  entry.renders.set(key, out);
  return out;
}

/**
 * The value of one part-key field at `fi` (R-15): step interpolation over the frames that key the
 * field, with the bone channels' hold rule (`keySpan`): before the first key the first key holds,
 * after the last key the last one holds, and a `loop` animation wraps (before the first key the last
 * key of the previous loop holds). `undefined` when no frame keys the field.
 */
function partKeyValue<F extends PartField>(
  data: AnimationData,
  animation: PartAnimation,
  fi: number,
  partId: PartId,
  field: F,
): PartKey[F] | undefined {
  const keyed = data.keyed.get(partId)?.[field];
  if (keyed === undefined) return undefined;
  const span = keySpan(keyed, fi, animation.frames.length, animation.loop === 'loop');
  if (span === undefined) return undefined;
  const frame = animation.frames[span.from];
  return frame === undefined ? undefined : own(frame.partKeys, partId)?.[field];
}

/** Residual of a variant on `bone` (degrees in `[0, 360)`, a multiple of the quantum). */
function residual(bone: SnappedBone, variant: PartVariant, quantum: number): number {
  if (variant.drawnAngle === undefined) return bone.rotation;
  const d = addDyadic(
    toDyadic(bone.worldAngle, 'worldAngle'),
    toDyadic(-variant.drawnAngle, `variant ${variant.id} drawnAngle`),
  );
  return stepsToDeg(wrapSteps(quantizeDyadic(d, quantumSteps(quantum))));
}

function chooseVariant(
  part: RigPart,
  view: PartView,
  choice: PartKey['variant'],
): PartVariant | undefined {
  if (choice !== undefined && choice !== AUTO_VARIANT) {
    const v = part.variants.find((x) => x.id === choice);
    if (v === undefined) {
      throw new RigError('UNKNOWN_VARIANT', `part ${part.id} has no variant ${choice}`);
    }
    return v;
  }
  // 'auto' (FR-RIG-14) is M1b: until then it means the view's default variant.
  return part.variants.find((x) => x.viewId === view.id);
}

interface ResolvedPartOverride {
  readonly o: FrameOverride;
  readonly set: RotatableImage | undefined;
  readonly erase: RotatableImage | undefined;
}

/**
 * FR-RIG-20 step 4: the part overrides of the frame, in array order, on the part's own render; per
 * override `erase` first (mask value 255 clears), then `set` painted over (RGBA: the "over" blend;
 * indexed: every non-transparent index replaces), both at `pivot + anchor`. The image grows to hold a
 * `set` that reaches past the part.
 */
function applyPartOverrides(
  base: PlacedImage,
  pivot: Readonly<Point>,
  list: readonly ResolvedPartOverride[],
): PlacedImage {
  const baseRect: Rect = {
    x: base.offset.x,
    y: base.offset.y,
    w: base.image.width,
    h: base.image.height,
  };
  let rect = baseRect;
  for (const { o, set } of list) {
    if (set !== undefined && set instanceof IndexedImage !== base.image instanceof IndexedImage) {
      throw new RigError(
        'BAD_VALUE',
        `override ${o.id}: its set image and the part render are not the same colour mode`,
      );
    }
    const b = set?.bounds();
    if (b !== undefined) {
      rect =
        unionRect(rect, {
          x: pivot.x + o.anchor.x + b.x,
          y: pivot.y + o.anchor.y + b.y,
          w: b.w,
          h: b.h,
        }) ?? rect;
    }
  }
  let out: RotatableImage;
  if (
    rect.x === baseRect.x &&
    rect.y === baseRect.y &&
    rect.w === baseRect.w &&
    rect.h === baseRect.h
  ) {
    out = base.image.clone();
  } else {
    out = base.image.emptyLike(rect.w, rect.h);
    blit(out, base.image, baseRect.x - rect.x, baseRect.y - rect.y);
  }
  for (const { o, set, erase } of list) {
    const at = { x: pivot.x + o.anchor.x - rect.x, y: pivot.y + o.anchor.y - rect.y };
    paintOverride(out, at, { erase, set }, `override ${o.id}`);
  }
  return { image: out, offset: { x: rect.x, y: rect.y } };
}

/**
 * FR-RIG-20 steps 1 to 4 for one frame: the visible parts, sorted by ascending `z` (ties in
 * `input.layers` order, else `rig.parts` order). Pure and deterministic: integer maths only, and the
 * result depends only on the input (the cache only saves work).
 *
 * 1. **Pose and snapping**: `evaluatePose` in the animation's view (`selectView`).
 * 2. **Visibility**: a part is drawn when its bone has a rest entry in the view (`inView`), its `visible`
 *    part key (else the view's `partVisibility`, else true) is true, and it has a variant to draw.
 * 3. **Variant**: an explicit `variant` part key wins (any variant of the part, `UNKNOWN_VARIANT`
 *    otherwise); else, or for `'auto'` until FR-RIG-14 lands (M1b), the view's default variant (the
 *    first with the view's id); a part with no variant in the view is not drawn. Part keys step and
 *    hold like the bone channels (`keySpan`, loop wrap included).
 * 4. **Rotation**: the residual is the bone's `rotation` (no `drawnAngle`) or `worldAngle −
 *    drawnAngle` quantised exactly to the animation's quantum, in `[0, 360)`. The variant is rotated
 *    about its pivot pixel with the part's algorithm (`rotsprite` default, `nearest`, `none`; no new
 *    colours, FR-RIG-21), mirrored about its pivot column when the bone has `flipX`, and placed so
 *    the pivot pixel lands exactly on the snapped pivot (`offset = pivot − pivotOut`). Cached per
 *    `(variant, image, algorithm, angle, flip)`.
 * 5. **Part overrides** (step 4): the frame's overrides with `target: {partId}` for this part, in
 *    array order, anchored to the snapped pivot (see `applyPartOverrides`). Stale overrides are still
 *    applied (FR-RIG-22: kept, never moved or dropped); see `staleOverrides`.
 *
 * Returned images may be shared with the cache: never mutate them.
 *
 * Throws the `RigError`s of `evaluatePose` and `selectView`, `UNKNOWN_BONE` (a part's bone is not in
 * the rig), `UNKNOWN_VARIANT`, `IMAGE_MISSING` (a variant or override image), `BAD_VALUE` (a
 * non-integer pivot, a `set` image of the other colour mode), and raster's errors (e.g. a RotSprite
 * source above `ROTSPRITE_MAX_AREA`).
 */
export function renderParts(input: RenderPartsInput): PartRender[] {
  const { rig, animation, images } = input;
  const store = input.cache === undefined ? undefined : STORES.get(input.cache);
  const view = selectView(rig, animation.direction);
  let data = store?.prepared.get(animation);
  if (data?.prepared.rig !== rig) {
    data = prepareData(rig, animation);
    store?.prepared.set(animation, data);
  }
  const { prepared } = data;
  const fi = indexOfFrame(animation, input.frame);
  const frame = animation.frames[fi];
  if (frame === undefined) throw new RigError('UNKNOWN_FRAME', 'frame index out of range');
  const skeleton = evaluatePose(rig, view, prepared, fi);

  const order = new Map<LayerId, number>();
  if (input.layers !== undefined) input.layers.forEach((id, i) => order.set(id, i));
  const out: { r: PartRender; tie: number }[] = [];
  rig.parts.forEach((part, partIndex) => {
    const tie = input.layers === undefined ? partIndex : order.get(part.layerId);
    if (tie === undefined) return;
    const bone = skeleton.bones.get(part.boneId);
    if (bone === undefined) {
      throw new RigError('UNKNOWN_BONE', `part ${part.id} is bound to unknown bone ${part.boneId}`);
    }
    if (!bone.inView) return;
    const visible =
      partKeyValue(data, animation, fi, part.id, 'visible') ??
      own(view.partVisibility, part.id) ??
      true;
    if (!visible) return;
    const variant = chooseVariant(
      part,
      view,
      partKeyValue(data, animation, fi, part.id, 'variant'),
    );
    if (variant === undefined) return;
    checkCoord(variant.pivot.x, `variant ${variant.id} pivot.x`);
    checkCoord(variant.pivot.y, `variant ${variant.id} pivot.y`);
    const img = images.image(variant.imageId);
    if (img === undefined) {
      throw new RigError('IMAGE_MISSING', `variant ${variant.id}: no image ${variant.imageId}`);
    }
    const angle = residual(bone, variant, skeleton.angleQuantum);
    const algo = part.rotation ?? 'rotsprite';
    // 'none' ignores the angle: one cache entry per variant and flip, whatever the residual.
    const r = rotated(store, variant, img, algo === 'none' ? 0 : angle, algo, bone.flipX);
    const base: PlacedImage = {
      image: r.image,
      offset: { x: bone.pivot.x - r.pivotOut.x, y: bone.pivot.y - r.pivotOut.y },
    };
    const list: ResolvedPartOverride[] = (data.overrides.get(part.id)?.get(frame.id) ?? []).map(
      (o) => {
        const get = (id: ImageId | undefined): RotatableImage | undefined => {
          if (id === undefined) return undefined;
          const im = images.image(id);
          if (im === undefined)
            throw new RigError('IMAGE_MISSING', `override ${o.id}: no image ${id}`);
          return im;
        };
        return { o, set: get(o.set), erase: get(o.erase) };
      },
    );
    const done = list.length === 0 ? base : applyPartOverrides(base, bone.pivot, list);
    const z = partKeyValue(data, animation, fi, part.id, 'z') ?? own(view.defaultZ, part.id) ?? 0;
    out.push({
      tie,
      r: {
        partId: part.id,
        layerId: part.layerId,
        boneId: part.boneId,
        variantId: variant.id,
        z,
        angle,
        flipX: bone.flipX,
        pivot: bone.pivot,
        base,
        image: done.image,
        offset: done.offset,
        overrides: list.map((x) => x.o.id),
      },
    });
  });
  out.sort((a, b) => a.r.z - b.r.z || a.tie - b.tie);
  return out.map((x) => x.r);
}

/**
 * The target a part override of `part` is hashed against: the part's pre-override render in the
 * pivot-relative frame its anchors use (`offset = base.offset − pivot`). A translated part gives the
 * same target, so its overrides stay valid; a rotation or a variant switch changes it.
 */
export function partTarget(part: PartRender): OverrideTargetRender {
  return {
    image: part.base.image,
    offset: { x: part.base.offset.x - part.pivot.x, y: part.base.offset.y - part.pivot.y },
  };
}
