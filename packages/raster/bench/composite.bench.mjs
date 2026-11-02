// Micro-benchmark: composite a 64x64 layer onto a 256x256 canvas. Not run in CI.
// Usage: pnpm exec tsc -b packages/raster && node packages/raster/bench/composite.bench.mjs
import { performance } from 'node:perf_hooks';
import { TiledImage, composite } from '../dist/index.js';

const SIZE = 256;
const LAYER = 64;
const RUNS = 200;
const WARMUP = 20;

function layer(seed, alphaFor) {
  const img = new TiledImage(LAYER, LAYER);
  for (let y = 0; y < LAYER; y++) {
    for (let x = 0; x < LAYER; x++) {
      const v = (x * 31 + y * 17 + seed) & 255;
      img.set(x, y, [v, 255 - v, (v * 3) & 255, alphaFor(x, y)]);
    }
  }
  return img;
}

const canvas = new TiledImage(SIZE, SIZE);
for (let y = 0; y < SIZE; y++)
  for (let x = 0; x < SIZE; x++) canvas.set(x, y, [x & 255, y & 255, 128, 255]);

const cases = {
  'opaque source': layer(1, () => 255),
  'partial alpha (128)': layer(2, () => 128),
  'mixed alpha': layer(3, (x, y) => ((x + y) & 3) * 85),
};

for (const [name, src] of Object.entries(cases)) {
  const run = () => {
    const dst = canvas.clone(); // O(tiles); the first write to each touched tile copies it
    composite(dst, src, { x: 96, y: 96, opacity: 200 });
    return dst;
  };
  for (let i = 0; i < WARMUP; i++) run();
  const t0 = performance.now();
  for (let i = 0; i < RUNS; i++) run();
  const ms = (performance.now() - t0) / RUNS;
  console.log(
    `${name.padEnd(22)} ${ms.toFixed(3)} ms per composite (64x64 onto 256x256, incl. clone)`,
  );
}
