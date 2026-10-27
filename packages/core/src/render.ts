/**
 * `renderFrame`: the pure render of one frame of one animation (spec 6.7) for pixel, reference and
 * part layers. Core owns FR-RIG-20 steps 5 to 8; the rig renderer only supplies the parts (steps 1
 * to 4). See the package README ("renderFrame") for the exact rules.
 * @packageDocumentation
 */
import {
  IndexedImage,
  RasterError,
  TiledImage,
  composite,
  crop,
  div255,
  flipH,
  outline,
  removeOrphans,
  translate,
} from '@pixel-forge/raster';
import type { Rgba } from '@pixel-forge/raster';
import { MAX_LAYER_DEPTH } from '@pixel-forge/schema';
import type {
  Animation,
  AnimRef,
  AuthoredAnimation,
  Frame,
  FrameId,
  FrameRef,
  ImageCel,
  Layer,
  LayerId,
  Override,
  Palette,
  PartLayer,
  PostPasses,
  Skin,
  SkinId,
} from '@pixel-forge/schema';
import { CoreError } from './errors.js';
import type { StoredImage } from './images.js';
import type { DeepReadonly } from './json.js';
import type { RenderedPart, RigFrameContext, RigRenderer } from './rig-hook.js';
import type { DocumentView } from './view.js';

/** A skin by id or by name; `'base'` (or no skin) is the unskinned render. */
export type SkinRef = { readonly id: SkinId } | { readonly name: string };

/** Options of {@link renderFrame}. */
export interface RenderOptions {
  /** Skin to apply last (FR-RIG-20 step 8). Default / `'base'`: none. */
  readonly skin?: SkinRef | 'base';
  /** Draw reference layers (editor view). Ignored when `exportOnly`. Default false. */
  readonly includeReference?: boolean;
  /** Only layers with `export: true` whose ancestor groups are all `export: true`. Default false. */
  readonly exportOnly?: boolean;
  /** The part renderer; required when the frame includes a part layer. */
  readonly rig?: RigRenderer;
  /**
   * Restrict drawing to these layers: a leaf layer is drawn when it, or one of its ancestor groups,
   * is listed. Visibility, opacity and `exportOnly` of every ancestor still apply. Unknown ids throw.
   */
  readonly layers?: readonly LayerId[];
}

/** One image to draw: the resolved cel of a pixel or reference layer. */
export interface DrawItem {
  readonly layerId: LayerId;
  readonly image: StoredImage;
  readonly x: number;
  readonly y: number;
  /** Final opacity 0..255: layer chain times cel opacity. */
  readonly opacity: number;
}

/** A part layer to hand to the rig, with its effective (group-multiplied) opacity. */
export interface PartItem {
  readonly layer: DeepReadonly<PartLayer>;
  readonly opacity: number;
}

/** An override with its images looked up. */
export interface ResolvedOverride {
  readonly override: DeepReadonly<Override>;
  readonly set: StoredImage | undefined;
  readonly erase: StoredImage | undefined;
}

/** Everything `renderFrame` resolves before touching a pixel. */
export interface RenderPlan {
  readonly source: DeepReadonly<AuthoredAnimation>;
  readonly mirrored: boolean;
  readonly frameIndex: number;
  readonly frame: DeepReadonly<Frame>;
  /** Pixel and reference layers in tree order (bottom to top). */
  readonly items: readonly DrawItem[];
  /** Part layers in tree order (empty: no rig needed). */
  readonly parts: readonly PartItem[];
  /**
   * Where the rig block sits among `items`: items `[0, rigAt)` draw below it, the rest above it.
   * It is the number of items that precede the first drawn part layer in tree order.
   */
  readonly rigAt: number;
  /** Post-passes of the authored (source) animation (FR-RIG-20 step 6). */
  readonly postPasses: DeepReadonly<PostPasses> | undefined;
  /** Final overrides of the source animation for this frame, in array order (step 7). */
  readonly finals: readonly ResolvedOverride[];
  /** A mirror's own final overrides for this frame, applied after the flip (empty otherwise). */
  readonly mirrorFinals: readonly ResolvedOverride[];
  readonly skin: DeepReadonly<Skin> | undefined;
  /** The active palette, when there is one. */
  readonly palette: DeepReadonly<Palette> | undefined;
}

