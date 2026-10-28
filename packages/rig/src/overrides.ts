/**
 * Override geometry and staleness (FR-RIG-22, spec 3.4 clarifications 8, 10, 11): the region an
 * override's `baseHash` covers, the hash itself, the staleness check, and the pure `rebase` /
 * `discard` list edits that core wraps in transactions.
 * @packageDocumentation
 */
import { IndexedImage, TiledImage, composite, sha256Hex } from '@pixel-forge/raster';
import type { Rect, Rgba, RotatableImage } from '@pixel-forge/raster';
import type { ImageId, OverrideId, PartId, Point } from '@pixel-forge/schema';
import { RigError } from './errors.js';

/** Read access to images by id. A core `DocumentView` (store, snapshot, transaction) fits. */
export interface ImageLookup {
  image(id: ImageId): RotatableImage | undefined;
}

/**
 * What the override functions read from an override. A schema `Override` (or a deep-readonly one)
 * fits. `anchor` is relative to the snapped pivot for a part override and a canvas position for a
 * final override.
 */
export interface OverrideLike {
  readonly id: OverrideId;
  readonly target: 'final' | Readonly<{ partId: PartId }>;
  readonly anchor: Readonly<Point>;
  readonly set?: ImageId;
  readonly erase?: ImageId;
  readonly baseHash: string;
}

/**
 * The pre-override render an override is checked against, in the override's anchor frame: `image`
 * drawn with its top-left pixel at `offset`. For a part override that frame is relative to the
 * part's snapped pivot (see `partTarget`); for a final override it is the canvas.
 */
export interface OverrideTargetRender {
  readonly image: RotatableImage;
  readonly offset: Readonly<Point>;
}

/** Why an override is stale: its region changed (`hash`) or its target was not rendered at all. */
export type StaleReason = 'hash' | 'no-target';

/** The result of checking one override. */
export interface OverrideCheck {
  readonly id: OverrideId;
  readonly stale: boolean;
  /** Set when `stale`. */
  readonly reason?: StaleReason;
  /** The hash of the region under the current render; `undefined` when there is no target. */
  readonly currentHash?: string;
}

function mustImage(images: ImageLookup, id: ImageId, o: OverrideLike): RotatableImage {
  const img = images.image(id);
  if (img === undefined) {
    throw new RigError('IMAGE_MISSING', `override ${o.id}: no image ${id}`);
  }
  return img;
}

/**
 * The smallest rectangle holding both `a` and `b`; a missing rectangle is ignored (`undefined` when
 * both are missing).
 */
export function unionRect(a: Rect | undefined, b: Rect | undefined): Rect | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** The value of an erase mask at a pixel: the index (indexed) or the alpha (RGBA). */
export function maskAt(m: RotatableImage, x: number, y: number): number {
  return m instanceof IndexedImage ? m.get(x, y) : m.get(x, y)[3];
}

/**
 * Applies one override's pixels to `out` (clause 11 of spec 3.4): `erase` first (only mask value
 * 255 clears: alpha 0 for RGBA, the transparent index for indexed), then `set` painted over the
 * result, both with their top-left pixel at `at`. Pixels outside `out` are clipped. Mutates `out`.
 *
 * RGBA `set` is composited ("over"). Indexed `set` replaces every pixel that is not `set`'s own
 * `transparentIndex`; an opaque `set` pixel whose index equals `out.transparentIndex` would paint
 * "transparent" and so silently erase, which is refused with `RigError('BAD_VALUE')` (the same
 * notion of "empty" as {@link overrideBox} and {@link hashRegion}: an index equal to the image's
 * `transparentIndex`). `set` and `out` must be the same colour mode (`BAD_VALUE` otherwise).
 *
 * @param what Names the override in error messages.
 */
