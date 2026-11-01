/**
 * `splitRegion` (FR-RIG-07, T3.5): moves a selected region of one cel of a flat pixel layer into a new
 * layer, leaving transparency behind, and binds that layer to a bone when it can. One edit of the open
 * transaction; the caller commits (`docs/ai/PLAYBOOKS.md`, "How mutations work"). See the package README
 * ("Split to parts") for the decisions recorded here.
 * @packageDocumentation
 */
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import type { Rect, Rgba } from '@pixel-forge/raster';
import {
  RigError,
  bindByOverlap,
  parsePartLayerName,
  partLayerName,
  renderParts,
} from '@pixel-forge/rig';
import type { PartAnimation, PartLayerName, PartShape } from '@pixel-forge/rig';
import { NAME_REGEX } from '@pixel-forge/schema';
import type {
  BoneId,
  Document,
  FrameId,
  ImageId,
  Layer,
  LayerId,
  PixelLayer,
  ViewId,
} from '@pixel-forge/schema';
import { CoreError } from './errors.js';
import { referencedImages } from './frames.js';
import type { StoredImage } from './images.js';
import type { DeepReadonly } from './json.js';
import { bindParts } from './rig-edit.js';
import type { BindSkipReason, BoundPart } from './rig-edit.js';
import type { Transaction } from './transaction.js';

/** A selection by canvas rectangle: `w × h` pixels with `(x, y)` the top-left pixel. */
export interface RectSelection {
  readonly kind: 'rect';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * A selection by lasso: a closed polygon through integer canvas pixels (the last vertex joins the
 * first; at least 3). A pixel is selected when its centre lies inside the polygon or on its outline
 * (even-odd rule, exact integer maths).
 */
export interface LassoSelection {
  readonly kind: 'lasso';
  readonly points: readonly (readonly [x: number, y: number])[];
}

/**
 * A selection by colour-bounded flood from a seed pixel (canvas coordinates). The flood spreads over
 * opaque pixels of the layer's cel. With `boundary` it stops at pixels of those colours (an `Rgba`, or a
 * palette index in an indexed document); without it, it selects the connected pixels of the seed's own
 * colour. Transparent pixels always stop it.
 */
export interface FloodSelection {
  readonly kind: 'flood';
  readonly x: number;
  readonly y: number;
  /** Colours that stop the flood. Missing: flood only the seed's exact colour. */
  readonly boundary?: readonly (Rgba | number)[];
  /** `4` (default) or `8` neighbours. */
  readonly connectivity?: 4 | 8;
  /** Also select the boundary-coloured pixels that touch the flooded region (an outline). Default false. */
  readonly includeBoundary?: boolean;
}

/** What {@link splitRegion} selects. */
export type SplitSelection = RectSelection | LassoSelection | FloodSelection;

/** Options of {@link splitRegion}. */
export interface SplitRegionOptions {
  /**
   * Bind the new layer to a part by its source name `part:<bone>[.<part>][@variant][#view]` (or a plain
   * bone name), exactly like `bindParts`. The layer becomes the part layer (or, when that part exists,
   * a further variant of it and disappears). Refused, before anything changes, when the name does not
   * parse or names no bone or view; refused (the whole split is undone with the transaction) when the
   * bind is skipped (`BindSkipReason`: duplicate variant, name taken, bone not in the view...).
   */
  readonly partName?: string;
  /**
   * Name of the new pixel layer while it is not a part layer. Default `split`, then `split_2`...
   * (unique among all layers). Must match the name grammar.
   */
  readonly name?: string;
  /**
   * Without `partName`: try to bind the new layer by overlap with the bone segments (default true).
   * A clear winner binds it; otherwise it stays a pixel layer and `ambiguous` / `skipped` say why.
   */
  readonly bind?: boolean;
  /** View for a `partName` without `#view`, and for overlap. Default: the first view. */
  readonly viewId?: ViewId;
  /** Default z for the new part (`bindParts`' `zByBone`: by part layer name, then bone name). */
  readonly zByBone?: Readonly<Record<string, number>>;
}

/** Why a split was refused (`CoreError.details.reason`, code `BAD_ARGUMENT`). */
export type SplitReason =
  | 'unknown-layer' // the id names no layer
  | 'not-pixel-layer' // the layer is a group, part or reference layer
  | 'no-cel' // the layer has no cel at that frame
  | 'image-missing' // the cel's image is not in the store
  | 'bad-selection' // a malformed rectangle, lasso, flood seed or boundary
  | 'empty-selection' // no opaque pixel is selected
  | 'translucent' // the layer and the cel are both partly transparent, or the moved art is and would fold into a part as a variant: the split could not recomposite exactly
  | 'rig-block-order' // a pixel layer between the rig block and the new part would change which pixels cover which (`details.blockingLayerId`)
  | 'bad-name' // the layer name or part name does not parse
  | 'name-taken' // a layer of that name exists
  | 'unknown-bone' // `partName` names no bone
  | 'unknown-view' // `partName`'s `#view` or `viewId` names no view
  | 'no-view' // `partName` is given but the rig has no view
  | 'bind-failed'; // `partName` could not be bound (`details.skipped` has the `BindSkipReason`)

/** Result of {@link splitRegion}. */
export interface SplitRegionResult {
  /**
   * The layer that now holds the moved pixels: the new pixel layer, the part layer it became, or the
   * existing part layer it was folded into as a variant.
   */
  readonly layerId: LayerId;
  /** The moved pixels' image (a variant's image once bound), trimmed to their bounding box. */
  readonly imageId: ImageId;
  /** Canvas rectangle of the moved pixels. */
  readonly bounds: Rect;
  /** Number of pixels moved. */
  readonly pixels: number;
  /** The bind, when the layer became (part of) a part. */
  readonly bound?: BoundPart;
  /** Overlap binding found no clear winner: the layer stays a pixel layer; these bones are candidates. */
  readonly ambiguous?: readonly BoneId[];
  /** Automatic binding was skipped for this reason; the layer stays a pixel layer. */
  readonly skipped?: BindSkipReason;
  /**
   * Frames of the source layer whose cel linked to the edited cel and now own the original drawing,
   * because the split changes this frame only.
   */
  readonly unlinked: readonly FrameId[];
}

const refuse = (reason: SplitReason, message: string, extra?: Record<string, unknown>): CoreError =>
  new CoreError('BAD_ARGUMENT', message, { reason, ...extra });

type LayerRo = DeepReadonly<Layer>;
type PixelRo = DeepReadonly<PixelLayer>;

function findLayer(layers: readonly LayerRo[], id: LayerId): LayerRo | undefined {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.kind === 'group') {
      const f = findLayer(l.children, id);
      if (f !== undefined) return f;
    }
  }
  return undefined;
}