const bad = (reason: string, message: string, details: Record<string, unknown> = {}): CoreError =>
  new CoreError('BAD_VALUE', message, { reason, ...details });

function findAnimation(view: DocumentView, ref: AnimRef): DeepReadonly<Animation> {
  const anims = view.doc.animations;
  const found =
    'id' in ref
      ? anims.find((a) => a.id === ref.id)
      : anims.find((a) => a.group === ref.group && a.direction === ref.direction);
  if (found === undefined) {
    throw new CoreError('BAD_ARGUMENT', `no animation for ${JSON.stringify(ref)}`, { ref });
  }
  return found;
}

function findFrame(anim: DeepReadonly<AuthoredAnimation>, ref: FrameRef): number {
  const i = typeof ref === 'number' ? ref : anim.frames.findIndex((f) => f.id === ref);
  if (i < 0 || i >= anim.frames.length) {
    throw new CoreError('BAD_ARGUMENT', `no frame ${String(ref)} in animation ${anim.id}`, {
      frame: ref,
    });
  }
  return i;
}

function findSkin(
  view: DocumentView,
  ref: SkinRef | 'base' | undefined,
): DeepReadonly<Skin> | undefined {
  if (ref === undefined || ref === 'base') return undefined;
  const skin =
    'id' in ref
      ? view.doc.skins.find((s) => s.id === ref.id)
      : view.doc.skins.find((s) => s.name === ref.name);
  if (skin === undefined) {
    throw new CoreError('BAD_ARGUMENT', `no skin ${JSON.stringify(ref)}`, { skin: ref });
  }
  return skin;
}

/** Resolves a cel of `layer` at `frameId` (one link hop). `undefined` for an empty frame. */
function resolveCel(
  layer: DeepReadonly<{ id: LayerId; cels: Record<string, unknown> }>,
  frameId: FrameId,
): DeepReadonly<ImageCel> | undefined {
  const cels = layer.cels as DeepReadonly<Record<FrameId, ImageCel | { linkTo: FrameId }>>;
  const cel = cels[frameId];
  if (cel === undefined) return undefined;
  if (!('linkTo' in cel)) return cel;
  const target = cels[cel.linkTo];
  if (target === undefined || 'linkTo' in target) {
    throw bad(
      'BROKEN_LINK',
      `layer ${layer.id}, frame ${frameId}: link to ${cel.linkTo} ${target === undefined ? 'has no cel' : 'is itself a link'}`,
      { layerId: layer.id, frameId, linkTo: cel.linkTo },
    );
  }
  return target;
}

