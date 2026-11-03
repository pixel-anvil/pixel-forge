/** Shared synthetic scenes for the pipeline tests (recipe, variants). */
import type { RgbaImage } from '@pixel-forge/raster';
import type { RGBA8 } from '@pixel-forge/schema';
import { ART_COLORS, perturb, upscale } from './synth.js';

/** The six opaque colours of {@link ART_COLORS} as a palette. */
export const ART_PALETTE: RGBA8[] = ART_COLORS.filter((c) => c[3] === 255).map(
  (c) => [...c] as unknown as RGBA8,
);

/** Background colour of {@link fakePixelArt}. */
export const MAGENTA: [number, number, number] = [250, 0, 250];

/**
 * Pixel art as an AI tool might hand it over: transparent pixels of `src` painted {@link MAGENTA},
 * upscaled by 6 (phase 0), plus light noise (+-2 per channel).
 */
export function fakePixelArt(src: RgbaImage, seed: number): RgbaImage {
  const flat = src.data.slice();
  for (let p = 0; p < src.width * src.height; p++) {
    if (flat[p * 4 + 3] === 0) flat.set([...MAGENTA, 255], p * 4);
  }
  return perturb(upscale({ width: src.width, height: src.height, data: flat }, 6, 6), seed, 2);
}