function layerNames(layers: readonly LayerRo[], out = new Set<string>()): Set<string> {
  for (const l of layers) {
    out.add(l.name);
    if (l.kind === 'group') layerNames(l.children, out);
  }
  return out;
}

function locate(layers: Layer[], id: LayerId): { list: Layer[]; index: number } | undefined {
  for (const [index, l] of layers.entries()) {
    if (l.id === id) return { list: layers, index };
    if (l.kind === 'group') {
      const f = locate(l.children, id);
      if (f !== undefined) return f;
    }
  }
  return undefined;
}

// ---- rig block order --------------------------------------------------------------------------------

/** A leaf layer in draw order (bottom to top) and whether it is drawn (it and its groups are visible). */
interface Leaf {
  readonly layer: LayerRo;
  readonly drawn: boolean;
}

function leaves(layers: readonly LayerRo[], drawn = true, out: Leaf[] = []): Leaf[] {
  for (const l of layers) {
    const d = drawn && l.visible;
    if (l.kind === 'group') leaves(l.children, d, out);
    else out.push({ layer: l, drawn: d });
  }
  return out;
}

/** The drawing a pixel layer shows at `frame` (links resolved), or `undefined`. */
function drawingAt(l: PixelRo, frame: FrameId) {
  const c = l.cels[frame];
  const d = c !== undefined && 'linkTo' in c ? l.cels[c.linkTo] : c;
  return d === undefined || 'linkTo' in d ? undefined : d;
}

/** How a new layer ends up bound: a new part layer (`new`) or a variant of an existing part (`fold`). */
type BindOutcome = 'new' | 'fold';

/**
 * Predicts, before anything is written, what `bindParts` will do with the new layer, by the same
 * rules: with a part name the layer folds into the existing part of that bone and part name, else
 * becomes a new part; by overlap only a bone without parts and with a rest entry in the view takes it,
 * as a new main part. `undefined`: it stays a pixel layer.
 */
