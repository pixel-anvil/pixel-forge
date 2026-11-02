/**
 * Reading and writing the pixels of one cel for the grid ops, as canvas-sized views.
 * @packageDocumentation
 */
import { TiledImage } from '@pixel-forge/raster';
import type { Rgba } from '@pixel-forge/raster';
import type { Cel, FrameId, ImageId, Palette } from '@pixel-forge/schema';
import type { DeepReadonly, StoredImage } from '@pixel-forge/core';
import type { OpContext } from './context.js';
import { OpError } from './errors.js';
import { resolveLayer } from './refs.js';
import type { ReadonlyDocument } from './refs.js';

/** A layer with cels (pixel or reference). */
export type CelLayer = Extract<ReadonlyDocument['layers'][number], { cels: unknown }>;

/** The active palette of `doc`, if any. */
export function activePalette(doc: ReadonlyDocument): DeepReadonly<Palette> | undefined {
  return doc.palettes.find((p) => p.id === doc.activePaletteId);
}

/** What a frame's cel of a layer holds: a stored image at an offset, or nothing. */
export interface CelContent {
  readonly imageId: ImageId;
  readonly image: StoredImage;
  readonly offset: { readonly x: number; readonly y: number };
  readonly opacity: number;
  /** True when the cel at this frame is a link (its content belongs to another frame's cel). */
  readonly linked: boolean;
}

/**
 * The cel of `layer` at `frameId`, following one link. `undefined` for an empty frame.
 * @throws OpError `REFUSED` (`reason: 'broken-link'`) for a link to nothing.
 */
export function celContent(
  ctx: OpContext,
  layer: CelLayer,
  frameId: FrameId,
): CelContent | undefined {
  const cels: DeepReadonly<Record<string, Cel>> = layer.cels;
  const first = cels[frameId];
  if (first === undefined) return undefined;
  const linked = 'linkTo' in first;
  const cel = 'linkTo' in first ? cels[first.linkTo] : first;
  if (cel === undefined || 'linkTo' in cel) {
    throw new OpError('REFUSED', `layer ${layer.name} has a broken cel link at frame ${frameId}`, {
      reason: 'broken-link',
    });
  }
  const image = ctx.view.image(cel.imageId);
  if (image === undefined) {
    throw new OpError('INTERNAL', `image ${cel.imageId} of layer ${layer.name} is missing`);
  }
  return { imageId: cel.imageId, image, offset: cel.offset, opacity: cel.opacity, linked };
}

/**
 * The pixel of a cel at canvas position `(x, y)` (straight RGBA; transparent outside the image).
 * An indexed image is resolved through the active palette.
 * @throws OpError `REFUSED` (`reason: 'no-palette'`) for an indexed cel without a palette.
 */
export function celPixelReader(
  doc: ReadonlyDocument,
  cel: CelContent | undefined,
): (x: number, y: number) => Rgba {
  if (cel === undefined) return () => [0, 0, 0, 0];
  const { image, offset } = cel;
  if (image instanceof TiledImage) return (x, y) => image.get(x - offset.x, y - offset.y);
  const palette = activePalette(doc);
  if (palette === undefined) {
    throw new OpError('REFUSED', 'the document is indexed but has no active palette', {
      reason: 'no-palette',
    });
  }
  return (x, y) => {
    const c = palette.colors[image.get(x - offset.x, y - offset.y)];
    return c === undefined ? [0, 0, 0, 0] : [c[0], c[1], c[2], c[3]];
  };
}

/** Palette index of an exact RGBA colour (the first match), or `undefined`. */
export function paletteIndexOf(palette: DeepReadonly<Palette>, c: Rgba): number | undefined {
  const i = palette.colors.findIndex(
    (p) => p[0] === c[0] && p[1] === c[1] && p[2] === c[2] && p[3] === c[3],
  );
  return i < 0 ? undefined : i;
}

/** The index meaning "empty" in an indexed image of this palette: the first alpha-0 entry. */
export function transparentIndexOf(palette: DeepReadonly<Palette>): number | undefined {
  const i = palette.colors.findIndex((p) => p[3] === 0);
  return i < 0 ? undefined : i;
}

/**
 * The pixel or reference layer named by `ref`.
 * @throws OpError `NOT_FOUND` / `AMBIGUOUS`; `REFUSED` (`part-layer`, `group-layer`) for a layer without cels.
 */
export function resolveCelLayer(doc: ReadonlyDocument, ref: string): CelLayer {
  const { layer } = resolveLayer(doc, ref);
  if (layer.kind !== 'pixel' && layer.kind !== 'reference') {
    throw new OpError(
      'REFUSED',
      layer.kind === 'part'
        ? `layer ${layer.name} is computed by the rig (part layer); omit "layer" to read or write the rendered frame`
        : `layer ${layer.name} is a group; name one of its pixel layers`,
      { reason: layer.kind === 'part' ? 'part-layer' : 'group-layer', layer: layer.id },
    );
  }
  return layer;
}
