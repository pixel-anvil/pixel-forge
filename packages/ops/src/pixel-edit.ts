/**
 * The shared path of the pixel-editing ops (`pixels.writeGrid`, `draw.shapes`, `selection.transform`,
 * `shade.withRamp`): they change a {@link PixelField} (a canvas-sized view of the target) and
 * {@link editPixels} stores the difference. A rig frame stores it as overrides of that frame
 * (`attributeEdit`); a flat frame rewrites one pixel layer's cel as a new canvas-sized image.
 * @packageDocumentation
 */
import { referencedImages } from '@pixel-forge/core';
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import type { Rgba } from '@pixel-forge/raster';
import type { Document, LayerId } from '@pixel-forge/schema';
import { z } from 'zod';
import {
  activePalette,
  celContent,
  celPixelReader,
  paletteIndexOf,
  resolveCelLayer,
  transparentIndexOf,
} from './cel.js';
import type { OpContext } from './context.js';
import { OpError } from './errors.js';
import { attributeFrameEdit, sameColor } from './frame-edit.js';
import { toHex } from './grid.js';
import { frameIndexOf } from './overlay.js';
import {
  animationLabel,
  resolveAnimation,
  resolveAuthoredAnimation,
  resolveFrame,
  walkLayers,
} from './refs.js';
import type { AnimRef, FrameRef } from './refs.js';

/**
 * A canvas-sized working copy of the target pixels. `image` is a plain RGBA image, so the raster
 * primitives (`line`, `rect`, `ellipse`, `floodFill`, the transforms) draw on it directly. Only
 * pixels whose colour really changed are stored afterwards. Positions outside the canvas read
 * transparent and ignore writes.
 */
export class PixelField {
  /** The working copy; draw on it. */
  readonly image: TiledImage;
  private readonly original: TiledImage;

  constructor(
    /** Canvas width, px. */
    readonly width: number,
    /** Canvas height, px. */
    readonly height: number,
    base: (x: number, y: number) => Rgba,
  ) {
    this.original = new TiledImage(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const c = base(x, y);
        if (c[3] !== 0) this.original.set(x, y, c);
      }
    }
    this.image = this.original.clone();
  }

  /** True when `(x, y)` is on the canvas. */
  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** The colour at `(x, y)` now (transparent outside the canvas). */
  get(x: number, y: number): Rgba {
    return this.image.get(x, y);
  }

  /** Sets `(x, y)`; returns false (and writes nothing) outside the canvas. */
  set(x: number, y: number, colour: Rgba): boolean {
    return this.image.set(x, y, colour);
  }

  /** The pixels whose colour differs from the original, in row-major order. */
  changes(): { x: number; y: number; colour: Rgba }[] {
    const out: { x: number; y: number; colour: Rgba }[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const colour = this.image.get(x, y);
        if (!sameColor(this.original.get(x, y), colour)) out.push({ x, y, colour });
      }
    }
    return out;
  }
}

/** What {@link editPixels} reports (the common part of every pixel-editing op's output). */
export interface PixelEditReport {
  readonly animation: string;
  readonly frameIndex: number;
  readonly target: 'overrides' | 'cel';
  readonly changed: number;
  readonly layer?: string;
  readonly overrides: string[];
  readonly newlyStale: string[];
}

/** Which frame and layer a pixel-editing op targets. */
export interface PixelTarget {
  readonly animation: AnimRef;
  readonly frame: FrameRef;
  readonly layer?: string | undefined;
}

/** Sets `layerId`'s cel at `frameId` to a canvas-sized image at offset 0,0 (in the draft). */
export function setCel(
  draft: Document,
  layerId: LayerId,
  frameId: string,
  cel: { imageId: string; opacity: number },
): void {
  const visit = (layers: Document['layers']): boolean => {
    for (const l of layers) {
      if (l.kind === 'group' && visit(l.children)) return true;
      if ((l.kind === 'pixel' || l.kind === 'reference') && l.id === layerId) {
        Reflect.set(l.cels, frameId, {
          imageId: cel.imageId,
          offset: { x: 0, y: 0 },
          opacity: cel.opacity,
        });
        return true;
      }
    }
    return false;
  };
  visit(draft.layers);
}