function predictBind(
  doc: DeepReadonly<Document>,
  opts: SplitRegionOptions,
  target: PartLayerName | undefined,
  shape: PartShape,
): BindOutcome | undefined {
  const rig = doc.rig;
  if (rig === undefined || rig.views.length === 0) return undefined;
  const partLayers = new Map<string, string>();
  for (const e of leaves(doc.layers)) {
    if (e.layer.kind === 'part') partLayers.set(e.layer.id, e.layer.name);
  }
  if (target !== undefined) {
    const bone = rig.bones.find((b) => b.name === target.bone);
    if (bone === undefined) return undefined;
    const name = partLayerName(target);
    return rig.parts.some((p) => p.boneId === bone.id && partLayers.get(p.layerId) === name)
      ? 'fold'
      : 'new';
  }
  if (!(opts.bind ?? true)) return undefined;
  const view =
    opts.viewId === undefined ? rig.views[0] : rig.views.find((v) => v.id === opts.viewId);
  if (view === undefined) return undefined;
  const hit = bindByOverlap([shape], { bones: rig.bones, view }, {}).assignments[0];
  if (hit === undefined || view.rest[hit.boneId] === undefined) return undefined;
  if (rig.parts.some((p) => p.boneId === hit.boneId)) return undefined;
  const name = partLayerName({ bone: rig.bones.find((b) => b.id === hit.boneId)?.name ?? '' });
  if (!NAME_REGEX.test(name) || [...partLayers.values()].includes(name)) return undefined;
  return 'new';
}

/**
 * Where the existing parts' pixels are at rest in `frame`, as a canvas pixel test: the rig rendered with
 * no bone keys and the frame's own part keys (variant, visibility). No view for the animation's
 * direction means no pixels.
 */
function restPartPixels(
  tx: Transaction,
  doc: DeepReadonly<Document>,
  frame: FrameId,
): (x: number, y: number) => boolean {
  const none = (): boolean => false;
  const rig = doc.rig;
  const anim = doc.animations.find((a) => 'frames' in a && a.frames.some((f) => f.id === frame));
  if (rig === undefined || anim === undefined || !('frames' in anim)) return none;
  const fr = anim.frames.find((f) => f.id === frame);
  if (fr === undefined) return none;
  const animation: PartAnimation = {
    ...(anim.direction === undefined ? {} : { direction: anim.direction }),
    loop: 'once',
    frames: [{ id: frame, boneKeys: {}, partKeys: fr.partKeys }],
    overrides: [],
  };
  let parts: ReturnType<typeof renderParts>;
  try {
    parts = renderParts({ rig, animation, frame: 0, images: tx });
  } catch (e) {
    if (e instanceof RigError && e.code === 'UNKNOWN_VIEW') return none;
    throw e;
  }
  const seen = new Set<string>();
  for (const p of parts) {
    const read = readerOf(p.image);
    for (let y = 0; y < p.image.height; y++) {
      for (let x = 0; x < p.image.width; x++) {
        if (read.opaque(x, y)) seen.add(`${String(p.offset.x + x)},${String(p.offset.y + y)}`);
      }
    }
  }
  return (x, y) => seen.has(`${String(x)},${String(y)}`);
}

/** The moved pixels: `mask` over an image `w` wide whose top-left pixel is at canvas `at`. */
interface Moved {
  readonly mask: Uint8Array;
  readonly w: number;
  readonly at: { readonly x: number; readonly y: number };
}

/**
 * FR-RIG-20 step 5 draws every part at the tree position of the first drawn part layer. Splitting
 * moves pixels from the source layer's position to that block, and can move the block itself, so the
 * frame stays pixel for pixel only if no pixel layer with a cel at `frame` lies in between where it
 * covers (or is covered by) those pixels. Returns the first such layer, or `undefined`.
 *
 * With the new layer `N` inserted right above the source `S`, and `block` the first drawn part layer
 * (`N` itself when it becomes a part): (a) a pixel layer between `N` and `block`, other than `S`,
 * overlapping the moved pixels; (b) when `N` becomes the first part layer and the old block was above
 * it, a pixel layer between `N` and the old block overlapping the existing parts' rest pixels.
 */
