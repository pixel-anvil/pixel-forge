// `pnpm convert:sheet`: writes a variant sheet of the image-to-sprite pipeline (E4.4) for a person to
// look at. Goldens made by the code under test need a reviewed sheet (AGENTS.md, "Oracles and goldens").
// Output (never committed): ~/pf-work/sheets-e44/variant-sheet.png (the library sheet, scaled) and
// variant-sheet-labelled.png (one labelled tile per variant), plus source.png.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runVariants, variantSheet } from '../packages/convert/dist/index.js';
import { encodePng } from '../packages/png/dist/index.js';
import { TiledImage, scaleInt } from '../packages/raster/dist/index.js';
import { goldenSheet } from '../packages/testkit/dist/index.js';

const OUT = join(homedir(), 'pf-work', 'sheets-e44');
mkdirSync(OUT, { recursive: true });

/** A shaded disc on a magenta background, 24x24: smooth colours, like a render downscaled by a model. */
function disc(size) {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r > size * 0.4) {
        data.set([250, 0, 250, 255], (y * size + x) * 4);
        continue;
      }
      const light = Math.max(
        0,
        1 - Math.sqrt((dx + 4) * (dx + 4) + (dy + 5) * (dy + 5)) / (size * 0.55),
      );
      const base = r > size * 0.34 ? 0.55 : 1;
      data.set(
        [
          Math.round((60 + 190 * light) * base),
          Math.round((40 + 120 * light) * base),
          Math.round((90 + 60 * light) * base),
          255,
        ],
        (y * size + x) * 4,
      );
    }
  }
  return { width: size, height: size, data };
}

/** Nearest-neighbour upscale plus a small deterministic wobble (xorshift), so cells are not flat. */
function fake(src, k, amp) {
  const W = src.width * k;
  const data = new Uint8Array(W * W * 4);
  let s = 123456789;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const from = (Math.floor(y / k) * src.width + Math.floor(x / k)) * 4;
      const o = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const v = (src.data[from + ch] ?? 0) + (next() % (2 * amp + 1)) - amp;
        data[o + ch] = Math.max(0, Math.min(255, v));
      }
      data[o + 3] = 255;
    }
  }
  return { width: W, height: W, data };
}

const scaleUp = (img, k) => scaleInt(TiledImage.fromRGBA(img), k).toRGBA();
const png = (img) => encodePng({ ...img, kind: 'rgba' });

const source = fake(disc(24), 8, 2);
const recipe = {
  version: 1,
  background: { mode: 'flood', color: [250, 0, 250], tolerance: 40 },
  downscale: { method: 'mode', grid: 'auto' },
  cleanup: { outline: { color: 'darken', shade: 35 } },
  quantize: { dither: 'none' },
};
const warm = {
  name: 'warm',
  colors: [
    [30, 16, 40, 255],
    [90, 40, 90, 255],
    [150, 70, 100, 255],
    [220, 120, 110, 255],
    [250, 190, 140, 255],
  ],
};
const mono = {
  name: 'mono',
  colors: [
    [10, 10, 20, 255],
    [90, 90, 110, 255],
    [180, 180, 200, 255],
    [250, 250, 255, 255],
  ],
};
const results = runVariants(source, recipe, {
  method: ['box', 'mode', 'kcentroid', 'nearest'],
  palette: [warm, mono],
  dither: ['none', 'bayer4', 'floyd-steinberg'],
});

const sheet = variantSheet(results, { columns: 6, gap: 1, background: [40, 40, 48, 255] });
writeFileSync(join(OUT, 'source.png'), png(source));
writeFileSync(join(OUT, 'variant-sheet.png'), png(scaleUp(sheet.image, 5)));
const labelled = goldenSheet(
  results.map((r) => ({ label: Object.values(r.params).join(' ').toUpperCase(), img: r.image })),
  { scale: 6, columns: 6 },
);
writeFileSync(join(OUT, 'variant-sheet-labelled.png'), png(labelled));
console.log(`wrote ${String(results.length)} variants to ${OUT}`);
console.log(
  `grid: ${JSON.stringify(results[0]?.report.grid)}, sheet ${String(sheet.image.width)}x${String(sheet.image.height)}`,
);
