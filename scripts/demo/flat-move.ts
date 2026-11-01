// Flat-move demo (card D1): builds a `.pxf` from cells of a licensed sprite sheet, with no rig.
//
//   node scripts/demo/flat-move.ts --config <cfg.json> --out <file.pxf> [--sheet <contact.png>]
//
// The sheet, the game's animation table and the config are LOCAL and PRIVATE: the art's licence forbids
// redistribution, so nothing derived from it may be committed, and the config (which names the files,
// animations, rows and cells) lives outside tracked files. Outputs go to git-ignored paths only.
//
// Config (JSON; colours are "rrggbbaa" hex; paths absolute or relative to the config file):
//   sheet            sheet PNG
//   cell             [w, h]
//   table            optional animation table JSON: { pixels_per_metre?, animations: { <key>: { fps, holds?,
//                    rise?: number[], ball?: [x, y][], art_ball?: boolean[] } } }
//   name             document name
//   pixelsPerUnit    pixels per metre (default: table.pixels_per_metre, else 16)
//   dropColors       colours erased everywhere (e.g. a drawn floor shadow)
//   prop             { core, colours }: the prop's core colour and every colour it is drawn in
//   feet             { row, col } reference cell: its bottom opaque row (alpha > 0.1) is the feet row
//   feetRow          alternatively the feet row directly (the bottom opaque row is feetRow - 1 + 1)
//   groundRow        optional cross-check only: reported next to the measured value
//   markerName       prop marker name (default "ball")
//   flagEvent        event name set on frames whose art draws the prop (table art_ball), e.g. "prop_drawn"
//   animations[]     { group, direction?, key (table key), row, cells: number[], eraseProp?: boolean,
//                      events?: { "<frameIndex>": [names] } }
//   reference        optional { dir }: <dir>/<key>.png strips (cell-wide columns), only for the contact sheet
//
// Contract (docs/contracts/GODOT_INTEGRATION.md): origin = bottom-centre of the origin pixel, so
// origin.y = feet row - 1; the per-frame rise is baked into the cel offset (0, -rise) and into the
// marker (x, y - rise); durations are round(1000 * hold / fps); trim stays on the game side.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { decodePng, encodePng } from '../../packages/png/dist/index.js';
import { createDocumentFromSpritesheet, buildPxf, readPxf } from '../../packages/io/dist/index.js';
import { systemClock } from '../../packages/io/dist/node.js';

interface AnimConfig {
  group: string;
  direction?: string;
  key: string;
  row: number;
  cells: number[];
  eraseProp?: boolean;
  events?: Record<string, string[]>;
}
interface Config {
  sheet: string;
  cell: [number, number];
  table?: string;
  name?: string;
  pixelsPerUnit?: number;
  dropColors?: string[];
  prop?: { core: string; colours: string[] };
  feet?: { row: number; col: number };
  feetRow?: number;
  groundRow?: number;
  markerName?: string;
  flagEvent?: string;
  animations: AnimConfig[];
  reference?: { dir: string };
}
interface TableEntry {
  fps: number;
  holds?: number[];
  rise?: number[];
  ball?: [number, number][];
  art_ball?: boolean[];
}
interface Table {
  pixels_per_metre?: number;
  animations: Record<string, TableEntry>;
}
interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

function fail(msg: string): never {
  console.error(`flat-move: ${msg}`);
  process.exit(1);
}

const hex = (r: number, g: number, b: number, a: number): string =>
  [r, g, b, a].map((v) => v.toString(16).padStart(2, '0')).join('');

/** Pixels of one cell, copied. */
function cellOf(img: Rgba, cw: number, ch: number, row: number, col: number): Uint8Array {
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const from = ((row * ch + y) * img.width + col * cw) * 4;
    out.set(img.data.subarray(from, from + cw * 4), y * cw * 4);
  }
  return out;
}