/** Resolves refs, walks the layer tree and collects what to draw. No pixel work. */
export function planFrame(
  view: DocumentView,
  animRef: AnimRef,
  frameRef: FrameRef,
  opts: RenderOptions = {},
): RenderPlan {
  const doc = view.doc;
  let anim = findAnimation(view, animRef);
  const mirrored = 'mirrorOf' in anim;
  const mirrorOverrides: readonly DeepReadonly<Override>[] =
    'mirrorOf' in anim ? anim.overrides : [];
  if ('mirrorOf' in anim) {
    const mirrorOf = anim.mirrorOf;
    const src = doc.animations.find((a) => a.id === mirrorOf);
    if (src === undefined || 'mirrorOf' in src) {
      throw bad('BAD_MIRROR', `animation ${anim.id} mirrors ${mirrorOf}, which is not authored`, {
        animationId: anim.id,
      });
    }
    anim = src;
  }
  const source = anim;
  const frameIndex = findFrame(source, frameRef);
  const frame = source.frames[frameIndex];
  if (frame === undefined) throw bad('BAD_FRAME', 'frame index out of range');
  const skin = findSkin(view, opts.skin);

  const only = opts.layers === undefined ? undefined : new Set<LayerId>(opts.layers);
  const unknown = new Set(only);
  const items: DrawItem[] = [];
  const parts: PartItem[] = [];
  let rigAt = 0;
  const exportOnly = opts.exportOnly === true;
  const includeRef = opts.includeReference === true && !exportOnly;

  const walk = (
    layers: readonly DeepReadonly<Layer>[],
    parentOpacity: number,
    selected: boolean,
    depth: number,
  ): void => {
    if (depth > MAX_LAYER_DEPTH) throw bad('TOO_DEEP', 'layer tree is too deep');
    for (const layer of layers) {
      unknown.delete(layer.id);
      if (!layer.visible || (exportOnly && !layer.export)) continue;
      const eff = parentOpacity === 255 ? layer.opacity : div255(parentOpacity * layer.opacity);
      const sel = selected || only === undefined || only.has(layer.id);
      switch (layer.kind) {
        case 'group':
          walk(layer.children, eff, sel, depth + 1);
          break;
        case 'part':
          if (sel) {
            if (parts.length === 0) rigAt = items.length;
            parts.push({ layer, opacity: eff });
          }
          break;
        case 'reference':
        case 'pixel': {
          if (!sel || (layer.kind === 'reference' && !includeRef)) break;
          const cel = resolveCel(layer, frame.id);
          if (cel === undefined) break;
          const image = view.image(cel.imageId);
          if (image === undefined) {
            throw new CoreError('IMAGE_MISSING', `layer ${layer.id}: no image ${cel.imageId}`, {
              imageId: cel.imageId,
            });
          }
          items.push({
            layerId: layer.id,
            image,
            x: cel.offset.x,
            y: cel.offset.y,
            opacity: eff === 255 ? cel.opacity : div255(eff * cel.opacity),
          });
          break;
        }
      }
    }
  };
  walk(doc.layers, 255, false, 1);
  // A group listed in `layers` is "selected" for its subtree; walk marks `unknown` only for visited
  // nodes, and hidden subtrees are skipped before their ids are seen, so check the ids separately.
  if (only !== undefined && unknown.size > 0) {
    const all = new Set<LayerId>();
    const collect = (ls: readonly DeepReadonly<Layer>[]): void => {
      for (const l of ls) {
        all.add(l.id);
        if (l.kind === 'group') collect(l.children);
      }
    };
    collect(doc.layers);
    for (const id of unknown) {
      if (!all.has(id)) throw new CoreError('BAD_ARGUMENT', `no layer ${id}`, { layerId: id });
    }
  }

  const palette =
    doc.activePaletteId === undefined
      ? undefined
      : doc.palettes.find((p) => p.id === doc.activePaletteId);
  const finalsOf = (list: readonly DeepReadonly<Override>[]): ResolvedOverride[] =>
    list
      .filter((o) => o.frameId === frame.id && o.target === 'final')
      .map((o) => {
        const get = (id: Override['set']): StoredImage | undefined => {
          if (id === undefined) return undefined;
          const img = view.image(id);
          if (img === undefined) {
            throw new CoreError('IMAGE_MISSING', `override ${o.id}: no image ${id}`, {
              imageId: id,
              overrideId: o.id,
            });
          }
          return img;
        };
        return { override: o, set: get(o.set), erase: get(o.erase) };
      });
  return {
    source,
    mirrored,
    frameIndex,
    frame,
    items,
    parts,
    rigAt,
    postPasses: source.postPasses,
    finals: finalsOf(source.overrides),
    mirrorFinals: finalsOf(mirrorOverrides),
    skin,
    palette,
  };
}

/**
 * Converts a stored image to RGBA. Indexed images resolve through the base (active) palette, never a
 * skin: the skin is applied last, by colour, on the composite (FR-RIG-20 step 8).
 * `transparentIndex` is always transparent.
 */
function toRgba(plan: RenderPlan, img: StoredImage): TiledImage {
  if (img instanceof TiledImage) return img;
  const pal = plan.palette;
  if (pal === undefined) {
    throw bad('NO_PALETTE', 'an indexed image needs the document to have an active palette');
  }
  const lut = (pal.colors as readonly Rgba[]).slice();
  lut[img.transparentIndex] = [0, 0, 0, 0];
  try {
    return TiledImage.fromRGBA(img.toRGBA(lut));
  } catch {
    throw bad('BAD_INDEX', 'an indexed image uses an index that the palette does not have');
  }
}

