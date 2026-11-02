// Fixtures for the Godot importer tests (T6.1). Writes ../godot/test/fixtures/*.pxf plus
// expected.json. The art is synthetic. `expected.json` is computed here from the rectangle lists
// below, independently of the render cache, so the GUT tests can check trim boxes, markers, events
// and durations without trusting the code under test.
//
//   walker.pxf  RGBA 24x24, origin (12, 23): walk/side (3 frames, trimmed boxes differ), walk/up
//               (2 frames, pingpong), walk/left = mirror of side, flash/side (one frame covering
//               the whole canvas), idle (undirected: art, empty frame, the same art again),
//               markers, events, root motion, directionFallback.
//   skins.pxf   indexed 16x16 with a palette skin and a remap skin (skins recolour, they keep
//               alpha, so every skin has the same extent).

type Rgb = readonly [number, number, number];
/** A filled rectangle: x, y, width, height, colour. Later rectangles paint over earlier ones. */
type Rect = readonly [x: number, y: number, w: number, h: number, c: Rgb];

interface Ctx {
  writeFile(relPath: string, bytes: Uint8Array): void;
  writeJson(relPath: string, obj: unknown): void;
}

const OUT = '../godot/test/fixtures';
const CLOCK = '2026-01-01T00:00:00Z';

interface FrameSpec {
  rects: readonly Rect[];
  ms: number;
  markers?: Record<string, [number, number]>;
  events?: string[];
  root?: [number, number];
}

const RED: Rgb = [200, 60, 50];
const BLUE: Rgb = [50, 90, 200];
const GREEN: Rgb = [60, 170, 80];
const YELLOW: Rgb = [235, 205, 70];
const WHITE: Rgb = [240, 240, 240];
const PURPLE: Rgb = [150, 70, 180];
const TEAL: Rgb = [40, 160, 170];

// walk/side: a figure that faces right (the asymmetric "nose" makes a mirror visible).
const WALK_SIDE: FrameSpec[] = [
  {
    ms: 80,
    rects: [
      [9, 10, 6, 10, BLUE],
      [10, 6, 4, 4, RED],
      [14, 7, 2, 1, YELLOW],
    ],
    markers: { ball: [15, 12], hand_r: [14, 14] },
    events: ['step'],
    root: [2, 0],
  },
  {
    ms: 120,
    rects: [
      [8, 9, 6, 11, BLUE],
      [9, 5, 4, 4, RED],
      [13, 6, 2, 1, YELLOW],
      [14, 12, 3, 2, GREEN],
      [8, 20, 5, 2, WHITE],
    ],
    markers: { ball: [16, 11] },
    root: [1, -1],
  },
  {
    ms: 100,
    rects: [
      [10, 11, 6, 9, BLUE],
      [11, 7, 4, 4, RED],
      [15, 8, 1, 1, YELLOW],
    ],
    events: ['step', 'release'],
    root: [0, 0],
  },
];

const WALK_UP: FrameSpec[] = [
  {
    ms: 60,
    rects: [
      [6, 12, 12, 8, PURPLE],
      [10, 8, 4, 4, TEAL],
    ],
  },
  {
    ms: 90,
    rects: [
      [7, 4, 10, 17, PURPLE],
      [10, 3, 4, 2, TEAL],
    ],
    events: ['step'],
    markers: { hand_r: [7, 12] },
  },
];

/** Every pixel of the 24x24 canvas opaque and different from its neighbours. */
function flashRects(): Rect[] {
  const rects: Rect[] = [];
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) rects.push([x, y, 1, 1, [x * 10, y * 10, (x * 7 + y * 3) & 255]]);
  }
  return rects;
}

const FLASH: FrameSpec[] = [{ ms: 50, rects: flashRects(), markers: { ball: [0, 0] } }];

const IDLE_ART: Rect[] = [
  [10, 12, 4, 8, GREEN],
  [11, 9, 2, 3, YELLOW],
];
// idle frame 1 has no cel (a fully transparent frame); frame 2 links to frame 0 (equal pixels).
const IDLE: FrameSpec[] = [
  { ms: 100, rects: IDLE_ART, markers: { ball: [12, 8] } },
  { ms: 50, rects: [] },
  { ms: 100, rects: IDLE_ART, events: ['release'] },
];

type Box = [x: number, y: number, w: number, h: number];

