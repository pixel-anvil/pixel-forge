/**
 * Edit attribution (FR-RIG-22, FR-RIG-24): turns an edited copy of a rendered rig frame into the
 * overrides that reproduce it, part overrides where an edit lies inside one part, final overrides
 * elsewhere. Pure: the caller supplies the frame's parts and a way to re-render it with changed parts.
 * @packageDocumentation
 */
import { IndexedImage, TiledImage, hashRGBA } from '@pixel-forge/raster';
import type { Rect, Rgba, RotatableImage } from '@pixel-forge/raster';
import type { ImageId, OverrideId, PartId, Point } from '@pixel-forge/schema';
import { RigError } from './errors.js';
import { baseHash, paintOverride, unionRect } from './overrides.js';
import type { ImageLookup, OverrideLike, OverrideTargetRender } from './overrides.js';
import { partTarget } from './render.js';
import type { PartRender } from './render.js';

/** The two images of one frame render that {@link attributeEdit} needs (see {@link EditContext.render}). */
export interface EditRender {
  /**
   * The canvas the final overrides are painted on, **before** any of them: the target of a final
   * override's `baseHash` (core: `renderStages(...).beforeFinals`, or `beforeMirrorFinals` for a
   * mirror's own finals, of the export render). Canvas coordinates, top-left at (0, 0).
   */
  readonly finalTarget: RotatableImage;
  /**
   * The finished frame: every existing final override applied, no skin. It is what `before` is and
   * what `edited` is compared with.
   */
  readonly result: TiledImage;
}

/**
 * How {@link attributeEdit} sees one frame (the `renderCtx` of the card). Core builds it from
 * `renderStages` (`attributeEditTx`); tests can build it from `renderParts` and a compositor.
 */
export interface EditContext {
  /**
   * The parts drawn in this render (`renderParts` output: `image` + `offset` after the existing part
   * overrides, `base` and `pivot` for the anchor and the hash). A part's footprint is the set of
   * canvas pixels where its `image` is not transparent (an indexed image: the transparent index and
   * every palette entry of alpha 0 are transparent). `render(parts)` always gets the real list.
   */
  readonly parts: readonly PartRender[];
  /**
   * `true`: no part has a footprint, so every edit becomes a final override (a mirror animation,
   * whose part overrides are T3.6's). `parts` stays the real list that `render` draws. Default `false`.
   */
  readonly finalOnly?: boolean;
  /**
   * Renders the frame with `parts` in place of {@link EditContext.parts} (same parts, same order; only
   * `image` may differ) through compositing, post-passes and the existing final overrides. Called
   * with `ctx.parts` itself it must give the render `before` was taken from.
   */
  readonly render: (parts: readonly PartRender[]) => EditRender;
  /**
   * The document's base palette: decodes indexed part renders for hashing (as `checkOverride` does)
   * and maps edited colours to indices for indexed images.
   */
  readonly palette?: readonly Readonly<Rgba>[];
  /**
   * `'indexed'`: final `set` images are indexed (the document's colour mode). Default `'rgba'`. Part
   * `set` images always take the colour mode of the part's render.
   */
  readonly colorMode?: 'rgba' | 'indexed';
}

/**
 * One override produced by {@link attributeEdit}: a schema `Override` without its ids. The caller
 * stores `set` and `erase` as images, gives the override an id and the frame id, and appends it to
 * the animation's overrides **after** the existing ones, in the returned order.
 */
export interface AttributedOverride {
  readonly target: 'final' | { readonly partId: PartId };
  /** Part override: relative to the part's snapped pivot. Final override: a canvas position. */
  readonly anchor: Point;
  /** Pixels painted over the target (part: the part render's colour mode; final: `colorMode`). */
  readonly set?: RotatableImage;
  /**
   * Erase mask: an 8-bit `IndexedImage` (spec 3.4 clarification 8) whose value is 255 where the
   * target is cleared and 0 elsewhere, in every colour mode (as T3.3 stores them).
   */
  readonly erase?: IndexedImage;
  /** Taken exactly as `checkOverride` recomputes it, so a fresh override is valid. */
  readonly baseHash: string;
}

type Px = readonly [number, number, number, number];