function rigBlockConflict(
  tx: Transaction,
  doc: DeepReadonly<Document>,
  source: LayerId,
  frame: FrameId,
  moved: Moved,
  outcome: BindOutcome,
): LayerRo | undefined {
  const flat = leaves(doc.layers);
  const si = flat.findIndex((e) => e.layer.id === source);
  const src = flat[si];
  if (!src?.drawn) return undefined;
  const NEW = 'new' as const;
  const sim: (Leaf | typeof NEW)[] = [...flat.slice(0, si + 1), NEW, ...flat.slice(si + 1)];
  const newAt = si + 1;
  const isPart = (e: Leaf | typeof NEW): boolean =>
    e === NEW ? outcome === 'new' : e.drawn && e.layer.kind === 'part';
  const blockAt = sim.findIndex(isPart);
  if (blockAt < 0) return undefined;

  /** The first drawn pixel layer strictly between two positions with a pixel that satisfies `hit`. */
  const firstIn = (
    a: number,
    b: number,
    hit: (x: number, y: number) => boolean,
  ): LayerRo | undefined => {
    for (let k = Math.min(a, b) + 1; k < Math.max(a, b); k++) {
      const e = sim[k];
      if (e === undefined || e === NEW || !e.drawn || e.layer.kind !== 'pixel') continue;
      if (e.layer.id === source || e.layer.opacity === 0) continue;
      const d = drawingAt(e.layer, frame);
      const img = d === undefined ? undefined : tx.image(d.imageId);
      if (d === undefined || img === undefined || d.opacity === 0) continue;
      const read = readerOf(img);
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          if (read.opaque(x, y) && hit(d.offset.x + x, d.offset.y + y)) return e.layer;
        }
      }
    }
    return undefined;
  };

  const movedAt = (x: number, y: number): boolean => {
    const ix = x - moved.at.x;
    const iy = y - moved.at.y;
    return ix >= 0 && iy >= 0 && ix < moved.w && moved.mask[iy * moved.w + ix] === 1;
  };
  const a = firstIn(newAt, blockAt, movedAt);
  if (a !== undefined || outcome !== 'new') return a;

  // The block moves down to N: the existing parts go with it.
  const oldAt = sim.findIndex((e) => e !== NEW && e.drawn && e.layer.kind === 'part');
  if (oldAt <= newAt) return undefined;
  return firstIn(newAt, oldAt, restPartPixels(tx, doc, frame));
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);

/**
 * Even-odd test of the pixel centre `(px, py)` against a polygon with integer vertices, exact: a
 * pixel on an edge or vertex is inside; otherwise the crossings of the ray towards +x are counted with
 * the half-open rule `(yi > py) ≠ (yj > py)`, comparing the crossing's x with `px` by cross-multiplying
 * (no division, no floats).
 */
function insidePolygon(
  px: number,
  py: number,
  pts: readonly (readonly [number, number])[],
): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i] ?? [0, 0];
    const [xj, yj] = pts[j] ?? [0, 0];
    const cross = (px - xi) * (yj - yi) - (py - yi) * (xj - xi);
    if (
      cross === 0 &&
      px >= Math.min(xi, xj) &&
      px <= Math.max(xi, xj) &&
      py >= Math.min(yi, yj) &&
      py <= Math.max(yi, yj)
    ) {
      return true;
    }
    if (yi > py !== yj > py) {
      const lhs = (px - xi) * (yj - yi);
      const rhs = (py - yi) * (xj - xi);
      if (yj > yi ? lhs < rhs : lhs > rhs) inside = !inside;
    }
  }
  return inside;
}

/** The pixel reader of one image: opacity and a comparable colour key. */
interface Reader {
  opaque(x: number, y: number): boolean;
  key(x: number, y: number): number;
}

function readerOf(img: StoredImage): Reader {
  if (img instanceof IndexedImage) {
    const t = img.transparentIndex;
    return { opaque: (x, y) => img.get(x, y) !== t, key: (x, y) => img.get(x, y) };
  }
  return {
    opaque: (x, y) => img.get(x, y)[3] !== 0,
    key: (x, y) => {
      const [r, g, b, a] = img.get(x, y);
      return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    },
  };
}

const rgbaKey = (c: Rgba): number => ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) >>> 0;

/**
 * The selected pixels of `img` as a mask in image coordinates (`1` = selected and opaque), plus their
 * count. `at` is the canvas position of the image's top-left pixel.
 */