function putCell(img: Rgba, cw: number, ch: number, row: number, col: number, px: Uint8Array) {
  for (let y = 0; y < ch; y++) {
    const to = ((row * ch + y) * img.width + col * cw) * 4;
    img.data.set(px.subarray(y * cw * 4, (y + 1) * cw * 4), to);
  }
}

function dropColours(px: Uint8Array, colours: ReadonlySet<string>): void {
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    if (colours.has(hex(px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0, px[i + 3] ?? 0))) {
      px.fill(0, i, i + 4);
    }
  }
}

/** Erases every prop-coloured pixel 4-connected to a core-coloured one. */
function eraseProp(px: Uint8Array, w: number, h: number, core: string, colours: string[]): void {
  const all = new Set(colours);
  const at = (x: number, y: number): string => {
    const i = (y * w + x) * 4;
    return hex(px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0, px[i + 3] ?? 0);
  };
  const stack: [number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (at(x, y) === core) stack.push([x, y]);
  const seen = new Set<number>();
  while (stack.length > 0) {
    const [x, y] = stack.pop() as [number, number];
    if (x < 0 || y < 0 || x >= w || y >= h || seen.has(y * w + x)) continue;
    seen.add(y * w + x);
    if (!all.has(at(x, y))) continue;
    px.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 4);
    stack.push([x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]);
  }
}

/** The cell shifted down by `dy` rows (negative: up), clipped to the cell. */
function shiftDown(px: Uint8Array, w: number, h: number, dy: number): Uint8Array {
  const out = new Uint8Array(px.length);
  for (let y = 0; y < h; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= h) continue;
    out.set(px.subarray(y * w * 4, (y + 1) * w * 4), ty * w * 4);
  }
  return out;
}

function bottomOpaqueRow(px: Uint8Array, w: number, h: number): number {
  let bottom = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if ((px[(y * w + x) * 4 + 3] ?? 0) / 255 > 0.1) bottom = y;
  return bottom;
}

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    out: { type: 'string' },
    sheet: { type: 'string' },
  },
});
if (!values.config || !values.out) {
  fail('usage: flat-move.ts --config <cfg.json> --out <file.pxf> [--sheet <contact.png>]');
}
const cfgPath = resolve(values.config);
const rel = (p: string): string => (isAbsolute(p) ? p : resolve(dirname(cfgPath), p));
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Config;
const table = cfg.table
  ? (JSON.parse(readFileSync(rel(cfg.table), 'utf8')) as Table)
  : ({ animations: {} } as Table);
const [cw, ch] = cfg.cell;

const sheet = decodePng(new Uint8Array(readFileSync(rel(cfg.sheet))));
const pristine = { ...sheet, data: sheet.data.slice() }; // the raw cells, for the contact sheet
const drop = new Set(cfg.dropColors ?? []);

// Feet row, measured on a reference cell with the dropped colours gone.
let feetBottom: number;
if (cfg.feet) {
  const ref = cellOf(sheet, cw, ch, cfg.feet.row, cfg.feet.col);
  dropColours(ref, drop);
  feetBottom = bottomOpaqueRow(ref, cw, ch);
  if (feetBottom < 0) fail('feet reference cell is empty');
} else if (cfg.feetRow !== undefined) {
  feetBottom = cfg.feetRow - 1;
} else {
  fail('config needs "feet" or "feetRow"');
}
const origin = { x: Math.floor(cw / 2), y: feetBottom }; // feet row (baseline) = feetBottom + 1
console.log(
  `feet: bottom opaque row ${feetBottom}, baseline ${feetBottom + 1}, origin (${origin.x}, ${origin.y})` +
    (cfg.groundRow !== undefined ? `; config groundRow ${cfg.groundRow}` : ''),
);

