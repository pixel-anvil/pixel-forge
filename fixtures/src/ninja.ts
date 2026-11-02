// Second test rig (card E7.4): a rig cut from real drawn art, `cc0/male_base_ninja/ninja_full.png`
// (CC0, see its LICENSE.md). One standing side-view frame (sheet column 3, a 32x64 cell) is cut into
// parts. Writes generated/ninja.pxf.
//
// The sheet cells are 32 wide and 64 tall (the pack is "32x64"), 10 columns. The figure is 45 px tall,
// faces +x, has no neck, 4 px thin limbs, a 5-colour palette and a boot with no toe. Only the near
// arm and the near leg are drawn in this frame: the far limbs are darker copies of the near ones
// (hidden behind them at rest), so the cut is "real art for the near side, derived for the far side".
//
// How the rig is built, step by step (the same calls an agent would make):
//   1. `fitHumanoid('side', landmarks)`  -> bone lengths from four landmarks (op `rig.fitTemplate`)
//   2. the arm pivots move 2 px forward: the art hangs the arm in front of the torso, not on the centre line
//   3. one pixel layer per part, cut by rectangles and a few exceptions (below), then `bindParts`.
// Every child part reaches 2 px past its pivot into its parent (the joint cap, JOINT_CHECK.md).

type Rgb = readonly [number, number, number];

/** The source cell: sheet column and size. */
export const NINJA_COLUMN = 3;
export const NINJA_CELL = { w: 32, h: 64 } as const;
/** Empty columns added on each side of the cell: the arms reach past the cell edge in run and swing. */
export const NINJA_PAD_X = 8;
/** Landmarks (cell pixels) for `rig.fitTemplate`: head top, hip joint, between the soles, near fingertip. */
export const NINJA_LANDMARKS = {
  headTop: { x: 15, y: 19 },
  hips: { x: 15, y: 43 },
  feet: { x: 15, y: 63 },
  handR: { x: 18, y: 43 },
} as const;
/** The arm pivots sit this many px in front of the centre line (the art draws the arm there). */
export const NINJA_ARM_DX = 2;

/** One part: the bone, the pixels it owns (`rows` and `cols` inclusive, then `keep`), and whether it is a far-side copy. */
export interface NinjaPart {
  readonly bone: string;
  readonly rows: readonly [number, number];
  readonly cols: readonly [number, number];
  /** Extra filter on the pixels of the rectangle. */
  readonly keep?: (x: number, y: number) => boolean;
  /** A darker copy for the far side (z behind the body). */
  readonly far?: boolean;
}

const near = (bone: string): string => `${bone}_r`;
const far = (bone: string): string => `${bone}_l`;

/** The cut. Rows and columns are cell pixels; see the dump of the cell in the card report. */
function cut(side: 'near' | 'far'): NinjaPart[] {
  const f = side === 'far';
  const b = (bone: string): string => (f ? far(bone) : near(bone));
  const arm = (bone: string, rows: [number, number]): NinjaPart => ({
    bone: b(bone),
    rows,
    cols: [16, 20],
    // The torso's right outline (col 16) belongs to the arm only where it is the dark outline.
    keep: (x, y) => x >= 17 || isOutline(x, y),
    far: f,
  });
  return [
    // legs: the near leg is the 4 px strip; the far copy also takes the thin far-leg sliver (cols 17 and 18)
    {
      bone: b('thigh'),
      rows: [41, 54],
      cols: f ? [12, 18] : [12, 16],
      keep: f ? (x, y) => x <= 16 || y >= 45 : undefined,
      far: f,
    },
    {
      bone: b('shin'),
      rows: [50, 61],
      cols: f ? [12, 18] : [12, 16],
      far: f,
    },
    { bone: b('foot'), rows: [59, 63], cols: [11, 17], far: f },
    arm('upper_arm', [29, 37]),
    arm('lower_arm', [33, 43]),
    { bone: b('hand'), rows: [40, 44], cols: [17, 20], far: f },
  ];
}