/** Bounding box of the opaque pixels of a rectangle list; `null` when empty. */
function boxOf(rects: readonly Rect[]): Box | null {
  if (rects.length === 0) return null;
  const x0 = Math.min(...rects.map((r) => r[0]));
  const y0 = Math.min(...rects.map((r) => r[1]));
  const x1 = Math.max(...rects.map((r) => r[0] + r[2]));
  const y1 = Math.max(...rects.map((r) => r[1] + r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

function rasterize(w: number, h: number, rects: readonly Rect[]): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (const [x, y, rw, rh, c] of rects) {
    for (let yy = y; yy < y + rh; yy++) {
      for (let xx = x; xx < x + rw; xx++) data.set([c[0], c[1], c[2], 255], (yy * w + xx) * 4);
    }
  }
  return data;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function load(): Promise<{ core: any; io: any; raster: any; schema: any }> {
  // Workspace packages are loaded from their build output: the generator runs under plain node.
  const pkg = (name: string): string =>
    new URL(`../../packages/${name}/dist/index.js`, import.meta.url).href;
  return {
    core: await import(pkg('core')),
    io: await import(pkg('io')),
    raster: await import(pkg('raster')),
    schema: await import(pkg('schema')),
  };
}

function newStore(
  m: { core: any; schema: any },
  opts: { name: string; size: number; origin: { x: number; y: number }; indexed: boolean },
): any {
  const gen = m.schema.createIdGenerator({ seed: 6, next: 0 });
  return new m.core.DocumentStore({
    meta: {
      id: gen.next('doc'),
      name: opts.name,
      schemaVersion: m.schema.SCHEMA_VERSION,
      canvas: { w: opts.size, h: opts.size },
      origin: opts.origin,
      pixelsPerUnit: 16,
      colorMode: opts.indexed ? 'indexed' : 'rgba',
      paletteLocked: false,
      ids: gen.state(),
    },
    palettes: [],
    skins: [],
    layers: [],
    animations: [],
    directionFallback: {},
    markerDefs: [],
    eventDefs: [],
  });
}

function frameOf(tx: any, id: string, f: FrameSpec): any {
  const markers: Record<string, { x: number; y: number }> = {};
  for (const [k, v] of Object.entries(f.markers ?? {})) markers[k] = { x: v[0], y: v[1] };
  return {
    id,
    durationMs: f.ms,
    markers,
    events: f.events ?? [],
    rootMotion: { dx: f.root?.[0] ?? 0, dy: f.root?.[1] ?? 0 },
    boneKeys: {},
    partKeys: {},
  };
}

async function buildWalker(): Promise<{ bytes: Uint8Array; expected: unknown }> {
  const m = await load();
  const SIZE = 24;
  const store = newStore(m, {
    name: 'walker',
    size: SIZE,
    origin: { x: 12, y: 23 },
    indexed: false,
  });
  const expectedFrames: unknown[] = [];
  store.transact('walker', (tx: any) => {
    const cels: Record<string, unknown> = {};
    const anims: any[] = [];
    let sideId = '';
    const author = (
      group: string,
      direction: string | undefined,
      loop: string,
      specs: FrameSpec[],
      link?: { frame: number; to: number },
    ): string => {
      const id = tx.newId('animation');
      const frames: any[] = [];
      const ids: string[] = specs.map(() => tx.newId('frame'));
      specs.forEach((f, i) => {
        frames.push(frameOf(tx, ids[i], f));
        const box = boxOf(f.rects);
        if (link !== undefined && link.frame === i) {
          cels[ids[i]] = { linkTo: ids[link.to] };
        } else if (box !== null) {
          const [bx, by, bw, bh] = box;
          const full = rasterize(SIZE, SIZE, f.rects);
          const data = new Uint8Array(bw * bh * 4);
          for (let y = 0; y < bh; y++) {
            const from = ((by + y) * SIZE + bx) * 4;
            data.set(full.subarray(from, from + bw * 4), y * bw * 4);
          }
          const imageId = tx.createImage(
            m.raster.TiledImage.fromRGBA({ width: bw, height: bh, data }),
          );
          cels[ids[i]] = { imageId, offset: { x: bx, y: by }, opacity: 255 };
        }
        expectedFrames.push({
          key: `${group}/${direction ?? 'default'}/${i}`,
          durationMs: f.ms,
          // [x, y, w, h] of the opaque pixels on the canvas, null for an empty frame.
          box: boxOf(f.rects),
          markers: Object.fromEntries(
            Object.entries(f.markers ?? {}).map(([k, v]) => [k, { x: v[0], y: v[1] }]),
          ),
          events: f.events ?? [],
          rootMotion: { dx: f.root?.[0] ?? 0, dy: f.root?.[1] ?? 0 },
        });
      });
      anims.push({ id, group, ...(direction ? { direction } : {}), loop, frames, overrides: [] });
      return id;
    };
    // Authoring order differs from the sorted order on purpose.
    sideId = author('walk', 'side', 'loop', WALK_SIDE);
    author('walk', 'up', 'pingpong', WALK_UP);
    author('idle', undefined, 'once', IDLE, { frame: 2, to: 0 });
    author('flash', 'side', 'once', FLASH);
    anims.push({
      id: tx.newId('animation'),
      group: 'walk',
      direction: 'left',
      mirrorOf: sideId,
      overrides: [],
    });
    tx.update((d: any) => {
      d.layers.push({
        kind: 'pixel',
        id: tx.newId('layer'),
        name: 'body',
        visible: true,
        opacity: 255,
        export: true,
        cels,
      });
      d.animations.push(...anims);
      d.directionFallback = { down: ['down', 'side'], up: ['up', 'side'] };
      d.markerDefs = [{ name: 'ball' }, { name: 'hand_r' }];
      d.eventDefs = [{ name: 'release' }, { name: 'step' }];
    });
  });
  // The expected list follows the importer's order: sorted group, direction, frame index.
  (expectedFrames as { key: string }[]).sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  const built = m.io.buildPxf(store, {
    clock: m.io.fixedClock(CLOCK),
    app: 'pixel-forge fixtures',
  });
  return {
    bytes: built.bytes,
    expected: {
      canvas: [SIZE, SIZE],
      origin: [12, 23],
      pixelsPerUnit: 16,
      skins: ['base'],
      directionFallback: { down: ['down', 'side'], up: ['up', 'side'] },
      mirrors: { 'walk/left': 'side' },
      loops: {
        'walk/side': 'loop',
        'walk/up': 'pingpong',
        'idle/default': 'once',
        'flash/side': 'once',
      },
      frames: expectedFrames,
    },
  };
}

// Palette indices: 0 transparent, 1 outline, 2 body, 3 edge, 4 accent.
const BASE_PALETTE = [
  [0, 0, 0, 0],
  [20, 12, 28, 255],
  [200, 60, 50, 255],
  [235, 205, 70, 255],
  [50, 90, 200, 255],
];
// A second palette: the same indices in other colours (a team kit).
const GHOST_PALETTE = [
  [0, 0, 0, 0],
  [30, 30, 50, 255],
  [150, 220, 190, 255],
  [255, 255, 255, 255],
  [90, 60, 160, 255],
];

// 16x16 frames as lists of [x, y, w, h, paletteIndex]; later rectangles paint over earlier ones.
type IRect = readonly [number, number, number, number, number];
const BLINK: { ms: number; rects: IRect[] }[] = [
  {
    ms: 90,
    rects: [
      [4, 4, 8, 8, 1],
      [5, 5, 6, 6, 2],
      [12, 6, 2, 4, 3],
    ],
  },
  {
    ms: 110,
    rects: [
      [3, 6, 10, 6, 1],
      [4, 7, 8, 4, 4],
      [6, 3, 4, 3, 3],
    ],
  },
];

function indexRaster(w: number, h: number, rects: readonly IRect[]): Uint8Array {
  const data = new Uint8Array(w * h);
  for (const [x, y, rw, rh, i] of rects) {
    for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) data[yy * w + xx] = i;
  }
  return data;
}

async function buildSkins(): Promise<{ bytes: Uint8Array; expected: unknown }> {
  const m = await load();
  const SIZE = 16;
  const store = newStore(m, { name: 'skins', size: SIZE, origin: { x: 8, y: 15 }, indexed: true });
  store.transact('skins', (tx: any) => {
    const basePal = tx.newId('palette');
    const ghostPal = tx.newId('palette');
    const frames: any[] = [];
    const cels: Record<string, unknown> = {};
    for (const f of BLINK) {
      const id = tx.newId('frame');
      frames.push(frameOf(tx, id, { rects: [], ms: f.ms }));
      const data = indexRaster(SIZE, SIZE, f.rects);
      const imageId = tx.createImage(m.raster.IndexedImage.fromIndices(SIZE, SIZE, data, 0));
      cels[id] = { imageId, offset: { x: 0, y: 0 }, opacity: 255 };
    }
    tx.update((d: any) => {
      d.palettes.push(
        { id: basePal, name: 'Base', colors: BASE_PALETTE, ramps: [] },
        { id: ghostPal, name: 'Ghost', colors: GHOST_PALETTE, ramps: [] },
      );
      d.activePaletteId = basePal;
      // A palette skin and a remap skin (body <-> accent). Skins recolour; alpha is kept.
      d.skins.push(
        { id: tx.newId('skin'), name: 'ghost', paletteId: ghostPal },
        {
          id: tx.newId('skin'),
          name: 'swap',
          remap: [
            [2, 4],
            [4, 2],
          ],
        },
      );
      d.layers.push({
        kind: 'pixel',
        id: tx.newId('layer'),
        name: 'body',
        visible: true,
        opacity: 255,
        export: true,
        cels,
      });
      d.animations.push({
        id: tx.newId('animation'),
        group: 'blink',
        loop: 'loop',
        frames,
        overrides: [],
      });
    });
  });
  const built = m.io.buildPxf(store, {
    clock: m.io.fixedClock(CLOCK),
    app: 'pixel-forge fixtures',
  });
  const expected = {
    canvas: [SIZE, SIZE],
    origin: [8, 15],
    skins: ['base', 'ghost', 'swap'],
    // The box of the opaque pixels (the same in every skin: skins recolour, they keep alpha).
    frames: BLINK.map((f, i) => ({
      key: `blink/default/${i}`,
      durationMs: f.ms,
      box: boxOf(f.rects.map((r) => [r[0], r[1], r[2], r[3], [0, 0, 0]] as Rect)),
    })),
  };
  return { bytes: built.bytes, expected };
}

export default async function generate(ctx: Ctx): Promise<void> {
  const walker = await buildWalker();
  const skins = await buildSkins();
  ctx.writeFile(`${OUT}/walker.pxf`, walker.bytes);
  ctx.writeFile(`${OUT}/skins.pxf`, skins.bytes);
  ctx.writeJson(`${OUT}/expected.json`, { walker: walker.expected, skins: skins.expected });
}
