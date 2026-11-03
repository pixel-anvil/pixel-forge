/**
 * Synthetic oracles for grid detection and downscale tests. Everything here is independent of the
 * code under test: a seeded xorshift, a hand-written integer upscale and crop.
 */
import type { RgbaImage } from '@pixel-forge/raster';

/** 32-bit xorshift (Marsaglia 2003, 13-17-5). Returns 0..2^32-1. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

/** Six opaque colours and transparent. */
export const ART_COLORS: readonly (readonly [number, number, number, number])[] = [
  [20, 20, 30, 255],
  [200, 40, 40, 255],
  [40, 160, 60, 255],
  [240, 220, 120, 255],
  [60, 80, 200, 255],
  [250, 250, 250, 255],
  [0, 0, 0, 0],
];

/** Random pixel art: every pixel one of {@link ART_COLORS}. */
export function randomArt(w: number, h: number, seed: number): RgbaImage {
  const next = rng(seed);
  const data = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++)
    data.set(ART_COLORS[next() % ART_COLORS.length] ?? [0, 0, 0, 0], p * 4);
  return { width: w, height: h, data };
}

/** Nearest-neighbour upscale by `cw x ch`. */
export function upscale(img: RgbaImage, cw: number, ch: number): RgbaImage {
  const W = img.width * cw;
  const H = img.height * ch;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = (Math.floor(y / ch) * img.width + Math.floor(x / cw)) * 4;
      data.set(img.data.subarray(s, s + 4), (y * W + x) * 4);
    }
  }
  return { width: W, height: H, data };
}

/** Copy of the rectangle `x, y, w, h`. */
export function cut(img: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) {
    const from = ((y + r) * img.width + x) * 4;
    data.set(img.data.subarray(from, from + w * 4), r * w * 4);
  }
  return { width: w, height: h, data };
}

/**
 * Upscales `src` by `cw x ch` and crops so that cells start at `ox, oy` (the phase), and so that
 * `right`/`bottom` pixels of the last cells are cut off. Every source pixel keeps at least one pixel.
 */
export function upscaleWithPhase(
  src: RgbaImage,
  cw: number,
  ch: number,
  ox: number,
  oy: number,
  right = 0,
  bottom = 0,
): RgbaImage {
  const up = upscale(src, cw, ch);
  const lx = (cw - ox) % cw;
  const ly = (ch - oy) % ch;
  return cut(up, lx, ly, up.width - lx - right, up.height - ly - bottom);
}

/**
 * Adds a deterministic perturbation to every opaque pixel: uniform noise of +-`amp` per RGB channel,
 * and with `soften` the last pixel of each cell blends a quarter of the next cell (JPEG-like ringing
 * and blur at cell boundaries). Cell geometry is that of {@link upscaleWithPhase}.
 */
export function perturb(
  img: RgbaImage,
  seed: number,
  amp: number,
  soften?: { cw: number; ch: number; ox: number; oy: number },
): RgbaImage {
  const next = rng(seed);
  const { width: w, height: h } = img;
  const src = img.data;
  const data = src.slice();
  if (soften) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x + 1 < w; x++) {
        if ((x + 1 - soften.ox) % soften.cw !== 0) continue;
        const a = (y * w + x) * 4;
        const b = a + 4;
        if (src[a + 3] !== 255 || src[b + 3] !== 255) continue;
        for (let c = 0; c < 3; c++)
          data[a + c] = Math.round(((src[a + c] ?? 0) * 3 + (src[b + c] ?? 0)) / 4);
      }
    }
  }
  for (let p = 0; p < w * h; p++) {
    if (data[p * 4 + 3] !== 255) continue;
    for (let c = 0; c < 3; c++) {
      const v = (data[p * 4 + c] ?? 0) + (next() % (2 * amp + 1)) - amp;
      data[p * 4 + c] = Math.max(0, Math.min(255, v));
    }
  }
  return { width: w, height: h, data };
}

/** Largest absolute channel difference between two same-size images. */
export function maxDiff(a: RgbaImage, b: RgbaImage): number {
  let m = 0;
  for (let i = 0; i < a.data.length; i++)
    m = Math.max(m, Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)));
  return m;
}
