import type { IndexedImage, Rgba, TiledImage } from '../image.js';

/** Any image the primitives can draw on. */
export type DrawableImage = TiledImage | IndexedImage;

/** The pixel value type of an image: `Rgba` for {@link TiledImage}, a palette index for {@link IndexedImage}. */
export type PixelOf<I extends DrawableImage> = I extends IndexedImage ? number : Rgba;

/** @internal Pixel writer; out-of-bounds coordinates are ignored by `set`. */
export function plotter(img: DrawableImage, colour: Rgba | number): (x: number, y: number) => void {
  const set = img.set.bind(img) as (x: number, y: number, c: Rgba | number) => boolean;
  return (x, y) => {
    set(x, y, colour);
  };
}

/** @internal Packs a pixel into one comparable number (RGBA as uint32, index as itself). */
export function pixelKey(p: Rgba | number): number {
  if (typeof p === 'number') return p;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/** @internal Largest per-channel absolute difference between two pixels of the same kind. */
export function pixelDistance(a: Rgba | number, b: Rgba | number): number {
  if (typeof a === 'number' || typeof b === 'number')
    return Math.abs((a as number) - (b as number));
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
    Math.abs(a[3] - b[3]),
  );
}