export function paintOverride(
  out: RotatableImage,
  at: Readonly<Point>,
  images: {
    readonly erase?: RotatableImage | undefined;
    readonly set?: RotatableImage | undefined;
  },
  what = 'override',
): void {
  const { erase, set } = images;
  if (set !== undefined && set instanceof IndexedImage !== out instanceof IndexedImage) {
    throw new RigError(
      'BAD_VALUE',
      `${what}: its set image and the target are not the same colour mode`,
    );
  }
  const eb = erase?.bounds();
  if (erase !== undefined && eb !== undefined) {
    for (let y = eb.y; y < eb.y + eb.h; y++) {
      for (let x = eb.x; x < eb.x + eb.w; x++) {
        if (maskAt(erase, x, y) !== 255) continue;
        if (out instanceof IndexedImage) out.set(at.x + x, at.y + y, out.transparentIndex);
        else out.set(at.x + x, at.y + y, [0, 0, 0, 0]);
      }
    }
  }
  if (set instanceof TiledImage && out instanceof TiledImage) {
    composite(out, set, at);
  } else if (set instanceof IndexedImage && out instanceof IndexedImage) {
    const sb = set.bounds();
    if (sb === undefined) return;
    for (let y = sb.y; y < sb.y + sb.h; y++) {
      for (let x = sb.x; x < sb.x + sb.w; x++) {
        const i = set.get(x, y);
        if (i === set.transparentIndex) continue;
        if (i === out.transparentIndex) {
          throw new RigError(
            'BAD_VALUE',
            `${what}: set pixel (${String(x)}, ${String(y)}) has index ${String(i)}, the target's transparent index, and would erase instead of paint`,
          );
        }
        out.set(at.x + x, at.y + y, i);
      }
    }
  }
}

/**
 * The bounding box of what an override touches, in its anchor frame: the union of the non-empty
 * pixels of `set` (alpha > 0, or not the transparent index) and of `erase` (mask value > 0), each
 * placed at `anchor`. `undefined` when both images are empty. Throws `RigError('IMAGE_MISSING')`.
 */
export function overrideBox(o: OverrideLike, images: ImageLookup): Rect | undefined {
  const at = (id: ImageId | undefined): Rect | undefined => {
    if (id === undefined) return undefined;
    const b = mustImage(images, id, o).bounds();
    return b === undefined
      ? undefined
      : { x: o.anchor.x + b.x, y: o.anchor.y + b.y, w: b.w, h: b.h };
  };
  return unionRect(at(o.set), at(o.erase));
}

/**
 * The region `baseHash` covers: {@link overrideBox} dilated by 1 px on every side (FR-RIG-22 "bbox
 * ±1"), in the anchor frame. An override with empty images covers the empty region `{anchor, 0×0}`,
 * whose hash never changes.
 */
export function overrideRegion(o: OverrideLike, images: ImageLookup): Rect {
  const b = overrideBox(o, images);
  if (b === undefined) return { x: o.anchor.x, y: o.anchor.y, w: 0, h: 0 };
  return { x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2 };
}

/**
 * Lower-case hex SHA-256 of the decoded RGBA of `target` over `rect` (spec 3.4.10: the testkit
 * layout, u32be width, u32be height, RGBA8 row-major). Pixels outside the target image are
 * transparent, and every alpha-0 pixel hashes as `(0, 0, 0, 0)`, so invisible colour never matters.
 * An `IndexedImage` is decoded through `palette` (the document's base palette, never a skin), with its
 * transparent index transparent; `RigError('BAD_VALUE')` when the palette is missing or lacks an
 * index used in the region.
 */
export function hashRegion(
  target: OverrideTargetRender,
  rect: Rect,
  palette?: readonly Readonly<Rgba>[],
): string {
  const { image } = target;
  // testkit layout: u32be width, u32be height, then RGBA8 (raster's hashRGBA, which refuses 0×0)
  const bytes = new Uint8Array(8 + rect.w * rect.h * 4);
  const head = new DataView(bytes.buffer);
  head.setUint32(0, rect.w);
  head.setUint32(4, rect.h);
  const indexed = image instanceof IndexedImage;
  if (indexed && palette === undefined) {
    throw new RigError('BAD_VALUE', 'an indexed render needs a palette to be hashed');
  }
  const x0 = rect.x - target.offset.x;
  const y0 = rect.y - target.offset.y;
  let p = 8;
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++, p += 4) {
      const ix = x0 + x;
      const iy = y0 + y;
      if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) continue;
      let c: Readonly<Rgba>;
      if (image instanceof IndexedImage) {
        const i = image.get(ix, iy);
        if (i === image.transparentIndex) continue;
        const pc = palette?.[i];
        if (pc === undefined) {
          throw new RigError('BAD_VALUE', `index ${String(i)} is not in the palette`);
        }
        c = pc;
      } else {
        c = image.get(ix, iy);
      }
      if (c[3] === 0) continue;
      bytes[p] = c[0];
      bytes[p + 1] = c[1];
      bytes[p + 2] = c[2];
      bytes[p + 3] = c[3];
    }
  }
  return sha256Hex(bytes);
}