// Per-frame plan and cleaned cells (drop colours, erase the prop where asked).
interface FramePlan {
  anim: AnimConfig;
  index: number;
  rise: number;
  cleaned: Uint8Array;
  ms: number;
  ball?: [number, number];
  artBall: boolean;
}
const plans: FramePlan[] = [];
for (const a of cfg.animations) {
  const entry = table.animations[a.key];
  if (!entry) fail(`table has no entry "${a.key}"`);
  a.cells.forEach((col, index) => {
    const px = cellOf(sheet, cw, ch, a.row, col);
    dropColours(px, drop);
    if (a.eraseProp) {
      if (!cfg.prop) fail('eraseProp needs "prop"');
      eraseProp(px, cw, ch, cfg.prop.core, cfg.prop.colours);
    }
    putCell(sheet, cw, ch, a.row, col, px);
    const hold = entry.holds?.[index] ?? 1;
    plans.push({
      anim: a,
      index,
      rise: entry.rise?.[index] ?? 0,
      cleaned: px,
      ms: Math.max(1, Math.round((1000 * hold) / entry.fps)),
      ball: entry.ball?.[index],
      artBall: entry.art_ball?.[index] ?? false,
    });
  });
}

const markerName = cfg.markerName ?? 'ball';
const { store } = createDocumentFromSpritesheet(
  {
    png: encodePng({ width: sheet.width, height: sheet.height, data: sheet.data, kind: 'rgba' }),
    cell: [cw, ch],
    animations: cfg.animations.map((a) => ({
      group: a.group,
      ...(a.direction ? { direction: a.direction } : {}),
      frames: a.cells.map((c) => [a.row, c] as [number, number]),
      loop: 'once' as const,
    })),
  },
  {
    name: cfg.name ?? 'flat-move',
    pixelsPerUnit: cfg.pixelsPerUnit ?? table.pixels_per_metre ?? 16,
    origin,
  },
);

// Origin, rise baked into the cel offsets, durations, markers, events.
store.transact('flat move', (tx) => {
  tx.update((d) => {
    const layer = d.layers.find((l) => l.kind === 'pixel' && l.name === 'body');
    if (!layer || layer.kind !== 'pixel') fail('no body layer');
    const usedEvents = new Set<string>();
    let n = 0;
    for (const a of cfg.animations) {
      const anim = d.animations.find(
        (x) => x.group === a.group && x.direction === (a.direction ?? undefined),
      );
      if (!anim || !('frames' in anim)) fail(`animation ${a.group} missing`);
      anim.frames.forEach((f, i) => {
        const p = plans[n++] as FramePlan;
        f.durationMs = p.ms;
        const cel = layer.cels[f.id];
        if (cel && 'imageId' in cel) cel.offset = { x: 0, y: -p.rise };
        if (p.ball) f.markers[markerName] = { x: p.ball[0], y: p.ball[1] - p.rise };
        const ev = [...(a.events?.[String(i)] ?? [])];
        if (cfg.flagEvent && p.artBall) ev.unshift(cfg.flagEvent);
        for (const e of ev) usedEvents.add(e);
        f.events = ev;
      });
    }
    d.markerDefs = [{ name: markerName }];
    d.eventDefs = [...usedEvents].sort().map((name) => ({ name }));
  });
});

const built = buildPxf(store, { clock: systemClock, app: 'pixel-forge flat-move' });
const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, built.bytes);
console.log(`wrote ${out}: ${built.renderedFrames} frames rendered, ${built.bytes.length} bytes`);

