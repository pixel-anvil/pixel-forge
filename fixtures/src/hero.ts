// Synthetic humanoid "hero" (T3.9): a 48x48 side view built from rectangles. Writes
// generated/hero.pxf. The same parts are drawn in src/aseprite/hero_parts.lua (hand-kept copy; a
// test in packages/io compares the two). Art is synthetic: no third-party pixels.
//
// Geometry comes from `humanoidSide({ height: 47, origin: { x: 24, y: 47 } })`: the pivots are
// (24,47) root, (24,25) hips, (24,23) torso, (24,10) neck, (24,8) head, (24,12) shoulder, (24,19)
// elbow, (24,25) wrist, (24,35) knee, (24,45) ankle. Every child part reaches 2 px past its pivot
// into its parent (the "joint cap", docs/contracts/JOINT_CHECK.md). T3.9b widened the caps at the
// head (wider neck, chin overlap), hips (pelvis 7 tall) and knees (thighs 16 tall) so `jointCheck`
// reports no gap over the default sweep. The .pxf carries a render cache (core `createRigRenderer`).

type Rgb = readonly [number, number, number];
/** A filled rectangle: x, y, width, height, colour. Later rectangles paint over earlier ones. */
export type HeroRect = readonly [x: number, y: number, w: number, h: number, color: Rgb];

export interface HeroPart {
  /** The source layer name, `part:<bone>[@<variant>]`. */
  readonly layer: string;
  readonly bone: string;
  readonly variant?: string;
  readonly rects: readonly HeroRect[];
}

export const HERO_SIZE = 48;
export const HERO_HEIGHT = 47;
export const HERO_ORIGIN = { x: 24, y: 47 } as const;

const SKIN: Rgb = [232, 190, 150];
const SKIN_FAR: Rgb = [190, 150, 120];
const HAIR: Rgb = [70, 45, 30];
const EYE: Rgb = [30, 30, 40];
const SHIRT: Rgb = [60, 110, 190];
const SHIRT_FAR: Rgb = [40, 75, 140];
const PANTS: Rgb = [70, 70, 100];
const PANTS_FAR: Rgb = [45, 45, 68];
const SHOE: Rgb = [120, 75, 40];
const SHOE_FAR: Rgb = [85, 52, 28];
const SLEEVE: Rgb = [200, 70, 60];
const CUFF: Rgb = [240, 220, 90];

/** Parts in ascending template z (the layer order of the .aseprite file). */
export const HERO_PARTS: readonly HeroPart[] = [
  { layer: 'part:thigh_l', bone: 'thigh_l', rects: [[20, 24, 6, 16, PANTS_FAR]] },
  { layer: 'part:shin_l', bone: 'shin_l', rects: [[21, 34, 4, 13, PANTS_FAR]] },
  {
    layer: 'part:foot_l',
    bone: 'foot_l',
    rects: [
      [21, 46, 9, 2, SHOE_FAR],
      [21, 45, 4, 1, SHOE_FAR],
    ],
  },
  { layer: 'part:upper_arm_l', bone: 'upper_arm_l', rects: [[22, 11, 3, 10, SHIRT_FAR]] },
  { layer: 'part:lower_arm_l', bone: 'lower_arm_l', rects: [[22, 18, 3, 9, SKIN_FAR]] },
  { layer: 'part:hand_l', bone: 'hand_l', rects: [[22, 24, 4, 4, SKIN_FAR]] },
  { layer: 'part:pelvis', bone: 'pelvis', rects: [[21, 23, 7, 7, PANTS]] },
  { layer: 'part:torso', bone: 'torso', rects: [[21, 10, 7, 15, SHIRT]] },
  { layer: 'part:neck', bone: 'neck', rects: [[22, 8, 5, 4, SKIN]] },
  { layer: 'part:thigh_r', bone: 'thigh_r', rects: [[21, 24, 6, 16, PANTS]] },
  { layer: 'part:shin_r', bone: 'shin_r', rects: [[22, 34, 4, 13, PANTS]] },
  {
    layer: 'part:foot_r',
    bone: 'foot_r',
    rects: [
      [22, 46, 9, 2, SHOE],
      [22, 45, 4, 1, SHOE],
    ],
  },
  {
    layer: 'part:head',
    bone: 'head',
    rects: [
      [21, 0, 8, 10, SKIN],
      [22, 10, 5, 2, SKIN],
      [21, 0, 8, 3, HAIR],
      [21, 3, 2, 3, HAIR],
      [27, 4, 1, 1, EYE],
    ],
  },
  { layer: 'part:upper_arm_r', bone: 'upper_arm_r', rects: [[23, 11, 3, 10, SHIRT]] },
  { layer: 'part:lower_arm_r', bone: 'lower_arm_r', rects: [[23, 18, 3, 9, SKIN]] },
  {
    layer: 'part:lower_arm_r@sleeve',
    bone: 'lower_arm_r',
    variant: 'sleeve',
    rects: [
      [22, 18, 5, 9, SLEEVE],
      [22, 25, 5, 2, CUFF],
    ],
  },
  { layer: 'part:hand_r', bone: 'hand_r', rects: [[23, 24, 4, 4, SKIN]] },
];