/** Copies the non-empty pixels of `src` (placed at `offset`) into `dst`. */
function copyInto(
  src: TiledImage | IndexedImage,
  offset: { readonly x: number; readonly y: number },
  dst: TiledImage | IndexedImage,
): void {
  const box = src.bounds();
  if (box === undefined) return;
  for (let yy = box.y; yy < box.y + box.h; yy++) {
    for (let xx = box.x; xx < box.x + box.w; xx++) {
      if (src instanceof TiledImage && dst instanceof TiledImage) {
        dst.set(xx + offset.x, yy + offset.y, src.get(xx, yy));
      } else if (src instanceof IndexedImage && dst instanceof IndexedImage) {
        dst.set(xx + offset.x, yy + offset.y, src.get(xx, yy));
      }
    }
  }
}

/**
 * Resolves the target, runs `edit` on a {@link PixelField} of it and stores the changes.
 * A rig document with no `layer` edits the rendered frame (overrides); otherwise the named pixel
 * layer (or the only one) is rewritten.
 * @throws OpError `REFUSED` (`layer-required`, `reference-layer`, `linked-cel`, `no-palette`,
 *   `no-transparent-index`, `off-palette`), `NOT_FOUND`/`AMBIGUOUS` from the resolvers.
 */
export function editPixels(
  ctx: OpContext,
  target: PixelTarget,
  edit: (field: PixelField) => void,
): PixelEditReport {
  const doc = ctx.doc;
  const { w: cw, h: ch } = doc.meta.canvas;
  const layers = walkLayers(doc);
  const hasParts = layers.some((l) => l.layer.kind === 'part');
  const pixelLayers = layers.filter((l) => l.layer.kind === 'pixel');
  let layerRef = target.layer;
  if (layerRef === undefined && !hasParts) {
    const only = pixelLayers[0];
    if (only === undefined || pixelLayers.length > 1) {
      throw new OpError(
        'REFUSED',
        pixelLayers.length === 0
          ? 'the document has no pixel layer to write'
          : `name the pixel layer to write: ${pixelLayers.map((l) => l.path).join(', ')}`,
        { reason: 'layer-required', available: pixelLayers.map((l) => l.path) },
      );
    }
    layerRef = only.layer.id;
  }

  // ---- rig frame: the rendered frame, edited into overrides --------------------------------
  if (layerRef === undefined) {
    const { animation } = resolveAnimation(doc, target.animation);
    const frameIndex = frameIndexOf(ctx, target.animation, target.frame);
    const before = ctx.renderFrame(target.animation, frameIndex, { exportOnly: true });
    const field = new PixelField(cw, ch, (x, y) => before.get(x, y));
    edit(field);
    const changes = field.changes();
    const base = {
      animation: animationLabel(animation),
      frameIndex,
      target: 'overrides' as const,
    };
    if (changes.length === 0) return { ...base, changed: 0, overrides: [], newlyStale: [] };
    const edited = before.clone();
    for (const c of changes) edited.set(c.x, c.y, c.colour);
    const result = attributeFrameEdit(ctx, ctx.tx, target.animation, frameIndex, edited);
    return { ...base, changed: changes.length, ...result };
  }

  // ---- flat frame: one pixel layer's cel ---------------------------------------------------
  const layer = resolveCelLayer(doc, layerRef);
  if (layer.kind === 'reference') {
    throw new OpError('REFUSED', `layer ${layer.name} is a reference layer and is not written`, {
      reason: 'reference-layer',
    });
  }
  const { animation } = resolveAuthoredAnimation(doc, target.animation);
  const { index: frameIndex, frame } = resolveFrame(animation, target.frame);
  const cel = celContent(ctx, layer, frame.id);
  if (cel?.linked === true) {
    const link = layer.cels[frame.id];
    throw new OpError(
      'REFUSED',
      `layer ${layer.name} at frame ${String(frameIndex)} shares the cel of frame ${link !== undefined && 'linkTo' in link ? link.linkTo : '?'}; unlink it first, or write that frame (both change)`,
      { reason: 'linked-cel' },
    );
  }
  const palette = activePalette(doc);
  const indexed = doc.meta.colorMode === 'indexed';
  const field = new PixelField(cw, ch, celPixelReader(doc, cel));
  const base = {
    animation: animationLabel(animation),
    frameIndex,
    target: 'cel' as const,
    layer: layer.name,
    overrides: [],
    newlyStale: [],
  };
  edit(field);
  const changes = field.changes();
  if (changes.length === 0) return { ...base, changed: 0 };

  // A new canvas-sized image holding the old cel pixels with the changes written over them.
  let next: TiledImage | IndexedImage;
  if (indexed) {
    if (palette === undefined) {
      throw new OpError('REFUSED', 'the document is indexed but has no active palette', {
        reason: 'no-palette',
      });
    }
    const transparent =
      cel?.image instanceof IndexedImage ? cel.image.transparentIndex : transparentIndexOf(palette);
    if (transparent === undefined) {
      throw new OpError('REFUSED', 'the palette has no transparent entry (alpha 0) to erase with', {
        reason: 'no-transparent-index',
      });
    }
    const out = new IndexedImage(cw, ch, transparent);
    if (cel?.image instanceof IndexedImage) copyInto(cel.image, cel.offset, out);
    for (const c of changes) {
      const index = c.colour[3] === 0 ? transparent : paletteIndexOf(palette, c.colour);
      if (index === undefined) {
        throw new OpError(
          'REFUSED',
          `colour ${toHex(c.colour)} is not in the indexed document's palette "${palette.name}"`,
          { reason: 'off-palette', colors: [toHex(c.colour)], palette: palette.name },
        );
      }
      out.set(c.x, c.y, index);
    }
    next = out;
  } else {
    const out = new TiledImage(cw, ch);
    if (cel?.image instanceof TiledImage) copyInto(cel.image, cel.offset, out);
    for (const c of changes) out.set(c.x, c.y, c.colour);
    next = out;
  }
  const imageId = ctx.tx.createImage(next);
  ctx.tx.update((d) => {
    setCel(d, layer.id, frame.id, { imageId, opacity: cel?.opacity ?? 255 });
  });
  if (cel !== undefined && !referencedImages(ctx.tx.doc).has(cel.imageId)) {
    ctx.tx.deleteImage(cel.imageId);
  }
  return { ...base, changed: changes.length };
}

