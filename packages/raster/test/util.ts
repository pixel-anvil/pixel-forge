import { TiledImage } from '../src/index.js';
import type { Rgba } from '../src/index.js';

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random sparse RGBA image: about `density` of the pixels are set, with random (also partial) alpha. */
export function randomImage(w: number, h: number, seed: number, density = 0.3): TiledImage {
  const r = rng(seed);
  const img = new TiledImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (r() < density) {
        const px: Rgba = [
          Math.floor(r() * 256),
          Math.floor(r() * 256),
          Math.floor(r() * 256),
          1 + Math.floor(r() * 255),
        ];
        img.set(x, y, px);
      }
    }
  }
  return img;
}
