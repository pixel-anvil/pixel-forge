// Micro-benchmark for RotSprite (NFR-01: < 10 ms per cold 32x32 rotation, < 2 ms for a warm 16-part
// rig render). Not run in CI. Uses the synthetic 32x32 TORSO subject from the tests.
// Usage: pnpm exec tsc -b packages/raster && node packages/raster/bench/rotsprite.bench.mjs
// (Node strips the types of the imported fixtures file.)
import { performance } from 'node:perf_hooks';
import { TiledImage, crop, prepareRotSprite, rotateAbout } from '../dist/index.js';
import { LEGEND, TORSO } from '../test/rotsprite-fixtures.ts';

const RUNS = 200;
const WARMUP = 50;

function fromAscii(ascii) {
  const rows = ascii.trim().split('\n');
  const img = new TiledImage(rows[0].length, rows.length);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== '.') img.set(x, y, LEGEND[ch]);
    });
  });
  return img;
}

function median(fn) {
  for (let i = 0; i < WARMUP; i++) fn(i);
  const t = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    fn(i);
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return t[Math.floor(t.length / 2)];
}

const torso = fromAscii(TORSO.ascii);
const pivot = TORSO.pivot;
const angle = (i) => 30 + (i % 8) * 0.25; // avoid any accidental result caching

// First call in a fresh process: JIT-cold and cache-cold.
let t0 = performance.now();
rotateAbout(torso, pivot, 30);
const firstCall = performance.now() - t0;

const cold = median((i) => rotateAbout(torso, pivot, angle(i))); // includes the snapshot + Scale2x x3
const prep = prepareRotSprite(torso);
const scale8 = median(() => prepareRotSprite(torso));
const warm = median((i) => rotateAbout(prep, pivot, angle(i)));
const nearest = median((i) => rotateAbout(prep, pivot, angle(i), 'nearest'));

// 16 parts of 16x16 (crops of the torso), each about its centre, at 16 different angles.
const parts = Array.from({ length: 16 }, (_, i) =>
  crop(torso, { x: 2 + (i % 4) * 4, y: 1 + Math.floor(i / 4) * 5, w: 16, h: 16 }),
);
const partPreps = parts.map((p) => prepareRotSprite(p));
const centre = { x: 8, y: 8 };
const rig16Warm = median((i) => {
  for (let k = 0; k < 16; k++) rotateAbout(partPreps[k], centre, (k * 22.5 + i * 0.25) % 360);
});
const rig16Cold = median((i) => {
  for (let k = 0; k < 16; k++) rotateAbout(parts[k], centre, (k * 22.5 + i * 0.25) % 360);
});

const rows = [
  ['first call in process (JIT-cold, 32x32)', firstCall, '< 10 ms'],
  ['cold 32x32 (snapshot + Scale2x x3 + rotate)', cold, '< 10 ms'],
  ['prepareRotSprite 32x32 (Scale2x x3 only)', scale8, ''],
  ['warm 32x32 (cached x8)', warm, ''],
  ['nearest 32x32', nearest, ''],
  ['16 parts of 16x16, warm', rig16Warm, '< 2 ms (whole rig render)'],
  ['16 parts of 16x16, cold', rig16Cold, ''],
];
console.log(`RotSprite bench (median of ${String(RUNS)} after ${String(WARMUP)} warm-up runs)`);
for (const [name, ms, target] of rows) {
  console.log(`${name.padEnd(46)} ${ms.toFixed(3).padStart(8)} ms  ${target}`);
}
console.log(`x8 cache for the 32x32 part: ${String(Math.round(prep.byteSize / 1024))} KiB`);
