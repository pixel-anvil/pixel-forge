/**
 * `paintOverlapTx` (FR-RIG-07, T3.5 follow-up for T5.2b): paints the hidden overlap that closes the
 * joint gaps, as the W2b test did by hand. For every joint with gaps `rig`'s `overlapMasks` gives the
 * pixels of the part drawn lower that the upper part covers at rest; this grows that variant's image
 * to hold them, paints them, and shifts the variant pivot by the growth, so the rest composite does
 * not change and the gaps close. One edit of the open transaction.
 * @packageDocumentation
 */
import { IndexedImage, TiledImage, div255 } from '@pixel-forge/raster';
import type { Rgba } from '@pixel-forge/raster';
import { overlapMasks } from '@pixel-forge/rig';
import type { OverlapSkipped } from '@pixel-forge/rig';
import type {
  BoneId,
  ImageId,
  Layer,
  LayerId,
  PartId,
  VariantId,
  ViewId,
} from '@pixel-forge/schema';
import { CoreError } from './errors.js';
import { referencedImages } from './frames.js';
import type { StoredImage } from './images.js';
import type { DeepReadonly } from './json.js';
import type { Transaction } from './transaction.js';

/** Why a paint was refused (`CoreError.details.reason`, code `BAD_ARGUMENT`). */
export type PaintOverlapReason =
  | 'no-rig' // the document has no rig
  | 'no-view' // the rig has no view to check
  | 'unknown-view' // `viewId` names no view
  | 'unknown-bone' // a bone of `bones` does not exist
  | 'bad-color'; // `color` does not fit the image kind, or the variant has no colour to copy

/** Options of {@link paintOverlapTx}. */
export interface PaintOverlapOptions {
  /** View to check (its first direction, like `jointCheck`). Default: the first view. */
  readonly viewId?: ViewId;
  /** Only joints whose child bone is one of these. Default: every joint with gaps. */
  readonly bones?: readonly BoneId[];
  /**
   * What to paint: an `Rgba` in an RGBA document, a palette index in an indexed one. Default: the
   * most frequent opaque colour of the painted variant that is not its outline colour (RIG-08;
   * ties: the smaller packed value). The outline colour is the darkest colour that touches a
   * transparent pixel or the image edge. A variant with no other colour uses the most frequent one.
   */
  readonly color?: Rgba | number;
}

/** One variant that received paint. */
export interface PaintedVariant {
  readonly partId: PartId;
  readonly variantId: VariantId;
  /** The variant's new image (the old one is deleted when nothing else uses it). */
  readonly imageId: ImageId;
  /** Child bone names of the joints whose gaps this paint serves. */
  readonly bones: readonly string[];
  /** Pixels painted. */
  readonly pixels: number;
  /** How many pixels the image grew on each side. */
  readonly grew: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  /** The variant pivot afterwards. */
  readonly pivot: { readonly x: number; readonly y: number };
}

/** Result of {@link paintOverlapTx}. */
export interface PaintOverlapResult {
  /** The variants that were painted (empty when no joint has gaps). */
  readonly painted: readonly PaintedVariant[];
  /** Joints whose gaps no hidden pixel can close: they need a visible art change. */
  readonly uncovered: readonly { readonly bone: string; readonly pixels: number }[];
  /** Joints the overlap helper cannot handle (`ambiguous-parts`, `rotated-rest`). */
  readonly skipped: readonly OverlapSkipped[];
}

const refuse = (reason: PaintOverlapReason, message: string): CoreError =>
  new CoreError('BAD_ARGUMENT', message, { reason });

/**
 * The effective opacity (0..255) of every part layer: its own opacity times its groups', as the frame
 * render applies it. A part layer under a hidden group or hidden itself is never drawn, so it counts as 0.
 */
function partLayerOpacity(
  layers: readonly DeepReadonly<Layer>[],
  parent = 255,
  out: Partial<Record<LayerId, number>> = {},
): Partial<Record<LayerId, number>> {
  for (const l of layers) {
    const eff = l.visible ? div255(parent * l.opacity) : 0;
    if (l.kind === 'group') partLayerOpacity(l.children, eff, out);
    else if (l.kind === 'part') out[l.id] = eff;
  }
  return out;
}

/**
 * The most frequent opaque colour (RGBA) or index of an image, ignoring its outline colour, or
 * `undefined` when it has no opaque pixel. The outline colour is the darkest colour (lowest
 * luma; ties: the smaller key) that has a pixel next to a transparent pixel or the image edge.
 * When that leaves no colour, the plain most frequent one is returned.
 */