/** The palette of a palette-skin, or undefined. */
export function skinPaletteOf(
  view: DocumentView,
  skin: DeepReadonly<Skin> | undefined,
): DeepReadonly<Palette> | undefined {
  if (skin === undefined || !('paletteId' in skin)) return undefined;
  const pal = view.doc.palettes.find((p) => p.id === skin.paletteId);
  if (pal === undefined) {
    throw bad('NO_PALETTE', `skin ${skin.id} uses palette ${skin.paletteId}, which does not exist`);
  }
  return pal;
}

/**
 * Skin on the RGBA composite (step 8, both colour modes): each pixel whose RGB equals the RGB of an
 * active-palette entry with alpha > 0 takes the RGB of the skin's colour for that index (remap:
 * `palette[remap(i)]`; palette skin: `skinPalette[i]`). With duplicate colours in the palette the
 * lowest index wins, even when the skin has no entry for it (the pixel then stays). Alpha is kept;
 * non-matching (blended) pixels are unchanged.
 */
function skinRgba(
  img: TiledImage,
  plan: RenderPlan,
  skinPalette: DeepReadonly<Palette> | undefined,
): TiledImage {
  const skin = plan.skin;
  const pal = plan.palette;
  if (skin === undefined || pal === undefined) return img;
  const base = pal.colors as readonly Rgba[];
  const remap = new Map<number, number>();
  if ('remap' in skin) for (const [from, to] of skin.remap) remap.set(from, to);
  const target = new Map<number, Rgba | undefined>();
  base.forEach((c, i) => {
    const key = (c[0] << 16) | (c[1] << 8) | c[2];
    if (c[3] === 0 || target.has(key)) return;
    target.set(
      key,
      skinPalette !== undefined
        ? (skinPalette.colors as readonly Rgba[])[i]
        : base[remap.get(i) ?? i],
    );
  });
  const dense = img.toRGBA();
  const d = dense.data;
  let changed = false;
  for (let p = 0; p < d.length; p += 4) {
    if (d[p + 3] === 0) continue;
    const t = target.get(((d[p] ?? 0) << 16) | ((d[p + 1] ?? 0) << 8) | (d[p + 2] ?? 0));
    if (t === undefined) continue;
    d[p] = t[0];
    d[p + 1] = t[1];
    d[p + 2] = t[2];
    changed = true;
  }
  return changed ? TiledImage.fromRGBA(dense) : img;
}

/** FR-RIG-20 step 6: orphan removal, then outline, cropped back to the canvas. */
function applyPostPasses(
  img: TiledImage,
  passes: DeepReadonly<PostPasses> | undefined,
): TiledImage {
  if (passes === undefined) return img;
  let out = img;
  if (passes.removeOrphans !== undefined) out = removeOrphans(out).img;
  const o = passes.outline;
  if (o !== undefined) {
    try {
      const grown = outline(out, [...o.color] as unknown as Rgba, {
        outsideOnly: o.outsideOnly ?? true,
        corners: o.corners === true ? 'square' : 'round',
      });
      // The outline grows the canvas by 1 px per side; outlining happens only within the canvas.
      out = crop(grown.img, { x: grown.offset.x, y: grown.offset.y, w: img.width, h: img.height });
    } catch (e) {
      if (e instanceof RasterError) {
        throw bad('BAD_POSTPASS', `outline post-pass: ${e.message}`);
      }
      throw e;
    }
  }
  return out;
}

/** The value of an 8-bit erase mask at a pixel: the index (indexed) or the alpha (RGBA-stored). */
const maskAt = (m: StoredImage, x: number, y: number): number =>
  m instanceof IndexedImage ? m.get(x, y) : m.get(x, y)[3];

/**
 * FR-RIG-22 / clarification 11: per override, in array order, `erase` (mask 255 clears) then `set`
 * (painted over the result), both anchored at the canvas position `anchor`; clipped to the canvas.
 */