function selectionMask(
  img: StoredImage,
  at: { readonly x: number; readonly y: number },
  sel: SplitSelection,
  palette: readonly Rgba[] | undefined,
): { mask: Uint8Array; count: number } {
  const w = img.width;
  const h = img.height;
  const mask = new Uint8Array(w * h);
  const read = readerOf(img);
  let count = 0;
  const pick = (x: number, y: number): void => {
    if (!read.opaque(x, y) || mask[y * w + x] === 1) return;
    mask[y * w + x] = 1;
    count++;
  };
  const bad = (m: string): CoreError => refuse('bad-selection', m);
  switch (sel.kind) {
    case 'rect': {
      if (![sel.x, sel.y, sel.w, sel.h].every(isInt) || sel.w < 1 || sel.h < 1) {
        throw bad('a rect selection needs integer x, y and w, h ≥ 1');
      }
      const x0 = Math.max(sel.x - at.x, 0);
      const y0 = Math.max(sel.y - at.y, 0);
      const x1 = Math.min(sel.x + sel.w - at.x, w);
      const y1 = Math.min(sel.y + sel.h - at.y, h);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pick(x, y);
      break;
    }
    case 'lasso': {
      const pts = sel.points;
      if (
        pts.length < 3 ||
        !pts.every((p) => (p as readonly number[]).length === 2 && isInt(p[0]) && isInt(p[1]))
      ) {
        throw bad('a lasso needs at least 3 integer points');
      }
      const xs = pts.map((p) => p[0] - at.x);
      const ys = pts.map((p) => p[1] - at.y);
      const x0 = Math.max(Math.min(...xs), 0);
      const x1 = Math.min(Math.max(...xs), w - 1);
      const y0 = Math.max(Math.min(...ys), 0);
      const y1 = Math.min(Math.max(...ys), h - 1);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (insidePolygon(x + at.x, y + at.y, pts)) pick(x, y);
        }
      }
      break;
    }
    case 'flood': {
      if (!isInt(sel.x) || !isInt(sel.y)) throw bad('a flood seed needs integer x and y');
      const conn = sel.connectivity ?? 4;
      if ((conn as number) !== 4 && (conn as number) !== 8) throw bad('connectivity is 4 or 8');
      const sx = sel.x - at.x;
      const sy = sel.y - at.y;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h || !read.opaque(sx, sy)) {
        throw refuse('empty-selection', 'the flood seed is not on an opaque pixel of the cel');
      }
      const stop = new Set<number>();
      for (const b of sel.boundary ?? []) {
        if (typeof b === 'number') {
          if (!(img instanceof IndexedImage) || !Number.isSafeInteger(b) || b < 0 || b > 255) {
            throw bad('a numeric boundary is a palette index and only fits an indexed document');
          }
          stop.add(b);
        } else if (
          (b as readonly number[]).length === 4 &&
          b.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)
        ) {
          if (img instanceof IndexedImage) {
            palette?.forEach((c, i) => {
              if (rgbaKey(c) === rgbaKey(b)) stop.add(i);
            });
          } else stop.add(rgbaKey(b));
        } else
          throw bad('a boundary colour is [r, g, b, a] with channels 0..255, or a palette index');
      }
      const bounded = sel.boundary !== undefined;
      const seedKey = read.key(sx, sy);
      const flows = (x: number, y: number): boolean =>
        read.opaque(x, y) && (bounded ? !stop.has(read.key(x, y)) : read.key(x, y) === seedKey);
      if (!flows(sx, sy)) {
        throw refuse('empty-selection', 'the flood seed lies on a boundary colour');
      }
      const nb: readonly (readonly [number, number])[] =
        conn === 4
          ? [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]
          : [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
              [1, 1],
              [1, -1],
              [-1, 1],
              [-1, -1],
            ];
      const stack: number[] = [sy * w + sx];
      mask[sy * w + sx] = 1;
      count = 1;
      const rim: number[] = [];
      while (stack.length > 0) {
        const p = stack.pop() ?? 0;
        const x = p % w;
        const y = (p - x) / w;
        for (const [dx, dy] of nb) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || mask[ny * w + nx] === 1) continue;
          if (flows(nx, ny)) {
            mask[ny * w + nx] = 1;
            count++;
            stack.push(ny * w + nx);
          } else if (bounded && sel.includeBoundary === true && read.opaque(nx, ny)) {
            rim.push(ny * w + nx);
          }
        }
      }
      for (const p of rim) {
        if (mask[p] === 0) {
          mask[p] = 1;
          count++;
        }
      }
      break;
    }
  }
  return { mask, count };
}