function pixel(d: Uint8Array, i: number): Px {
  const o = i * 4;
  return [d[o] ?? 0, d[o + 1] ?? 0, d[o + 2] ?? 0, d[o + 3] ?? 0];
}

/** Equal as seen: every alpha-0 pixel is the same "transparent", whatever its colour bytes. */
function sameVisible(a: Px, b: Px): boolean {
  if (a[3] === 0 && b[3] === 0) return true;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/** True when palette index `i` of an indexed image is transparent: its own `transparentIndex` or any alpha-0 entry. */
function clear(
  palette: readonly Readonly<Rgba>[] | undefined,
  transparentIndex: number,
  i: number,
): boolean {
  return i === transparentIndex || palette?.[i]?.[3] === 0;
}

/** The lowest palette index whose colour is exactly `c` (alpha > 0), skipping `skip`. */
function indexOf(
  palette: readonly Readonly<Rgba>[] | undefined,
  c: Px,
  skip: number,
): number | undefined {
  if (palette === undefined) return undefined;
  for (let i = 0; i < palette.length && i < 256; i++) {
    const p = palette[i];
    if (i === skip || p === undefined || p[3] === 0) continue;
    if (p[0] === c[0] && p[1] === c[1] && p[2] === c[2] && p[3] === c[3]) return i;
  }
  return undefined;
}

/** A pixel to write: `set` an RGBA colour or an index, and/or `erase` first. Canvas coordinates. */
interface Write {
  readonly x: number;
  readonly y: number;
  readonly erase: boolean;
  /** Missing: nothing painted. */
  readonly set?: Px | number;
}

/** The value of an erase mask where the target is cleared (T3.3 `paintOverride` erases at 255 only). */
const CLEAR = 255;

/** A finished override's images (see {@link build}); `at` is the canvas top-left of both. */
interface Built {
  readonly at: Point;
  readonly set?: RotatableImage;
  readonly erase?: IndexedImage;
}

/**
 * The `set` / `erase` images of `writes` cropped to their bounding box, whose canvas top-left is
 * returned as `at`. `mode` picks the `set` image's type (an `IndexedImage` with `transparentIndex`).
 */
function build(
  writes: readonly Write[],
  mode: { readonly indexed: false } | { readonly indexed: true; readonly transparentIndex: number },
): Built {
  let box: Rect | undefined;
  for (const w of writes) box = unionRect(box, { x: w.x, y: w.y, w: 1, h: 1 });
  if (box === undefined) throw new RigError('BAD_VALUE', 'no pixels to write');
  const erase = new IndexedImage(box.w, box.h);
  const set: RotatableImage = mode.indexed
    ? new IndexedImage(box.w, box.h, mode.transparentIndex)
    : new TiledImage(box.w, box.h);
  let anyErase = false;
  let anySet = false;
  for (const w of writes) {
    const x = w.x - box.x;
    const y = w.y - box.y;
    if (w.erase) {
      erase.set(x, y, CLEAR);
      anyErase = true;
    }
    if (w.set === undefined) continue;
    anySet = true;
    if (set instanceof IndexedImage) set.set(x, y, w.set as number);
    else set.set(x, y, w.set as Px);
  }
  return {
    at: { x: box.x, y: box.y },
    ...(anySet ? { set } : {}),
    ...(anyErase ? { erase } : {}),
  };
}

const SET_ID = 'img_attribute_set' as ImageId;
const ERASE_ID = 'img_attribute_erase' as ImageId;

/** `baseHash` through the very function `checkOverride` uses, over a throwaway image lookup. */
function hashOf(
  target: AttributedOverride['target'],
  anchor: Point,
  imgs: { set?: RotatableImage; erase?: IndexedImage },
  render: OverrideTargetRender,
  palette: readonly Readonly<Rgba>[] | undefined,
): string {
  const o: OverrideLike = {
    id: 'ovr_attribute' as OverrideId,
    target,
    anchor,
    ...(imgs.set === undefined ? {} : { set: SET_ID }),
    ...(imgs.erase === undefined ? {} : { erase: ERASE_ID }),
    baseHash: '',
  };
  const lookup: ImageLookup = {
    image: (id) => (id === SET_ID ? imgs.set : id === ERASE_ID ? imgs.erase : undefined),
  };
  return baseHash(o, render, lookup, palette);
}

/** What one component of changed pixels becomes. */
interface Component {
  readonly pixels: readonly number[];
  /** Index into `ctx.parts` of the one part whose footprint holds every pixel; -1: final. */
  part: number;
}

/**
 * The 8-connected components of the changed pixels, in scan order (each component's pixels in
 * breadth-first order from its first pixel), each with its owning part.
 */
function components(changed: Uint8Array, owner: Int32Array, w: number, h: number): Component[] {
  const seen = new Uint8Array(changed.length);
  const out: Component[] = [];
  for (let start = 0; start < changed.length; start++) {
    if (changed[start] === 0 || seen[start] === 1) continue;
    seen[start] = 1;
    const pixels = [start];
    // the array iterator also visits the pixels pushed during the walk (breadth-first)
    for (const i of pixels) {
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (changed[j] === 0 || seen[j] === 1) continue;
          seen[j] = 1;
          pixels.push(j);
        }
      }
    }
    const first = owner[start] ?? -1;
    const part = pixels.every((i) => owner[i] === first) ? first : -1;
    out.push({ pixels, part });
  }
  return out;
}

