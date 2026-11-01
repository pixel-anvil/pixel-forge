/**
 * `splitRegion` (FR-RIG-07, T3.5): moves a selected region of one cel of a flat pixel layer into a new
 * layer, leaving transparency behind, and binds that layer to a bone when it can. One edit of the open
 * transaction; the caller commits (`docs/ai/PLAYBOOKS.md`, "How mutations work"). See the package README
 * ("Split to parts") for the decisions recorded here.
 * @packageDocumentation
 */
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import type { Rect, Rgba } from '@pixel-forge/raster';
import { parsePartLayerName } from '@pixel-forge/rig';
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
  | 'translucent' // the layer and the cel are both partly transparent: the split could not recomposite exactly
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
 * layer opacity of 255 the cel's opacity moves to the new layer.
 *
 * @throws CoreError `BAD_ARGUMENT` with `details.reason` a {@link SplitReason}. All refusals except
 * `bind-failed` happen before anything changes; after `bind-failed` abort the transaction.
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
  const layerOpacity = source.opacity === 255 ? owner.opacity : source.opacity;
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

  // Bind.
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
    return { ...base, layerId: layerOf(tx, bound, newLayerId), bound };
  }
  if ((opts.bind ?? true) && rig !== undefined && rig.views.length > 0) {
    const r = bindParts(tx, { ...bindOpts, byName: false, byOverlap: true });
    const bound = r.bound[0];
    if (bound !== undefined) return { ...base, layerId: layerOf(tx, bound, newLayerId), bound };
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