function dominant(
  img: StoredImage,
  palette: readonly Rgba[] | undefined,
): Rgba | number | undefined {
  const w = img.width;
  const h = img.height;
  const keys = new Uint32Array(w * h); // packed RGBA, or the index; opaque only
  const opaque = new Uint8Array(w * h);
  if (img instanceof IndexedImage) {
    const ix = img.toIndices();
    for (let i = 0; i < ix.length; i++) {
      if (ix[i] !== img.transparentIndex) {
        opaque[i] = 1;
        keys[i] = ix[i] ?? 0;
      }
    }
  } else {
    const { data } = img.toRGBA();
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      if ((data[o + 3] ?? 0) === 0) continue;
      opaque[i] = 1;
      keys[i] =
        (((data[o] ?? 0) << 24) |
          ((data[o + 1] ?? 0) << 16) |
          ((data[o + 2] ?? 0) << 8) |
          (data[o + 3] ?? 0)) >>>
        0;
    }
  }
  const counts = new Map<number, number>();
  const edge = new Set<number>(); // colours with a pixel next to transparency
  const clear = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= w || y >= h || opaque[y * w + x] === 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (opaque[i] === 0) continue;
      const k = keys[i] ?? 0;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (clear(x - 1, y) || clear(x + 1, y) || clear(x, y - 1) || clear(x, y + 1)) edge.add(k);
    }
  }
  const rgba = (k: number): Rgba =>
    img instanceof IndexedImage
      ? (palette?.[k] ?? [0, 0, 0, 255])
      : [(k >>> 24) & 255, (k >>> 16) & 255, (k >>> 8) & 255, k & 255];
  const luma = (k: number): number => {
    const c = rgba(k);
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const sorted = [...counts.keys()].sort((a, b) => a - b);
  let outline: number | undefined;
  for (const k of sorted) {
    if (edge.has(k) && (outline === undefined || luma(k) < luma(outline))) outline = k;
  }
  const pick = (skip: number | undefined): number | undefined => {
    let best: number | undefined;
    for (const k of sorted) {
      if (k === skip) continue;
      if (best === undefined || (counts.get(k) ?? 0) > (counts.get(best) ?? 0)) best = k;
    }
    return best;
  };
  const best = pick(outline) ?? pick(undefined);
  if (best === undefined) return undefined;
  return img instanceof IndexedImage ? best : rgba(best);
}

/**
 * Closes the joint gaps of one view by painting hidden overlap (see the module comment). The mask is
 * `overlapMasks`' (3x3 blocks around each gap's inverse-rotated source, limited to pixels the upper
 * part covers and the painted part does not draw), so painting it leaves the composite at rest
 * unchanged. Joints that share a variant are painted together. Pixels the variant already draws are
 * kept. The judge afterwards is `jointCheck` (KNOWN_ISSUES RIG-05): `uncovered` lists the joints no
 * hidden paint can close. Nothing changes when no joint has gaps.
 *
 * @throws CoreError `BAD_ARGUMENT` with `details.reason` a {@link PaintOverlapReason}.
 */