/**
 * Turns an edit of a rendered rig frame into overrides (FR-RIG-22, FR-RIG-24): additions, colour
 * changes and erasures, so that rendering the frame with the returned overrides appended gives
 * exactly `edited` (every alpha-0 pixel counts as the same transparent).
 *
 * **Attribution rule.** The changed pixels are split into 8-connected strokes. Each stroke becomes a
 * part override if it lies inside exactly one part's footprint (every pixel in the footprint of that
 * one part, and it shows through the composite); otherwise it goes into the single final override.
 *
 * 1. **Changed pixels**: where `before` and `edited` differ (alpha-0 pixels are equal whatever their
 *    colour bytes), grouped into 8-connected components (strokes).
 * 2. **Footprints**: a part's footprint is the canvas pixels where its posed output in this frame
 *    (`PartRender.image`, after the existing part overrides) is not transparent (an indexed image:
 *    neither its transparent index nor any palette entry of alpha 0). A component becomes a **part
 *    override** candidate when every one of its pixels lies in the footprint of exactly one part, the
 *    same for all of them; otherwise (a pixel outside every part, or under two parts) it goes to the
 *    final override. `ctx.finalOnly` gives no footprints.
 * 3. **Part overrides**, one per part (its candidate components merged), painted on the part's
 *    current image: an alpha-0 edit erases, an opaque edit sets, a translucent edit erases then sets
 *    (so it replaces instead of blending). An indexed part takes the lowest palette index of exactly
 *    the edited colour; a colour the palette lacks demotes the component. The frame is re-rendered
 *    with the new part images (`ctx.render`); a component whose pixels do not come out as `edited`
 *    (another layer above, layer opacity, an existing final override, a post-pass) is demoted to the
 *    final override, and the render repeats until every remaining candidate reproduces its pixels.
 *    Anchor: the bbox's top-left relative to the part's snapped pivot. `baseHash` over
 *    `partTarget(part)` (the pre-override render, pivot-relative), so it follows a translation and
 *    goes stale on a rotation or a variant switch.
 * 4. **Final override**: every pixel where that last render still differs from `edited` (the demoted
 *    and final components, and anything a post-pass moved), painted over the finished frame with the
 *    same erase / set rule, so it is exact. Anchor: its bbox's top-left in canvas pixels. `baseHash`
 *    over `finalTarget` of the last render (the canvas before every final override, with the new part
 *    overrides in place: what core's `checkOverrides` hashes once they are written). With
 *    `colorMode: 'indexed'` the `set` image is indexed (transparent index: the palette's first alpha-0
 *    entry) and a colour the palette lacks is refused.
 *
 * Returns the part overrides in `ctx.parts` order, then the final override if any; `[]` when nothing
 * changed. Erase masks are 8-bit `IndexedImage`s with value 255 where they clear, in every colour
 * mode (spec 3.4 clarification 8, the masks T3.3's `paintOverride` reads). Deterministic: integer
 * maths only, scan order everywhere.
 *
 * `before` must be the pixels of `ctx.render(ctx.parts).result` (compared by hash, alpha-0 pixels
 * equal); checked once something changed, since an unchanged edit returns `[]` without rendering.
 *
 * Throws `RigError('BAD_ARGUMENT', ..., 'before-mismatch')` when it is not; `RigError('BAD_VALUE')`
 * when `before` and `edited` differ in size, or (indexed documents) when the palette is missing, has
 * no alpha-0 entry, or lacks an edited colour of a final pixel; and the errors of `ctx.render`,
 * `paintOverride` and `baseHash`.
 */
