/**
 * `setColorMode` (FR-PAL-06, T5.2b): switches a document between RGBA and indexed pixels, converting
 * every stored drawing exactly, and sets the palette lock. One edit of the open transaction.
 * @packageDocumentation
 */
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import type { Rgba } from '@pixel-forge/raster';
import type { ColorMode, ImageId, Layer } from '@pixel-forge/schema';
import { CoreError } from './errors.js';
import type { DeepReadonly } from './json.js';
import type { Transaction } from './transaction.js';

/**
 * Why a colour-mode change was refused. `no-palette` and `bad-palette` are `BAD_ARGUMENT`;
 * `not-indexable` (a colour that is not an exact palette entry) and `index-out-of-range` are `BAD_VALUE`.
 */
export type ColorModeReason = 'no-palette' | 'bad-palette' | 'not-indexable' | 'index-out-of-range';

/** Options of {@link setColorMode}. */
export interface SetColorModeOptions {
  /** The new mode; missing: keep the current one. */
  readonly colorMode?: ColorMode;
  /** The new palette lock; missing: keep the current one. */
  readonly paletteLocked?: boolean;
}

/** Result of {@link setColorMode}. */
export interface SetColorModeResult {
  readonly colorMode: ColorMode;
  readonly paletteLocked: boolean;
  /** Drawings converted (cels, variants and override `set` images; erase masks never change). */
  readonly converted: number;
}

type LayerRo = DeepReadonly<Layer>;

const refuse = (reason: ColorModeReason, message: string): CoreError =>
  new CoreError('BAD_ARGUMENT', message, { reason });

function celImages(layers: readonly LayerRo[], out: Set<ImageId>): void {
  for (const l of layers) {
    if (l.kind === 'group') celImages(l.children, out);
    else if (l.kind === 'pixel' || l.kind === 'reference') {
      for (const c of Object.values(l.cels)) if ('imageId' in c) out.add(c.imageId);
    }
  }
}

/**
 * Sets the colour mode and/or the palette lock.
 *
 * - **To indexed**: needs an active palette with a transparent entry (alpha 0; the first one is the
 *   transparent index). Every drawing becomes an `IndexedImage` by **exact** match of RGBA to palette
 *   entries (alpha-0 pixels become the transparent index); a colour the palette lacks refuses the whole
 *   change (`not-indexable`, with the colour and image), so the render never changes.
 * - **To RGBA**: every indexed drawing is resolved through the active palette.
 * - **Palette lock**: needs an active palette (`no-palette`). Locking does not recolour anything; the
 *   lint rule `palette.offPalette` judges the render.
 *
 * Converted drawings are new images; the old ones are deleted. Changing nothing is a no-op.
 *
 * @throws CoreError `BAD_ARGUMENT` / `BAD_VALUE` with `details.reason` a {@link ColorModeReason}.
 */
export function setColorMode(tx: Transaction, opts: SetColorModeOptions = {}): SetColorModeResult {
  const doc = tx.doc;
  const from = doc.meta.colorMode;
  const to = opts.colorMode ?? from;
  const locked = opts.paletteLocked ?? doc.meta.paletteLocked;
  const palette = doc.palettes.find((p) => p.id === doc.activePaletteId)?.colors;
  if ((to === 'indexed' || locked) && palette === undefined) {
    throw refuse('no-palette', 'the document has no active palette');
  }
  const converted = new Map<ImageId, TiledImage | IndexedImage>();
  if (to !== from) {
    const ids = new Set<ImageId>();
    celImages(doc.layers, ids);
    for (const p of doc.rig?.parts ?? []) for (const v of p.variants) ids.add(v.imageId);
    for (const a of doc.animations) for (const o of a.overrides) if (o.set) ids.add(o.set);
    const colors: Rgba[] = (palette ?? []).map((c) => [c[0], c[1], c[2], c[3]]);
    const transparent = colors.findIndex((c) => c[3] === 0);
    if (to === 'indexed' && transparent < 0) {
      throw refuse('bad-palette', 'the active palette has no transparent (alpha 0) entry');
    }
    const lut = new Map<number, number>();
    colors.forEach((c, i) => {
      const key = ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) >>> 0;
      if (c[3] !== 0 && !lut.has(key)) lut.set(key, i);
    });
    for (const id of [...ids].sort()) {
      const img = tx.image(id);
      if (img === undefined) throw new CoreError('IMAGE_MISSING', `image ${id} is not stored`);
      if (to === 'indexed' && img instanceof TiledImage) {
        const { data, width, height } = img.toRGBA();
        const out = new Uint8Array(width * height).fill(transparent);
        for (let p = 0; p < out.length; p++) {
          const o = p * 4;
          const a = data[o + 3] ?? 0;
          if (a === 0) continue;
          const key =
            (((data[o] ?? 0) << 24) |
              ((data[o + 1] ?? 0) << 16) |
              ((data[o + 2] ?? 0) << 8) |
              a) >>>
            0;
          const i = lut.get(key);
          if (i === undefined) {
            throw new CoreError(
              'BAD_VALUE',
              `image ${id} has a colour that is not a palette entry`,
              {
                reason: 'not-indexable' satisfies ColorModeReason,
                imageId: id,
                x: p % width,
                y: Math.floor(p / width),
              },
            );
          }
          out[p] = i;
        }
        converted.set(id, IndexedImage.fromIndices(width, height, out, transparent));
      } else if (to === 'rgba' && img instanceof IndexedImage) {
        const bad = img.toIndices().some((ix) => ix >= colors.length);
        if (bad || img.transparentIndex >= colors.length) {
          throw new CoreError('BAD_VALUE', `image ${id} uses an index the palette lacks`, {
            reason: 'index-out-of-range' satisfies ColorModeReason,
            imageId: id,
          });
        }
        converted.set(id, TiledImage.fromRGBA(img.toRGBA(colors)));
      }
    }
  }
  const fresh = new Map<ImageId, ImageId>();
  for (const [id, img] of converted) fresh.set(id, tx.createImage(img));
  if (to !== from || locked !== doc.meta.paletteLocked) {
    tx.update((d) => {
      d.meta.colorMode = to;
      d.meta.paletteLocked = locked;
      const swap = (id: ImageId): ImageId => fresh.get(id) ?? id;
      const visit = (layers: Layer[]): void => {
        for (const l of layers) {
          if (l.kind === 'group') visit(l.children);
          else if (l.kind === 'pixel' || l.kind === 'reference') {
            for (const c of Object.values(l.cels)) if ('imageId' in c) c.imageId = swap(c.imageId);
          }
        }
      };
      visit(d.layers);
      for (const p of d.rig?.parts ?? []) for (const v of p.variants) v.imageId = swap(v.imageId);
      for (const a of d.animations) {
        for (const o of a.overrides) if (o.set !== undefined) o.set = swap(o.set);
      }
    });
  }
  for (const id of converted.keys()) tx.deleteImage(id);
  return { colorMode: to, paletteLocked: locked, converted: converted.size };
}
