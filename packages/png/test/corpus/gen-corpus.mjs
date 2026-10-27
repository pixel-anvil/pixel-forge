// Writes the synthetic part of the PNG test corpus into the directory given as argv[2].
// Run through make-corpus.sh. Uses pngjs (the independent oracle) for the plain colour types and a
// tiny hand-rolled chunk writer (node:zlib, not our codec) for what pngjs cannot write: palette
// images, 1/2/4-bit samples, tRNS colour keys, multiple IDAT chunks and every filter type.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const outDir = process.argv[2];
if (!outDir) throw new Error('usage: gen-corpus.mjs <outDir>');

const W = 13;
const H = 7;

/** Deterministic RGBA test pattern with varied alpha (no randomness). */
function pattern() {
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      rgba[i] = (x * 20 + y * 3) & 255;
      rgba[i + 1] = (y * 37 + x * 5) & 255;
      rgba[i + 2] = ((x ^ y) * 29) & 255;
      rgba[i + 3] = (x + y) % 5 === 0 ? 0 : (x + y) % 3 === 0 ? 128 : 255;
    }
  }
  return rgba;
}

function writePngjs(name, colorType, rgba) {
  const png = new PNG({ width: W, height: H });
  png.data = Buffer.from(rgba);
  writeFileSync(
    join(outDir, name),
    PNG.sync.write(png, { colorType, inputColorType: 6, inputHasAlpha: true }),
  );
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), 8 + data.length);
  return out;
}
function ihdr(width, height, depth, colorType) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b[8] = depth;
  b[9] = colorType;
  return chunk('IHDR', b);
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Applies filter `type` to one scanline (written independently of src/). */
function filterRow(type, cur, prev, bpp) {
  const out = Buffer.alloc(cur.length + 1);
  out[0] = type;
  for (let i = 0; i < cur.length; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    let pred = 0;
    if (type === 1) pred = a;
    else if (type === 2) pred = b;
    else if (type === 3) pred = (a + b) >> 1;
    else if (type === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[i + 1] = (cur[i] - pred) & 255;
  }
  return out;
}

/** Packs sample rows (arrays of ints) at `depth` bits, MSB first, rows padded to bytes. */
function packRows(rows, depth) {
  return rows.map((row) => {
    const bytes = Buffer.alloc(Math.ceil((row.length * depth) / 8));
    row.forEach((s, x) => {
      const bit = x * depth;
      bytes[bit >> 3] |= s << (8 - depth - (bit & 7));
    });
    return bytes;
  });
}

/** Builds a PNG from packed rows. `filterOf(y)` picks the filter type; `idatSplit` > 0 splits IDAT. */
function build({
  width,
  height,
  depth,
  colorType,
  rows,
  extra = [],
  filterOf = () => 0,
  idatSplit = 0,
}) {
  const bpp = Math.max(1, (depth * { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]) >> 3);
  const filtered = Buffer.concat(
    rows.map((r, y) => filterRow(filterOf(y), r, y ? rows[y - 1] : null, bpp)),
  );
  const z = deflateSync(filtered, { level: 9 });
  const idats = [];
  if (idatSplit > 0) {
    for (let o = 0; o < z.length; o += idatSplit)
      idats.push(chunk('IDAT', z.subarray(o, o + idatSplit)));
  } else idats.push(chunk('IDAT', z));
  return Buffer.concat([
    SIG,
    ihdr(width, height, depth, colorType),
    ...extra,
    ...idats,
    chunk('IEND', []),
  ]);
}

const rgba = pattern();

// pngjs-written: truecolour+alpha, truecolour, greyscale, grey+alpha.
writePngjs('pngjs-rgba.png', 6, rgba);
writePngjs('pngjs-rgb.png', 2, rgba);
writePngjs('pngjs-gray.png', 0, rgba);
writePngjs('pngjs-grayalpha.png', 4, rgba);

// Hand-built palette image, 8-bit, with PLTE and a partial tRNS (first 4 entries have alpha).
const palette = Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i * 16, (i * 53) & 255]);
const plte = chunk('PLTE', palette.flat());
const trns = chunk('tRNS', [0, 64, 128, 200]);
const idxRows = (n) =>
  Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (x + y * 3) % n));
writeFileSync(
  join(outDir, 'handmade-palette8.png'),
  build({
    width: W,
    height: H,
    depth: 8,
    colorType: 3,
    rows: packRows(idxRows(16), 8),
    extra: [plte, trns],
  }),
);
writeFileSync(
  join(outDir, 'handmade-palette4.png'),
  build({
    width: W,
    height: H,
    depth: 4,
    colorType: 3,
    rows: packRows(idxRows(16), 4),
    extra: [plte, trns],
    filterOf: (y) => y % 5,
  }),
);
writeFileSync(
  join(outDir, 'handmade-palette2.png'),
  build({
    width: W,
    height: H,
    depth: 2,
    colorType: 3,
    rows: packRows(idxRows(4), 2),
    extra: [chunk('PLTE', palette.slice(0, 4).flat())],
  }),
);
writeFileSync(
  join(outDir, 'handmade-gray1.png'),
  build({ width: W, height: H, depth: 1, colorType: 0, rows: packRows(idxRows(2), 1) }),
);
writeFileSync(
  join(outDir, 'handmade-gray4-trns.png'),
  build({
    width: W,
    height: H,
    depth: 4,
    colorType: 0,
    rows: packRows(idxRows(16), 4),
    extra: [chunk('tRNS', [0, 3])],
  }),
);

// Truecolour with a tRNS colour key.
const rgbRows = Array.from({ length: H }, (_, y) =>
  Buffer.from(
    Array.from({ length: W }, (_, x) =>
      (x + y) % 4 === 0 ? [10, 20, 30] : [x * 19, y * 31, 200],
    ).flat(),
  ),
);
writeFileSync(
  join(outDir, 'handmade-rgb-trns.png'),
  build({
    width: W,
    height: H,
    depth: 8,
    colorType: 2,
    rows: rgbRows,
    extra: [chunk('tRNS', [0, 10, 0, 20, 0, 30])],
  }),
);

// RGBA using every filter type (cycling by row) and split over several IDAT chunks.
const rgbaRows = Array.from({ length: H }, (_, y) =>
  Buffer.from(rgba.subarray(y * W * 4, (y + 1) * W * 4)),
);
writeFileSync(
  join(outDir, 'handmade-rgba-allfilters-multiidat.png'),
  build({
    width: W,
    height: H,
    depth: 8,
    colorType: 6,
    rows: rgbaRows,
    filterOf: (y) => y % 5,
    idatSplit: 40,
  }),
);