export function attributeEdit(
  ctx: EditContext,
  before: TiledImage,
  edited: TiledImage,
): AttributedOverride[] {
  const w = before.width;
  const h = before.height;
  if (edited.width !== w || edited.height !== h) {
    throw new RigError(
      'BAD_VALUE',
      `edited image is ${String(edited.width)}×${String(edited.height)}, the render ${String(w)}×${String(h)}`,
    );
  }
  const bd = before.toRGBA().data;
  const ed = edited.toRGBA().data;
  const n = w * h;
  const changed = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (!sameVisible(pixel(bd, i), pixel(ed, i))) {
      changed[i] = 1;
      any = true;
    }
  }
  if (!any) return [];

  // `before` must be the render of ctx.parts: the render that is reused when no part changes
  const initial = ctx.render(ctx.parts);
  const first = initial.result.toRGBA();
  if (
    first.width !== w ||
    first.height !== h ||
    visibleHash(first) !== visibleHash(before.toRGBA())
  ) {
    throw new RigError(
      'BAD_ARGUMENT',
      'before is not the render of ctx.parts (ctx.render(ctx.parts).result)',
      'before-mismatch',
    );
  }

  // owner: index of the one part whose footprint holds the pixel; -1 none; -2 several
  const owner = new Int32Array(n).fill(-1);
  if (ctx.finalOnly !== true) {
    ctx.parts.forEach((p, pi) => {
      const img = p.image;
      for (let ly = 0; ly < img.height; ly++) {
        const y = p.offset.y + ly;
        if (y < 0 || y >= h) continue;
        for (let lx = 0; lx < img.width; lx++) {
          const x = p.offset.x + lx;
          if (x < 0 || x >= w) continue;
          const i = y * w + x;
          if (changed[i] === 0) continue;
          const opaque =
            img instanceof IndexedImage
              ? !clear(ctx.palette, img.transparentIndex, img.get(lx, ly))
              : img.get(lx, ly)[3] !== 0;
          if (opaque) owner[i] = (owner[i] ?? -1) === -1 ? pi : -2;
        }
      }
    });
  }
  const comps = components(changed, owner, w, h);

  /** The part images with the candidate components painted in, and the finished images per part. */
  const paint = (): { parts: readonly PartRender[]; built: Map<number, Built> } => {
    const writes = new Map<number, Write[]>();
    for (const c of comps) {
      if (c.part < 0) continue;
      const p = ctx.parts[c.part];
      if (p === undefined) continue;
      const img = p.image;
      const list: Write[] = [];
      let ok = true;
      for (const i of c.pixels) {
        const x = i % w;
        const y = (i - x) / w;
        const e = pixel(ed, i);
        const lx = x - p.offset.x;
        const ly = y - p.offset.y;
        if (img instanceof IndexedImage) {
          const cur = img.get(lx, ly);
          if (e[3] === 0) {
            list.push({ x, y, erase: true });
            continue;
          }
          const idx = indexOf(ctx.palette, e, img.transparentIndex);
          if (idx === undefined) {
            ok = false;
            break;
          }
          if (idx !== cur) list.push({ x, y, erase: false, set: idx });
        } else {
          const cur = img.get(lx, ly);
          if (sameVisible(cur, e)) continue;
          if (e[3] === 0) list.push({ x, y, erase: true });
          else list.push({ x, y, erase: e[3] !== 255, set: e });
        }
      }
      if (!ok) {
        c.part = -1;
        continue;
      }
      const all = writes.get(c.part) ?? [];
      all.push(...list);
      writes.set(c.part, all);
    }
    const built = new Map<number, Built>();
    if (writes.size === 0) return { parts: ctx.parts, built };
    const parts = ctx.parts.map((p, pi) => {
      const list = writes.get(pi);
      if (list === undefined || list.length === 0) return p;
      const b = build(
        list,
        p.image instanceof IndexedImage
          ? { indexed: true, transparentIndex: p.image.transparentIndex }
          : { indexed: false },
      );
      built.set(pi, b);
      const image = p.image.clone();
      paintOverride(
        image,
        { x: b.at.x - p.offset.x, y: b.at.y - p.offset.y },
        b,
        `attributed override of part ${p.partId}`,
      );
      return { ...p, image };
    });
    return { parts, built };
  };

  let painted = paint();
  let render = painted.parts === ctx.parts ? initial : ctx.render(painted.parts);
  let rd = render.result.toRGBA();
  for (;;) {
    let demoted = false;
    for (const c of comps) {
      if (c.part < 0) continue;
      if (c.pixels.some((i) => !sameVisible(pixel(rd.data, i), pixel(ed, i)))) {
        c.part = -1;
        demoted = true;
      }
    }
    if (!demoted) break;
    painted = paint();
    render = painted.parts === ctx.parts ? initial : ctx.render(painted.parts);
    rd = render.result.toRGBA();
  }

  const out: AttributedOverride[] = [];
  ctx.parts.forEach((p, pi) => {
    const b = painted.built.get(pi);
    if (b === undefined) return;
    const target = { partId: p.partId };
    const anchor = { x: b.at.x - p.pivot.x, y: b.at.y - p.pivot.y };
    const imgs = {
      ...(b.set === undefined ? {} : { set: b.set }),
      ...(b.erase === undefined ? {} : { erase: b.erase }),
    };
    out.push({
      target,
      anchor,
      ...imgs,
      baseHash: hashOf(target, anchor, imgs, partTarget(p), ctx.palette),
    });
  });

  const final = finalOverride(ctx, render.finalTarget, rd.data, ed, w, h);
  if (final !== undefined) out.push(final);
  return out;
}