function applyFinals(
  img: TiledImage,
  plan: RenderPlan,
  finals: readonly ResolvedOverride[],
): TiledImage {
  if (finals.length === 0) return img;
  const out = img.clone();
  for (const { override, set, erase } of finals) {
    const { x: ax, y: ay } = override.anchor;
    if (erase !== undefined) {
      const b = erase.bounds();
      if (b !== undefined) {
        for (let y = b.y; y < b.y + b.h; y++) {
          for (let x = b.x; x < b.x + b.w; x++) {
            if (maskAt(erase, x, y) === 255) out.set(ax + x, ay + y, [0, 0, 0, 0]);
          }
        }
      }
    }
    if (set !== undefined) composite(out, toRgba(plan, set), { x: ax, y: ay });
  }
  return out;
}

/**
 * Renders one frame to an RGBA image of `meta.canvas` size. Pure: the result depends only on the
 * arguments. See the package README for the rules. Pipeline: (5) composite, with the rig block at the
 * tree position of the first part layer; (6) post-passes of the authored animation; (7) its final
 * overrides; for a mirror: flip, then the mirror's own final overrides; (8) skin by colour.
 *
 * @throws CoreError `BAD_ARGUMENT` (unknown animation, frame, skin or layer), `BAD_VALUE` with
 * `details.reason` `BROKEN_LINK` | `BAD_MIRROR` | `NO_PALETTE` | `BAD_INDEX` | `TOO_DEEP` | `BAD_RIG` | `BAD_POSTPASS`,
 * `IMAGE_MISSING`, `NO_RIG_RENDERER`.
 */
export function renderFrame(
  view: DocumentView,
  anim: AnimRef,
  frame: FrameRef,
  opts: RenderOptions = {},
): TiledImage {
  return renderPlan(view, planFrame(view, anim, frame, opts), opts);
}

/**
 * Executes a plan (see {@link renderFrame}): composite (step 5), post-passes (6), final overrides (7),
 * the mirror flip and the mirror's own final overrides, then the skin (8).
 */
export function renderPlan(view: DocumentView, plan: RenderPlan, opts: RenderOptions): TiledImage {
  const { w, h } = view.doc.meta.canvas;
  const skinPalette = skinPaletteOf(view, plan.skin);
  let result = new TiledImage(w, h);

  // Step 5: the rig block (all parts by ascending z) sits at the tree position of the first part layer.
  let rigBlock: { part: RenderedPart; o: number }[] = [];
  if (plan.parts.length > 0) {
    const rig = opts.rig;
    if (rig === undefined) {
      throw new CoreError(
        'NO_RIG_RENDERER',
        `frame ${plan.frame.id} has part layers but no RigRenderer was given`,
        { frameId: plan.frame.id },
      );
    }
    const ctx: RigFrameContext = {
      view,
      animation: plan.source,
      frameIndex: plan.frameIndex,
      frame: plan.frame,
      partLayers: plan.parts.map((p) => p.layer),
    };
    const opacityOf = new Map(plan.parts.map((p, i) => [p.layer.id, { i, o: p.opacity }]));
    const rendered = rig.renderParts(ctx).map((part, n) => {
      const info = opacityOf.get(part.layerId);
      if (info === undefined) {
        throw bad('BAD_RIG', `renderParts returned a part for unknown layer ${part.layerId}`);
      }
      return { part, n, ...info };
    });
    rendered.sort((a, b) => a.part.z - b.part.z || a.i - b.i || a.n - b.n);
    rigBlock = rendered;
  }
  const drawItem = (item: DrawItem): void => {
    composite(result, toRgba(plan, item.image), { x: item.x, y: item.y, opacity: item.opacity });
  };
  plan.items.slice(0, plan.rigAt).forEach(drawItem);
  for (const { part, o } of rigBlock) {
    composite(result, toRgba(plan, part.image), { x: part.offset.x, y: part.offset.y, opacity: o });
  }
  plan.items.slice(plan.rigAt).forEach(drawItem);

  result = applyPostPasses(result, plan.postPasses); // step 6
  result = applyFinals(result, plan, plan.finals); // step 7

  if (plan.mirrored) {
    // x' = 2*origin.x - x: the origin column stays put (same rule as the markers, FR-RIG-16).
    const flipped = flipH(result);
    result = translate(flipped, 2 * view.doc.meta.origin.x - (w - 1), 0);
    result = applyFinals(result, plan, plan.mirrorFinals);
  }
  return skinRgba(result, plan, skinPalette); // step 8
}