/**
 * Splits a region of one cel of a flat pixel layer into a new layer (FR-RIG-07), in the open
 * transaction.
 *
 * 1. **Select** the pixels of the layer's cel at `frame` (a frame id): `rect`, `lasso` or `flood`
 *    ({@link SplitSelection}, canvas coordinates). Only opaque pixels move.
 * 2. **Move** them into a new pixel layer directly above the source (same parent, same `visible` /
 *    `export`, one cel at `frame`, trimmed to the pixels' bounding box). The source cel keeps the
 *    rest; the moved pixels become transparent there. Both are new images; an image the removal
 *    orphans is deleted. A linked source cel (or a cel other frames link to) is made independent
 *    first, because the split changes this frame only ({@link SplitRegionResult.unlinked}).
 * 3. **Bind** with `bindParts`: by `partName` (`part:<bone>[.<part>][@variant][#view]`), else, when
 *    the rig has a view, by overlap with the bone segments. The part's pivot is the bone's rest
 *    pivot minus the cel offset, so **at rest the part draws exactly the pixels it took**: the source
 *    remainder plus the parts recomposite the source frame pixel for pixel (W2b). Several splits of
 *    one frame never overlap (moved pixels leave the source), so z order does not matter for them.
 *
 * The part is a part of the rig, not of the frame: it draws in every frame that renders the rig. Key
 * `visible: false` on frames where it must not appear. A layer opacity below 255 combined with a cel
 * opacity below 255 is refused (`translucent`): one part layer cannot express both exactly. With a
 * layer opacity of 255 the cel's opacity moves to the new layer. Folding the moved art into an existing
 * part as a variant (`partName` of a part that exists) is refused (`translucent`) when its opacity is
 * below 255, because a variant has no opacity of its own.
 *
 * **Rig block order.** All parts composite at the tree position of the first part layer (FR-RIG-20 step
 * 5), wherever their own layers sit, so a split can change which pixels cover which. It is refused
 * (`rig-block-order`, `details.blockingLayerId` / `blockingLayer` name the layer) when a drawn pixel
 * layer with a cel at `frame` lies between the rig block (after the split) and the new layer and
 * overlaps the moved pixels, or when the split moves the block down past such a layer that overlaps an
 * existing part's rest-pose pixels at `frame`. Layers that do not overlap never block: a body and the
 * outline layer above it can both be split. The bind is predicted with `bindParts`' rules (by `partName`,
 * or by overlap when `bind` is not false), so the refusal comes before anything changes; with `bind:
 * false` nothing becomes a part and nothing is checked. The check is about `frame` only, and about
 * visible layers only.
 *
 * @throws CoreError `BAD_ARGUMENT` with `details.reason` a {@link SplitReason}. All refusals except
 * `bind-failed` happen before anything changes (`rig-block-order` too, unless the bind turns out
 * different from the prediction, a defect: then abort the transaction); after `bind-failed` abort the
 * transaction.
 */