/** SHA-256 of the RGBA pixels with every alpha-0 pixel zeroed (all transparent is one transparent). */
function visibleHash(img: { width: number; height: number; data: Uint8Array }): string {
  const data = img.data.slice();
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3] === 0) data.fill(0, o, o + 3);
  }
  return hashRGBA({ width: img.width, height: img.height, data });
}

/** Step 4 of {@link attributeEdit}: whatever the render still gets wrong, over the finished frame. */
function finalOverride(
  ctx: EditContext,
  finalTarget: RotatableImage,
  rd: Uint8Array,
  ed: Uint8Array,
  w: number,
  h: number,
): AttributedOverride | undefined {
  const indexed = ctx.colorMode === 'indexed';
  let ti = 0;
  if (indexed) {
    const t = ctx.palette?.findIndex((c) => c[3] === 0) ?? -1;
    if (t < 0) {
      throw new RigError(
        'BAD_VALUE',
        'an indexed final override needs a palette with a transparent (alpha 0) entry',
      );
    }
    ti = t;
  }
  const writes: Write[] = [];
  for (let i = 0; i < w * h; i++) {
    const cur = pixel(rd, i);
    const e = pixel(ed, i);
    if (sameVisible(cur, e)) continue;
    const x = i % w;
    const y = (i - x) / w;
    if (e[3] === 0) {
      writes.push({ x, y, erase: true });
      continue;
    }
    // "over" copies an opaque colour, or any colour onto a transparent pixel, exactly
    const erase = e[3] !== 255 && cur[3] !== 0;
    if (!indexed) {
      writes.push({ x, y, erase, set: e });
      continue;
    }
    const idx = indexOf(ctx.palette, e, ti);
    if (idx === undefined) {
      throw new RigError(
        'BAD_VALUE',
        `edited pixel (${String(x)}, ${String(y)}) has colour ${e.join(',')}, which the palette does not have`,
      );
    }
    writes.push({ x, y, erase, set: idx });
  }
  if (writes.length === 0) return undefined;
  const b = build(writes, indexed ? { indexed: true, transparentIndex: ti } : { indexed: false });
  const imgs = {
    ...(b.set === undefined ? {} : { set: b.set }),
    ...(b.erase === undefined ? {} : { erase: b.erase }),
  };
  return {
    target: 'final',
    anchor: b.at,
    ...imgs,
    baseHash: hashOf(
      'final',
      b.at,
      imgs,
      { image: finalTarget, offset: { x: 0, y: 0 } },
      ctx.palette,
    ),
  };
}
