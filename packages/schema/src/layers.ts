/**
 * The layer tree and cels (spec 3, 3.1).
 * @packageDocumentation
 */
import { z } from 'zod';
import { MAX_LAYER_DEPTH } from './constants.js';
import { FrameId, ImageId, LayerId } from './ids.js';
import { Name, Opacity, Point } from './primitives.js';
import { record } from './record.js';

/** A cel that owns pixels: an image placed at `offset` on the canvas, with its own opacity. */
export const ImageCel = z.strictObject({
  imageId: ImageId,
  /** Canvas position of the image's top-left pixel. */
  offset: Point,
  opacity: Opacity,
});
/** A cel that owns pixels. */
export type ImageCel = z.infer<typeof ImageCel>;

/**
 * A linked cel: it shows the cel of the **same layer** at frame `linkTo` (image, offset and
 * opacity), which may belong to another animation. Links resolve in one hop to an {@link ImageCel}
 * (I3, checked by `validate()`).
 */
export const LinkCel = z.strictObject({ linkTo: FrameId });
/** A linked cel. */
export type LinkCel = z.infer<typeof LinkCel>;

/** The content of one layer at one frame: an {@link ImageCel} or a {@link LinkCel}. */
export const Cel = z.union([ImageCel, LinkCel]);
/** The content of one layer at one frame. */
export type Cel = z.infer<typeof Cel>;

/**
 * Cels of one layer keyed by frame id: the `(layerId, frameId)` key of spec 3.1, with the layer
 * given by the containing layer. Sparse: a missing frame is empty. Unordered.
 */
export const Cels = record(FrameId, Cel);
/** Cels of one layer keyed by frame id. */
export type Cels = z.infer<typeof Cels>;

/** Fields shared by every layer kind. */
const layerBase = {
  id: LayerId,
  /** Machine name (I7); part layers are addressed by it (`PartName` in ops). */
  name: Name,
  /** Hidden layers are not drawn (in the editor or the render). */
  visible: z.boolean(),
  /** Layer opacity `0..255`, multiplied with cel opacity. */
  opacity: Opacity,
  /** Only layers whose `export` is true, together with every ancestor group, reach the render cache. */
  export: z.boolean(),
};

/** An ordinary raster layer with cels. */
export const PixelLayer = z.strictObject({ kind: z.literal('pixel'), ...layerBase, cels: Cels });
/** An ordinary raster layer with cels. */
export type PixelLayer = z.infer<typeof PixelLayer>;

/**
 * A tracing or reference layer with cels. Drawn only when a render asks for references
 * (`includeReference`), never into the render cache: its `export` is always `false` (spec 3.4
 * clarification 13).
 */
export const ReferenceLayer = z.strictObject({
  kind: z.literal('reference'),
  ...layerBase,
  export: z.literal(false),
  cels: Cels,
});
/** A tracing or reference layer with cels. */
export type ReferenceLayer = z.infer<typeof ReferenceLayer>;

/**
 * A layer computed by the rig for exactly one part: the {@link Part} whose `layerId` is this layer.
 * It has no cels; its pixels come from the part's variants and overrides.
 */
export const PartLayer = z.strictObject({ kind: z.literal('part'), ...layerBase });
/** A layer computed by the rig for one part. */
export type PartLayer = z.infer<typeof PartLayer>;

/** A group of layers; children are ordered bottom to top, like {@link Document} `layers`. */
export interface GroupLayer {
  kind: 'group';
  id: LayerId;
  name: string;
  visible: boolean;
  opacity: number;
  export: boolean;
  children: Layer[];
}

/** Any node of the layer tree, discriminated by `kind`. */
export type Layer = GroupLayer | PixelLayer | ReferenceLayer | PartLayer;

/** The kind of a layer. */
export type LayerKind = Layer['kind'];

/**
 * True when no group nests deeper than {@link MAX_LAYER_DEPTH} below `root` (which is level 1).
 * Walks the raw, unvalidated input with an explicit stack, so a hostile 5000-deep document costs
 * at most `MAX_LAYER_DEPTH` levels of work before it is rejected, and never overflows the call
 * stack. Only follows well-formed groups (`kind: 'group'` with an array `children`); anything else
 * is left to the structural schema.
 */
const withinDepthLimit = (root: unknown): boolean => {
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 1 }];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const { node, depth } = top;
    if (depth > MAX_LAYER_DEPTH) return false;
    if (typeof node !== 'object' || node === null) continue;
    const group = node as { kind?: unknown; children?: unknown };
    if (group.kind !== 'group' || !Array.isArray(group.children)) continue;
    for (const child of group.children as unknown[]) stack.push({ node: child, depth: depth + 1 });
  }
  return true;
};

/** Prepends the depth pre-check to a structural layer schema (the check runs before any recursion). */
const depthBounded = <T extends Layer>(structure: z.ZodType<T>) =>
  z
    .custom<T>(withinDepthLimit, `layers nest at most ${String(MAX_LAYER_DEPTH)} levels deep`)
    .pipe(structure as z.ZodType<T, T>);

/** Structure of a group: its children are structural layers, so the depth check runs only once. */
const groupStructure = z.strictObject({
  kind: z.literal('group'),
  ...layerBase,
  get children(): z.ZodArray<z.ZodType<Layer>> {
    return z.array(layerStructure);
  },
});

/** Structure of any layer, without the depth pre-check. */
const layerStructure: z.ZodType<Layer> = z.discriminatedUnion('kind', [
  groupStructure,
  PixelLayer,
  ReferenceLayer,
  PartLayer,
]);

/**
 * A group of layers; children are ordered bottom to top. The tree may nest at most
 * {@link MAX_LAYER_DEPTH} levels (the group is level 1); deeper input fails validation with an
 * ordinary issue instead of overflowing the stack.
 */
export const GroupLayer = depthBounded(groupStructure);

/**
 * Any node of the layer tree (spec 3: Group | PixelLayer | PartLayer | ReferenceLayer), discriminated
 * by `kind`. Unknown kinds are rejected. A root layer is level 1 and the tree may nest at most
 * {@link MAX_LAYER_DEPTH} levels; deeper input fails validation with an ordinary issue instead of
 * overflowing the stack.
 */
export const Layer = depthBounded(layerStructure);