/**
 * The `baseHash` of `o` under `target`: {@link hashRegion} over {@link overrideRegion}. This is what
 * an override records when it is written or re-based, and what the staleness check recomputes.
 */
export function baseHash(
  o: OverrideLike,
  target: OverrideTargetRender,
  images: ImageLookup,
  palette?: readonly Readonly<Rgba>[],
): string {
  return hashRegion(target, overrideRegion(o, images), palette);
}

/**
 * Checks one override against its current target (FR-RIG-22): stale when the target is missing
 * (`no-target`: e.g. its part is hidden or has no drawing in the view) or when the hash of its region
 * differs from the stored `baseHash` (`hash`: e.g. the part rotated or switched variant). A part that
 * only translated keeps the same pixels around its pivot, so its overrides stay valid.
 */
export function checkOverride(
  o: OverrideLike,
  target: OverrideTargetRender | undefined,
  images: ImageLookup,
  palette?: readonly Readonly<Rgba>[],
): OverrideCheck {
  if (target === undefined) return { id: o.id, stale: true, reason: 'no-target' };
  const currentHash = baseHash(o, target, images, palette);
  return currentHash === o.baseHash
    ? { id: o.id, stale: false, currentHash }
    : { id: o.id, stale: true, reason: 'hash', currentHash };
}

/**
 * The stale overrides among `overrides`, in order (see {@link checkOverride}). `targetOf` returns the
 * pre-override render each override is checked against, or `undefined` when it has none.
 */
export function staleOverrides<O extends OverrideLike>(
  overrides: readonly O[],
  targetOf: (o: O) => OverrideTargetRender | undefined,
  images: ImageLookup,
  palette?: readonly Readonly<Rgba>[],
): OverrideCheck[] {
  return overrides
    .map((o) => checkOverride(o, targetOf(o), images, palette))
    .filter((c) => c.stale);
}

/**
 * Re-bases the overrides whose ids are in `ids` (FR-RIG-22): returns a new list where each of them is
 * a copy with `baseHash` recaptured under its current target; the others are the same objects. Throws
 * `RigError('BAD_VALUE')` for an id that is not in the list or an override without a target (a
 * hidden part cannot be re-based).
 */
export function rebase<O extends OverrideLike>(
  overrides: readonly O[],
  ids: Iterable<OverrideId>,
  targetOf: (o: O) => OverrideTargetRender | undefined,
  images: ImageLookup,
  palette?: readonly Readonly<Rgba>[],
): O[] {
  const want = new Set(ids);
  for (const id of want) {
    if (!overrides.some((o) => o.id === id)) {
      throw new RigError('BAD_VALUE', `no override ${id}`);
    }
  }
  return overrides.map((o) => {
    if (!want.has(o.id)) return o;
    const target = targetOf(o);
    if (target === undefined) {
      throw new RigError('BAD_VALUE', `override ${o.id} has no rendered target to re-base on`);
    }
    return { ...o, baseHash: baseHash(o, target, images, palette) };
  });
}

/**
 * Discards the overrides whose ids are in `ids` (FR-RIG-22): the remaining list, and the image ids
 * of the discarded overrides that no remaining override of the list references (the caller checks
 * other references before deleting them). Throws `RigError('BAD_VALUE')` for an unknown id.
 */
export function discard<O extends OverrideLike>(
  overrides: readonly O[],
  ids: Iterable<OverrideId>,
): { overrides: O[]; released: ImageId[] } {
  const want = new Set(ids);
  for (const id of want) {
    if (!overrides.some((o) => o.id === id)) {
      throw new RigError('BAD_VALUE', `no override ${id}`);
    }
  }
  const kept = overrides.filter((o) => !want.has(o.id));
  const used = new Set<ImageId>();
  for (const o of kept) {
    if (o.set !== undefined) used.add(o.set);
    if (o.erase !== undefined) used.add(o.erase);
  }
  const released = new Set<ImageId>();
  for (const o of overrides) {
    if (!want.has(o.id)) continue;
    for (const id of [o.set, o.erase]) if (id !== undefined && !used.has(id)) released.add(id);
  }
  return { overrides: kept, released: [...released].sort() };
}