export function paintOverlapTx(
  tx: Transaction,
  opts: PaintOverlapOptions = {},
): PaintOverlapResult {
  const doc = tx.doc;
  const rig = doc.rig;
  if (rig === undefined) throw refuse('no-rig', 'the document has no rig');
  const view =
    opts.viewId === undefined ? rig.views[0] : rig.views.find((v) => v.id === opts.viewId);
  if (view === undefined) {
    throw opts.viewId === undefined
      ? refuse('no-view', 'the rig has no view')
      : refuse('unknown-view', `no view ${opts.viewId}`);
  }
  // `OverlapJoint.bone` is the child bone's name (the joint's name); `boneId` is the painted part's.
  const only = new Set<string>();
  for (const b of opts.bones ?? []) {
    const bone = rig.bones.find((x) => x.id === b);
    if (bone === undefined) throw refuse('unknown-bone', `no bone ${b}`);
    only.add(bone.name);
  }
  const direction = view.directions[0];
  const palette =
    doc.meta.colorMode === 'indexed'
      ? (doc.palettes.find((p) => p.id === doc.activePaletteId)?.colors ?? []).map((c): Rgba => [
          c[0],
          c[1],
          c[2],
          c[3],
        ])
      : undefined;
  // Paint only hides under a part that is drawn at full opacity (translucent uppers show it through).
  const layerOpacity = partLayerOpacity(doc.layers);
  const report = overlapMasks({
    rig,
    images: tx,
    canvas: doc.meta.canvas,
    layerOpacity,
    // The walk above is the render's, so its keys are the render's tie order on equal z.
    layerOrder: Object.keys(layerOpacity) as LayerId[],
    ...(direction === undefined ? {} : { direction }),
    ...(palette === undefined ? {} : { palette }),
  });
  const joints = report.joints.filter((j) => only.size === 0 || only.has(j.bone));
  const uncovered = joints
    .filter((j) => j.uncovered.length > 0)
    .map((j) => ({ bone: j.bone, pixels: j.uncovered.length }));

  // Group by painted variant, then plan every image before touching the document.
  const groups = new Map<
    string,
    { partId: PartId; variantId: VariantId; bones: string[]; local: (readonly [number, number])[] }
  >();
  for (const j of joints) {
    if (j.local.length === 0) continue;
    const key = `${j.partId}/${j.variantId}`;
    const g = groups.get(key) ?? { partId: j.partId, variantId: j.variantId, bones: [], local: [] };
    g.bones.push(j.bone);
    // A loop, not `push(...j.local)`: spreading a per-pixel list overflows the call stack near 125,000 items.
    for (const px of j.local) g.local.push(px);
    groups.set(key, g);
  }
  const plan = [...groups.values()].map((g) => {
    const variant = rig.parts
      .find((p) => p.id === g.partId)
      ?.variants.find((v) => v.id === g.variantId);
    const old = variant === undefined ? undefined : tx.image(variant.imageId);
    if (variant === undefined || old === undefined) {
      throw new CoreError('IMAGE_MISSING', `variant ${g.variantId} has no stored image`);
    }
    const color = opts.color ?? dominant(old, palette);
    if (color === undefined) {
      throw refuse('bad-color', `variant ${g.variantId} has no colour to copy; pass "color"`);
    }
    const minX = Math.min(0, ...g.local.map((p) => p[0]));
    const minY = Math.min(0, ...g.local.map((p) => p[1]));
    const maxX = Math.max(old.width - 1, ...g.local.map((p) => p[0]));
    const maxY = Math.max(old.height - 1, ...g.local.map((p) => p[1]));
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    let pixels = 0;
    let image: StoredImage;
    if (old instanceof IndexedImage) {
      if (typeof color !== 'number') {
        throw refuse('bad-color', 'an indexed document takes a palette index as color');
      }
      const t = old.transparentIndex;
      const data = new Uint8Array(w * h).fill(t);
      const src = old.toIndices();
      for (let y = 0; y < old.height; y++) {
        data.set(src.subarray(y * old.width, (y + 1) * old.width), (y - minY) * w - minX);
      }
      for (const [px, py] of g.local) {
        const at = (py - minY) * w + (px - minX);
        if (data[at] === t) {
          data[at] = color;
          pixels += 1;
        }
      }
      image = IndexedImage.fromIndices(w, h, data, t);
    } else {
      if (typeof color === 'number') {
        throw refuse('bad-color', 'an RGBA document takes an [r, g, b, a] color');
      }
      const data = new Uint8Array(w * h * 4);
      const src = old.toRGBA().data;
      for (let y = 0; y < old.height; y++) {
        data.set(
          src.subarray(y * old.width * 4, (y + 1) * old.width * 4),
          ((y - minY) * w - minX) * 4,
        );
      }
      for (const [px, py] of g.local) {
        const at = ((py - minY) * w + (px - minX)) * 4;
        if (data[at + 3] === 0) {
          data.set(color, at);
          pixels += 1;
        }
      }
      image = TiledImage.fromRGBA({ width: w, height: h, data });
    }
    return { g, variant, minX, minY, maxX, maxY, old, pixels, image };
  });

  const painted: PaintedVariant[] = [];
  for (const p of plan) {
    const imageId = tx.createImage(p.image);
    const pivot = { x: p.variant.pivot.x - p.minX, y: p.variant.pivot.y - p.minY };
    tx.update((d) => {
      const dv = d.rig?.parts
        .find((x) => x.id === p.g.partId)
        ?.variants.find((x) => x.id === p.g.variantId);
      if (dv === undefined) return;
      dv.imageId = imageId;
      dv.pivot = { ...pivot };
    });
    painted.push({
      partId: p.g.partId,
      variantId: p.g.variantId,
      imageId,
      bones: p.g.bones,
      pixels: p.pixels,
      grew: {
        left: -p.minX,
        top: -p.minY,
        right: p.maxX - (p.old.width - 1),
        bottom: p.maxY - (p.old.height - 1),
      },
      pivot,
    });
  }
  const still = referencedImages(tx.doc);
  for (const p of plan) {
    if (!still.has(p.variant.imageId) && tx.image(p.variant.imageId) !== undefined) {
      tx.deleteImage(p.variant.imageId);
    }
  }
  return { painted, uncovered, skipped: report.skipped };
}
