// `pnpm bench`: the NFR-01 numbers (spec 5). Report-only: it never fails the build. Timing is the one
// thing here that needs a wall clock, so it stays out of the pure packages. Run on an idle machine,
// after `pnpm build`; NFR-01's reference machine is an Apple M1.
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createRigRenderer, renderFrame } from '../packages/core/dist/index.js';
import {
  createDocumentFromSpritesheet,
  fixedClock,
  pxfStore,
  pxfView,
  readPxf,
  writePxf,
} from '../packages/io/dist/index.js';
import { encodePng } from '../packages/png/dist/index.js';
import { TiledImage, prepareRotSprite, rotateAbout } from '../packages/raster/dist/index.js';
import { overlapMasks } from '../packages/rig/dist/index.js';

const HERO = new URL('../fixtures/generated/hero.pxf', import.meta.url);
/** Quantised, never a quarter turn: those take a short path that would flatter the numbers. */
const ANGLES = Array.from({ length: 24 }, (_, i) => 7.25 + i * 15);

const stats = (samples) => {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, mean, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
};

const time = (fn) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

const rows = [];
const row = (name, s, target) => {
  const fmt = (v) => v.toFixed(3).padStart(10);
  const verdict =
    target === undefined ? '' : s.p95 < target ? `PASS < ${target} ms` : `MISS ${target} ms`;
  rows.push(
    `${name.padEnd(62)} ${String(s.n).padStart(5)} ${fmt(s.mean)} ${fmt(s.p50)} ${fmt(s.p95)} ${fmt(s.max)}  ${verdict}`,
  );
};

/** Deterministic small generator, so runs compare (the bench is not a pure package, but stays seeded). */
const lcg = (seed) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 16;

/** A dense `size`×`size` part of eight colours in runs, at (`x`, `y`) of a `canvas`-sized image. */
function part(size, canvas, x = 0, y = 0) {
  const rnd = lcg(size);
  const img = new TiledImage(canvas, canvas);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const c = ((i >> 2) + (j >> 2) + (rnd() % 8 === 0 ? 1 : 0)) % 8;
      img.set(x + i, y + j, [30 * c + 20, 200 - 20 * c, 40 + 25 * c, 255]);
    }
  }
  return img;
}

function coldRotSprite(name, img, pivot, target) {
  row(
    `${name}: prepare + rotate`,
    stats(
      ANGLES.map((deg) => time(() => rotateAbout(prepareRotSprite(img), pivot, deg, 'rotsprite'))),
    ),
    target,
  );
}

function rotSprite() {
  coldRotSprite('RotSprite cold, 32x32', part(32, 32), { x: 16, y: 16 }, 10);
  // IO-04: an imported variant is canvas-sized at (0,0), with the art somewhere inside it.
  coldRotSprite('RotSprite cold, 32x32 in a 256x256 canvas', part(32, 256, 112, 112), {
    x: 128,
    y: 128,
  });
  const prepared = prepareRotSprite(part(32, 32));
  row(
    'RotSprite, 32x32 already prepared',
    stats(
      ANGLES.map((deg) => time(() => rotateAbout(prepared, { x: 16, y: 16 }, deg, 'rotsprite'))),
    ),
  );
}

/** The hero's single frame is the rest pose, so pose every bone in 24 frames to make RotSprite run. */
function posedHero() {
  const file = readPxf(new Uint8Array(readFileSync(HERO)));
  const view = pxfView(file);
  const [base] = view.doc.animations;
  const frames = Array.from({ length: 24 }, (_, f) => ({
    ...base.frames[0],
    id: `${base.frames[0].id}${f}`,
    boneKeys: Object.fromEntries(
      view.doc.rig.bones.map((b, i) => [b.id, { angle: ((7 * f + 11 * i) % 40) - 20 }]),
    ),
  }));
  const animation = { ...base, frames };
  return { view: { ...view, doc: { ...view.doc, animations: [animation] } }, animation };
}

function rig() {
  const { view, animation } = posedHero();
  const { doc } = view;
  const ref = { id: animation.id };
  const frames = animation.frames.map((_, i) => i);
  const { w, h } = doc.meta.canvas;
  const label = `${w}x${h}, ${doc.rig.parts.length} parts, posed`;
  const shared = createRigRenderer();
  const firstPass = frames.map((i) => time(() => renderFrame(view, ref, i, { rig: shared })));
  const warm = [];
  for (let pass = 0; pass < 20; pass++) {
    for (const i of frames) warm.push(time(() => renderFrame(view, ref, i, { rig: shared })));
  }
  row(`Rig frame warm (${label})`, stats(warm), 2);
  row(`Rig frame, shared cache filling (${label})`, stats(firstPass));
  row(
    `Rig frame, empty cache (${label})`,
    stats(frames.map((i) => time(() => renderFrame(view, ref, i, { rig: createRigRenderer() })))),
  );
  const input = { rig: doc.rig, images: view, canvas: doc.meta.canvas };
  row(
    'overlapMasks, whole rig at the default sweep',
    stats(Array.from({ length: 5 }, () => time(() => overlapMasks(input)))),
  );
}

/** A `.pxf` of at least 5 MB: noise does not compress, so its size is real pixel data. */
function open5Mb() {
  const rnd = lcg(7);
  const cell = 256;
  const frames = 28;
  const data = new Uint8Array(cell * cell * frames * 4);
  for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : rnd() & 255;
  const png = encodePng({ kind: 'rgba', width: cell, height: cell * frames, data });
  const { store } = createDocumentFromSpritesheet(
    {
      png,
      cell: [cell, cell],
      animations: [{ group: 'noise', frames: Array.from({ length: frames }, (_, r) => [r, 0]) }],
    },
    { name: 'bench' },
  );
  const bytes = writePxf(store, { clock: fixedClock(new Date(0)), renderCache: true });
  const mb = (bytes.length / 1e6).toFixed(1);
  row(
    `Open a ${mb} MB .pxf (read + store)`,
    stats(Array.from({ length: 7 }, () => time(() => pxfStore(readPxf(bytes))))),
    500,
  );
}

const header = `${'scenario'.padEnd(62)} ${'n'.padStart(5)} ${'mean ms'.padStart(10)} ${'p50'.padStart(10)} ${'p95'.padStart(10)} ${'max'.padStart(10)}`;
rotSprite();
rig();
open5Mb();
console.log(`${cpus()[0]?.model ?? 'unknown cpu'}, node ${process.version}. Verdicts use p95.`);
console.log(header);
console.log(rows.join('\n'));
console.log(
  'Not measured here: Godot re-import (needs the editor, see G2) and draw feedback (M2).',
);