export function splitRegion(
  tx: Transaction,
  layer: LayerId,
  frame: FrameId,
  selection: SplitSelection,
  opts: SplitRegionOptions = {},
): SplitRegionResult {
  const doc: DeepReadonly<Document> = tx.doc;
  const src = findLayer(doc.layers, layer);
  if (src === undefined) throw refuse('unknown-layer', `no layer ${layer}`);
  if (src.kind !== 'pixel') throw refuse('not-pixel-layer', `layer ${layer} is not a pixel layer`);
  const source: PixelRo = src;
  const cel = source.cels[frame];
  if (cel === undefined) throw refuse('no-cel', `layer ${layer} has no cel at frame ${frame}`);
  const owner = 'linkTo' in cel ? source.cels[cel.linkTo] : cel;
  if (owner === undefined || 'linkTo' in owner) {
    throw refuse('no-cel', `the cel of layer ${layer} at frame ${frame} resolves to no drawing`);
  }
  const image = tx.image(owner.imageId);
  if (image === undefined) throw refuse('image-missing', `no image ${owner.imageId}`);
  if (source.opacity !== 255 && owner.opacity !== 255) {
    throw refuse(
      'translucent',
      `layer ${layer} and its cel are both partly transparent; set one of the two opacities to 255 first`,
    );
  }

  // Names and the bind request, validated before any change.
  const rig = doc.rig;
  const taken = layerNames(doc.layers);
  let layerName = opts.name;
  if (layerName !== undefined) {
    if (!NAME_REGEX.test(layerName)) {
      throw refuse(
        'bad-name',
        `layer name ${JSON.stringify(layerName)} does not match the name grammar`,
      );
    }
    if (taken.has(layerName)) throw refuse('name-taken', `a layer named ${layerName} exists`);
  } else {
    layerName = 'split';
    for (let n = 2; taken.has(layerName); n++) layerName = `split_${String(n)}`;
  }
  const rawName = opts.partName;
  let target: PartLayerName | undefined;
  if (rawName !== undefined) {
    const parsed =
      parsePartLayerName(rawName) ??
      (rig?.bones.some((b) => b.name === rawName) === true ? { bone: rawName } : null);
    if (parsed === null) {
      throw refuse(
        'bad-name',
        `${JSON.stringify(rawName)} is not part:<bone>[.<part>][@variant][#view] or a bone name`,
      );
    }
    if (rig === undefined || rig.views.length === 0) throw refuse('no-view', 'the rig has no view');
    if (!rig.bones.some((b) => b.name === parsed.bone)) {
      throw refuse('unknown-bone', `no bone ${parsed.bone}`);
    }
    if (parsed.view !== undefined && !rig.views.some((v) => v.name === parsed.view)) {
      throw refuse('unknown-view', `no view ${parsed.view}`);
    }
    target = parsed;
  }
  if (opts.viewId !== undefined && rig?.views.some((v) => v.id === opts.viewId) !== true) {
    throw refuse('unknown-view', `no view ${opts.viewId}`);
  }

  // Select.
  const palette = doc.palettes.find((p) => p.id === doc.activePaletteId)?.colors as
    readonly Rgba[] | undefined;
  const { mask, count } = selectionMask(image, owner.offset, selection, palette);
  if (count === 0)
    throw refuse('empty-selection', 'the selection holds no opaque pixel of the cel');
  const w = image.width;
  let minX = w;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) continue;
    const x = i % w;
    const y = (i - x) / w;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const layerOpacity = source.opacity === 255 ? owner.opacity : source.opacity;

  // Predict the bind, then refuse what it would break, before anything is written.
  const shape: PartShape = {
    layerId: layer,
    x: owner.offset.x + minX,
    y: owner.offset.y + minY,
    w: bw,
    h: bh,
    alpha: Uint8Array.from({ length: bw * bh }, (_, i) =>
      mask[(minY + Math.floor(i / bw)) * w + minX + (i % bw)] === 1 ? 255 : 0,
    ),
  };
  const movedPx: Moved = { mask, w, at: owner.offset };
  const predicted = predictBind(doc, opts, target, shape);
  if (predicted === 'fold' && layerOpacity < 255) {
    throw refuse(
      'translucent',
      `the moved art is partly transparent (opacity ${String(layerOpacity)}) and would become a variant of an existing part, which has no opacity of its own`,
    );
  }
  /** Refuses when binding as `outcome` would put a pixel layer between the rig block and the new part. */
  const checkBlock = (outcome: BindOutcome): void => {
    const blocking = rigBlockConflict(tx, doc, layer, frame, movedPx, outcome);
    if (blocking !== undefined) {
      throw refuse(
        'rig-block-order',
        `layer "${blocking.name}" lies between the rig block and the new part and overlaps pixels whose order would change; move it above or below the rig block's parts first`,
        { blockingLayerId: blocking.id, blockingLayer: blocking.name },
      );
    }
  };
  if (predicted !== undefined) checkBlock(predicted);

  // Build the two new images.
  const moved = image.emptyLike(bw, bh);
  const rest = image.clone();
  if (
    image instanceof IndexedImage &&
    moved instanceof IndexedImage &&
    rest instanceof IndexedImage
  ) {
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (mask[y * w + x] === 0) continue;
        moved.set(x - minX, y - minY, image.get(x, y));
        rest.set(x, y, image.transparentIndex);
      }
    }
  } else if (
    image instanceof TiledImage &&
    moved instanceof TiledImage &&
    rest instanceof TiledImage
  ) {
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (mask[y * w + x] === 0) continue;
        moved.set(x - minX, y - minY, image.get(x, y));
        rest.set(x, y, [0, 0, 0, 0]);
      }
    }
  }
  const movedId = tx.createImage(moved);
  const restId = tx.createImage(rest);
  const bounds: Rect = { x: owner.offset.x + minX, y: owner.offset.y + minY, w: bw, h: bh };

  // Make the edited cel independent; frames that linked to it keep the original drawing.
  const linkers = Object.entries(source.cels)
    .filter(([f, c]) => f !== frame && 'linkTo' in c && c.linkTo === frame)
    .map(([f]) => f as FrameId)
    .sort();
  const newLayerId = tx.newId('layer');
  tx.update((d) => {
    const loc = locate(d.layers, layer);
    if (loc === undefined) return;
    const l = loc.list[loc.index];
    if (l?.kind !== 'pixel') return;
    l.cels[frame] = { imageId: restId, offset: { ...owner.offset }, opacity: owner.opacity };
    const first = linkers[0];
    if (first !== undefined) {
      l.cels[first] = {
        imageId: owner.imageId,
        offset: { ...owner.offset },
        opacity: owner.opacity,
      };
      for (const f of linkers.slice(1)) l.cels[f] = { linkTo: first };
    }
    const fresh: PixelLayer = {
      kind: 'pixel',
      id: newLayerId,
      name: layerName,
      visible: l.visible,
      opacity: layerOpacity,
      export: l.export,
      cels: { [frame]: { imageId: movedId, offset: { x: bounds.x, y: bounds.y }, opacity: 255 } },
    };
    loc.list.splice(loc.index + 1, 0, fresh);
  });
  // The removal may orphan the original image (no linker and no other user).
  if (!referencedImages(tx.doc).has(owner.imageId) && tx.image(owner.imageId) !== undefined) {
    tx.deleteImage(owner.imageId);
  }

  // Bind. The prediction above mirrors bindParts; should the two ever disagree, check the real outcome
  // (the caller's transaction is then aborted, like after `bind-failed`).
  const verifyBind = (bound: BoundPart): void => {
    const outcome: BindOutcome = bound.merged ? 'fold' : 'new';
    if (outcome !== predicted) checkBlock(outcome);
  };
  const base = { unlinked: linkers, imageId: movedId, bounds, pixels: count };
  const bindOpts = {
    layers: [newLayerId],
    ...(opts.viewId === undefined ? {} : { viewId: opts.viewId }),
    ...(opts.zByBone === undefined ? {} : { zByBone: opts.zByBone }),
  };
  if (rawName !== undefined) {
    const r = bindParts(tx, {
      ...bindOpts,
      byName: true,
      byOverlap: false,
      rawNames: { [newLayerId]: rawName },
    });
    const bound = r.bound[0];
    if (bound === undefined) {
      const skipped = r.skipped[0]?.reason;
      throw refuse(
        'bind-failed',
        `could not bind the split to ${rawName}: ${skipped ?? 'unknown'}`,
        {
          skipped,
        },
      );
    }
    verifyBind(bound);
    return { ...base, layerId: layerOf(tx, bound, newLayerId), bound };
  }
  if ((opts.bind ?? true) && rig !== undefined && rig.views.length > 0) {
    const r = bindParts(tx, { ...bindOpts, byName: false, byOverlap: true });
    const bound = r.bound[0];
    if (bound !== undefined) {
      verifyBind(bound);
      return { ...base, layerId: layerOf(tx, bound, newLayerId), bound };
    }
    const amb = r.ambiguous[0];
    const skipped = r.skipped[0]?.reason;
    return {
      ...base,
      layerId: newLayerId,
      ...(amb === undefined ? {} : { ambiguous: [...amb.candidates] }),
      ...(skipped === undefined ? {} : { skipped }),
    };
  }
  return { ...base, layerId: newLayerId };
}

/** The layer that holds a bound split: the new layer, or the existing part layer it was merged into. */
function layerOf(tx: Transaction, bound: BoundPart, newLayerId: LayerId): LayerId {
  if (!bound.merged) return newLayerId;
  return tx.doc.rig?.parts.find((p) => p.id === bound.partId)?.layerId ?? newLayerId;
}