/** Parts without a far twin, in the order they are created. */
const BODY: readonly NinjaPart[] = [
  { bone: 'pelvis', rows: [36, 46], cols: [12, 17], keep: (x, y) => y < 44 || x <= 16 },
  // upper body: everything down to row 33 (the shoulder), then the torso side only
  { bone: 'torso', rows: [27, 42], cols: [11, 19], keep: (x, y) => y <= 33 || x <= 16 },
  { bone: 'neck', rows: [26, 29], cols: [13, 18] },
  { bone: 'head', rows: [19, 27], cols: [12, 19] },
];

let source: { data: Uint8Array; width: number } | undefined;
function px(x: number, y: number): readonly [number, number, number, number] {
  const s = source;
  if (s === undefined) throw new Error('ninja: source not loaded');
  const i = (y * s.width + NINJA_COLUMN * NINJA_CELL.w + x) * 4;
  return [s.data[i] ?? 0, s.data[i + 1] ?? 0, s.data[i + 2] ?? 0, s.data[i + 3] ?? 0];
}
const OUTLINE: Rgb = [18, 18, 64];
function isOutline(x: number, y: number): boolean {
  const p = px(x, y);
  return p[3] > 0 && p[0] === OUTLINE[0] && p[1] === OUTLINE[1] && p[2] === OUTLINE[2];
}

/** The darker colour of a far-side pixel: fill and shade darken, the outline and the transparent stay. */
const FAR: Readonly<Record<string, Rgb>> = {
  '85,84,145': [54, 54, 104],
  '70,70,125': [42, 42, 88],
  '175,130,71': [120, 90, 52],
  '162,109,41': [105, 72, 30],
};

/** One part rasterised on the full cell canvas (RGBA). */
export function rasterizeNinjaPart(part: NinjaPart): Uint8Array {
  const out = new Uint8Array(NINJA_CELL.w * NINJA_CELL.h * 4);
  for (let y = part.rows[0]; y <= part.rows[1]; y++) {
    for (let x = part.cols[0]; x <= part.cols[1]; x++) {
      if (part.keep !== undefined && !part.keep(x, y)) continue;
      const p = px(x, y);
      if (p[3] === 0) continue;
      const darker = part.far === true ? FAR[`${p[0]},${p[1]},${p[2]}`] : undefined;
      const c: Rgb = darker ?? [p[0], p[1], p[2]];
      out.set([c[0], c[1], c[2], 255], (y * NINJA_CELL.w + x) * 4);
    }
  }
  return out;
}

/** All parts in ascending template z: far limbs first, then the body, then the near limbs. */
export function ninjaParts(): NinjaPart[] {
  return [...cut('far'), ...BODY, ...cut('near')];
}