/** Output fields every pixel-editing op returns (spread into its `z.strictObject`). */
export const editOutputShape = {
  animation: z.string().describe('"group/direction" of the animation edited.'),
  frameIndex: z.int().describe('0-based index of the frame edited.'),
  target: z
    .enum(['overrides', 'cel'])
    .describe(
      '"overrides": rig frame, stored as overrides; "cel": a pixel layer cel was rewritten.',
    ),
  changed: z.int().describe('Pixels whose colour changed (0: nothing was written).'),
  layer: z.string().optional().describe('Name of the layer written; only for target "cel".'),
  overrides: z
    .array(z.string())
    .describe('Ids of the overrides created; empty unless "overrides".'),
  newlyStale: z.array(z.string()).describe('Ids of earlier overrides this edit made stale.'),
};

/** A rectangle of canvas pixels, top-left corner and size. */
export const RegionInput = z.strictObject({
  x: z.int().min(0).describe('Left column.'),
  y: z.int().min(0).describe('Top row.'),
  w: z.int().min(1).describe('Width, px.'),
  h: z.int().min(1).describe('Height, px.'),
});
/** A rectangle of canvas pixels. */
export type Region = z.output<typeof RegionInput>;

/**
 * The region, or the whole canvas when omitted.
 * @throws OpError `REFUSED` (`reason: 'out-of-canvas'`) when it reaches outside the canvas.
 */
export function resolveRegion(ctx: OpContext, region: Region | undefined): Region {
  const { w: cw, h: ch } = ctx.doc.meta.canvas;
  if (region === undefined) return { x: 0, y: 0, w: cw, h: ch };
  if (region.x + region.w > cw || region.y + region.h > ch) {
    throw new OpError(
      'REFUSED',
      `the region (${String(region.x)},${String(region.y)}) ${String(region.w)}x${String(region.h)} reaches outside the ${String(cw)}x${String(ch)} canvas`,
      { reason: 'out-of-canvas', canvas: { w: cw, h: ch } },
    );
  }
  return region;
}