/**
 * Hand-computed rest-pose joint caps: per joint (child bone) the rectangle `[x, y, w, h]` that both
 * the parent's and the child's part cover, 2 px deep along the bone and spanning the limb at the
 * pivot. The pivot pixel lies inside it.
 */
export const HERO_CAPS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  torso: [22, 23, 5, 2],
  neck: [23, 10, 3, 2],
  head: [23, 8, 3, 2],
  upper_arm_r: [23, 11, 3, 2],
  lower_arm_r: [23, 18, 3, 2],
  hand_r: [23, 24, 3, 2],
  upper_arm_l: [22, 11, 3, 2],
  lower_arm_l: [22, 18, 3, 2],
  hand_l: [22, 24, 3, 2],
  thigh_r: [22, 24, 5, 2],
  shin_r: [22, 34, 4, 2],
  foot_r: [22, 45, 4, 2],
  thigh_l: [22, 24, 3, 2],
  shin_l: [21, 34, 4, 2],
  foot_l: [22, 45, 3, 2],
};

/** One part rasterised on the full canvas (RGBA, row-major). */
export function rasterizePart(part: HeroPart): Uint8Array {
  const data = new Uint8Array(HERO_SIZE * HERO_SIZE * 4);
  for (const [x, y, w, h, c] of part.rects) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        data.set([c[0], c[1], c[2], 255], (yy * HERO_SIZE + xx) * 4);
      }
    }
  }
  return data;
}

/** Bounding box `[x, y, w, h]` of a part's rectangles. */
export function partBox(part: HeroPart): [number, number, number, number] {
  const x0 = Math.min(...part.rects.map((r) => r[0]));
  const y0 = Math.min(...part.rects.map((r) => r[1]));
  const x1 = Math.max(...part.rects.map((r) => r[0] + r[2]));
  const y1 = Math.max(...part.rects.map((r) => r[1] + r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

interface Ctx {
  writeFile(relPath: string, bytes: Uint8Array): void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Builds the document and returns the `.pxf` bytes. Deterministic (fixed ids and clock). */
export async function buildHeroPxf(): Promise<Uint8Array> {
  // Workspace packages are loaded from their build output: the generator runs under plain node.
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
      name: 'hero',
      schemaVersion: schema.SCHEMA_VERSION,
      canvas: { w: HERO_SIZE, h: HERO_SIZE },
      origin: { ...HERO_ORIGIN },
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
  const template = rig.humanoidSide({ height: HERO_HEIGHT, origin: HERO_ORIGIN });
  const rawNames: Record<string, string> = {};
  store.transact('hero', (tx: any) => {
    core.applySkeletonTemplate(tx, template);
    const frameId = tx.newId('frame');
    const layers = HERO_PARTS.map((part) => {
      const [bx, by, bw, bh] = partBox(part);
      const full = rasterizePart(part);
      const data = new Uint8Array(bw * bh * 4);
      for (let y = 0; y < bh; y++) {
        const from = ((by + y) * HERO_SIZE + bx) * 4;
        data.set(full.subarray(from, from + bw * 4), y * bw * 4);
      }
      const imageId = tx.createImage(raster.TiledImage.fromRGBA({ width: bw, height: bh, data }));
      const id = tx.newId('layer');
      // Document layer names obey the Name grammar; the `part:` source name goes to bindParts.
      rawNames[id] = part.layer;
      return {
        kind: 'pixel',
        id,
        name: part.variant === undefined ? part.bone : `${part.bone}_${part.variant}`,
        visible: true,
        opacity: 255,
        export: true,
        cels: { [frameId]: { imageId, offset: { x: bx, y: by }, opacity: 255 } },
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
    const res = core.bindParts(tx, { rawNames, byOverlap: false, zByBone: template.z });
    if (res.skipped.length > 0) {
      throw new Error(`hero: unbound layers ${JSON.stringify(res.skipped)}`);
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
  ctx.writeFile('generated/hero.pxf', await buildHeroPxf());
}