interface Ctx {
  writeFile(relPath: string, bytes: Uint8Array): void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Loads the source sheet (needed before `ninjaParts` / `rasterizeNinjaPart`). The workspace packages come from their build output (plain node). */
export async function loadNinjaSource(): Promise<void> {
  const png: any = await import(new URL('../../packages/png/dist/index.js', import.meta.url).href);
  const fs: any = await import('node:fs');
  const bytes = fs.readFileSync(
    new URL('../cc0/male_base_ninja/ninja_full.png', import.meta.url),
  ) as Uint8Array;
  const img = png.decodePng(new Uint8Array(bytes));
  source = { data: img.data, width: img.width };
}

/** Builds the document and returns the `.pxf` bytes. Deterministic (fixed ids and clock). */
export async function buildNinjaPxf(): Promise<Uint8Array> {
  await loadNinjaSource();
  const pkg = (name: string): string =>
    new URL(`../../packages/${name}/dist/index.js`, import.meta.url).href;
  const core: any = await import(pkg('core'));
  const io: any = await import(pkg('io'));
  const raster: any = await import(pkg('raster'));
  const rig: any = await import(pkg('rig'));
  const schema: any = await import(pkg('schema'));

  const gen = schema.createIdGenerator({ seed: 9, next: 0 });
  const store = new core.DocumentStore({
    meta: {
      id: gen.next('doc'),
      name: 'ninja',
      schemaVersion: schema.SCHEMA_VERSION,
      canvas: { w: NINJA_CELL.w + 2 * NINJA_PAD_X, h: NINJA_CELL.h },
      origin: { x: NINJA_LANDMARKS.feet.x + NINJA_PAD_X, y: NINJA_LANDMARKS.feet.y },
      pixelsPerUnit: 16,
      colorMode: 'rgba',
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
  const onCanvas = (p: { x: number; y: number }): { x: number; y: number } => ({
    x: p.x + NINJA_PAD_X,
    y: p.y,
  });
  const fitted = rig.fitHumanoid('side', {
    headTop: onCanvas(NINJA_LANDMARKS.headTop),
    hips: onCanvas(NINJA_LANDMARKS.hips),
    feet: onCanvas(NINJA_LANDMARKS.feet),
    handR: onCanvas(NINJA_LANDMARKS.handR),
  });
  const template = {
    ...fitted.template,
    bones: fitted.template.bones.map((bone: any) =>
      bone.name.startsWith('upper_arm_')
        ? { ...bone, rest: { ...bone.rest, x: bone.rest.x + NINJA_ARM_DX } }
        : bone,
    ),
  };
  const rawNames: Record<string, string> = {};
  store.transact('ninja', (tx: any) => {
    core.applySkeletonTemplate(tx, template);
    const frameId = tx.newId('frame');
    const layers = ninjaParts().map((part) => {
      const full = rasterizeNinjaPart(part);
      let x0 = NINJA_CELL.w;
      let y0 = NINJA_CELL.h;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < NINJA_CELL.h; y++) {
        for (let x = 0; x < NINJA_CELL.w; x++) {
          if ((full[(y * NINJA_CELL.w + x) * 4 + 3] ?? 0) === 0) continue;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
      if (x1 < 0) throw new Error(`ninja: part ${part.bone} is empty`);
      const bw = x1 - x0 + 1;
      const bh = y1 - y0 + 1;
      const data = new Uint8Array(bw * bh * 4);
      for (let y = 0; y < bh; y++) {
        const from = ((y0 + y) * NINJA_CELL.w + x0) * 4;
        data.set(full.subarray(from, from + bw * 4), y * bw * 4);
      }
      const imageId = tx.createImage(raster.TiledImage.fromRGBA({ width: bw, height: bh, data }));
      const id = tx.newId('layer');
      rawNames[id] = `part:${part.bone}`;
      return {
        kind: 'pixel',
        id,
        name: part.bone,
        visible: true,
        opacity: 255,
        export: true,
        cels: { [frameId]: { imageId, offset: { x: x0 + NINJA_PAD_X, y: y0 }, opacity: 255 } },
      };
    });
    const animId = tx.newId('animation');
    tx.update((d: any) => {
      d.layers.push(...layers);
      d.animations.push({
        id: animId,
        group: 'default',
        loop: 'loop',
        frames: [
          {
            id: frameId,
            durationMs: 100,
            markers: {},
            events: [],
            rootMotion: { dx: 0, dy: 0 },
            boneKeys: {},
            partKeys: {},
          },
        ],
        overrides: [],
      });
    });
    const res = core.bindParts(tx, { rawNames, byOverlap: false, zByBone: { ...template.z } });
    if (res.skipped.length > 0) {
      throw new Error(`ninja: unbound layers ${JSON.stringify(res.skipped)}`);
    }
  });
  const built = io.buildPxf(store, {
    clock: io.fixedClock('2026-01-01T00:00:00Z'),
    rig: core.createRigRenderer(),
    app: 'pixel-forge fixtures',
  });
  return built.bytes;
}

export default async function generate(ctx: Ctx): Promise<void> {
  ctx.writeFile('generated/ninja.pxf', await buildNinjaPxf());
}