// Round trip: each frame's cached render must equal the cleaned cell shifted by the baked rise.
const file = readPxf(new Uint8Array(readFileSync(out)));
if (!file.renderIndex) fail('no render cache in the written file');
const rendered: Uint8Array[] = [];
let mismatches = 0;
let n = 0;
for (const a of cfg.animations) {
  const dir = a.direction ?? 'default';
  const ra = file.renderIndex.animations[a.group]?.[dir];
  if (!ra || !('frames' in ra)) fail(`render index lacks ${a.group}/${dir}`);
  ra.frames.forEach((f, i) => {
    const p = plans[n++] as FramePlan;
    const png = file.renderPngs.get(`base/${f.image}`);
    if (!png) fail(`missing render PNG ${f.image}`);
    const got = decodePng(png);
    const want = shiftDown(p.cleaned, cw, ch, -p.rise);
    rendered.push(got.data);
    const same =
      got.width === cw &&
      got.height === ch &&
      got.data.every((v, k) => v === want[k] || (want[k - (k % 4) + 3] === 0 && k % 4 !== 3));
    if (!same || f.durationMs !== p.ms) {
      mismatches++;
      console.error(`MISMATCH ${a.group}/${dir} #${i}`);
    }
  });
}
console.log(
  mismatches === 0
    ? `round trip OK: ${rendered.length} frames equal the (rise-shifted) source cells`
    : `round trip FAILED: ${mismatches} frames`,
);
if (mismatches > 0) process.exit(1);

// Contact sheet: per frame, stacked at 8x on a checkerboard: raw source cell, the reference strip frame
// shifted by the rise (when configured), and the cached render. The feet line is drawn in magenta.
if (values.sheet) {
  const S = 8;
  const rows = cfg.reference ? 3 : 2;
  const gut = 4;
  const tileW = cw * S + gut;
  const tileH = ch * S + gut;
  const perRow = 6;
  const gridCols = Math.min(perRow, plans.length);
  const gridRows = Math.ceil(plans.length / perRow);
  const W = gridCols * tileW + gut;
  const H = gridRows * rows * tileH + gut;
  const canvas = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = (Math.floor(x / S) + Math.floor(y / S)) % 2 === 0 ? 70 : 90;
      canvas.set([v, v, v, 255], (y * W + x) * 4);
    }
  const blit = (px: Uint8Array, ox: number, oy: number): void => {
    for (let y = 0; y < ch * S; y++)
      for (let x = 0; x < cw * S; x++) {
        const i = (Math.floor(y / S) * cw + Math.floor(x / S)) * 4;
        const a = (px[i + 3] ?? 0) / 255;
        if (a === 0) continue;
        const o = ((oy + y) * W + ox + x) * 4;
        for (let c = 0; c < 3; c++)
          canvas[o + c] = Math.round((px[i + c] ?? 0) * a + (canvas[o + c] ?? 0) * (1 - a));
      }
    const line = oy + (feetBottom + 1) * S;
    for (let x = 0; x < cw * S; x++) canvas.set([255, 0, 255, 255], (line * W + ox + x) * 4);
  };
  plans.forEach((p, k) => {
    const ox = gut + (k % perRow) * tileW;
    const oy = gut + Math.floor(k / perRow) * rows * tileH;
    let r = 0;
    blit(
      cellOf(pristine, cw, ch, p.anim.row, p.anim.cells[p.index] as number),
      ox,
      oy + r++ * tileH,
    );
    if (cfg.reference) {
      const strip = decodePng(
        new Uint8Array(readFileSync(resolve(rel(cfg.reference.dir), `${p.anim.key}.png`))),
      );
      const ref = cellOf(strip, cw, ch, 0, p.index);
      blit(shiftDown(ref, cw, ch, -p.rise), ox, oy + r++ * tileH);
      const same = (rendered[k] as Uint8Array).every(
        (v, j) =>
          v === (shiftDown(ref, cw, ch, -p.rise)[j] as number) ||
          ((rendered[k] as Uint8Array)[j - (j % 4) + 3] === 0 && j % 4 !== 3),
      );
      console.log(
        `${p.anim.key} #${p.index}: render ${same ? 'equals' : 'DIFFERS from'} reference`,
      );
    }
    blit(rendered[k] as Uint8Array, ox, oy + r++ * tileH);
  });
  const sheetOut = resolve(values.sheet);
  mkdirSync(dirname(sheetOut), { recursive: true });
  writeFileSync(sheetOut, encodePng({ width: W, height: H, data: canvas, kind: 'rgba' }));
  console.log(`wrote ${sheetOut} (${W}x${H})`);
}
