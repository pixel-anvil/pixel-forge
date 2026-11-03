/**
 * Shared parts of the `convert` ops (E4.5): the input fields, the plan that turns them into a
 * `ConvertRecipe`, palette choice, and building the result document or layers.
 * @packageDocumentation
 */
import { DEFAULT_MAX_VARIANTS, runRecipe, runVariants, validateRecipe } from '@pixel-forge/convert';
import type {
  ConvertRecipe,
  NamedPalette,
  RecipeReport,
  VariantAxes,
  VariantResult,
} from '@pixel-forge/convert';
import type { DocumentStore, Transaction } from '@pixel-forge/core';
import { MAX_GENERATE_PIXELS, PRESETS, generatePalette } from '@pixel-forge/color';
import { cellOffset, createEmptyDocumentStore } from '@pixel-forge/io';
import { TiledImage } from '@pixel-forge/raster';
import type { RgbaImage } from '@pixel-forge/raster';
import { ID_SPACE, createIdGenerator } from '@pixel-forge/schema';
import type { FrameId, PixelLayer, RGBA8 } from '@pixel-forge/schema';
import { z } from 'zod';
import type { OpContext } from './context.js';
import { OpError } from './errors.js';
import { HexColor, parseHex } from './grid.js';

const METHODS = ['box', 'kcentroid', 'nearest', 'mode'] as const;
const DITHERS = ['none', 'bayer2', 'bayer4', 'bayer8', 'floyd-steinberg'] as const;
const PRESET_IDS = PRESETS.map((p) => p.id);

/** Colours made from the image when a quantise step has no palette. */
export const DEFAULT_GENERATED_COLORS = 16;

/** Input fields the convert ops share (spread into each op's `z.strictObject`). */
export const convertFields = {
  recipe: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Advanced: a ConvertRecipe {version:1, crop?, background?, downscale?, cleanup?, quantize?}. Replaces crop..clean.',
    ),
  crop: z.array(z.int().min(0)).length(4).optional().describe('[x, y, w, h], source px.'),
  background: z
    .enum(['none', 'key', 'flood', 'alpha'])
    .optional()
    .describe('key: all pixels near the corner colour. flood: only those joined to the border.'),
  tolerance: z.int().min(0).max(442).optional().describe('key/flood: RGB distance (default 0).'),
  grid: z
    .union([z.literal('auto'), z.int().min(2)])
    .optional()
    .describe(
      'Upscaled pixel art: "auto" finds the cell, or give its px size. Not with width/height.',
    ),
  width: z
    .int()
    .min(1)
    .max(4096)
    .optional()
    .describe('Target px; the other side keeps the aspect.'),
  height: z.int().min(1).max(4096).optional().describe('Target px, like width.'),
  method: z.enum(METHODS).optional().describe('Default kcentroid (mode with grid).'),
  palette: z
    .union([z.string(), z.array(HexColor).min(1).max(256)])
    .optional()
    .describe('Preset id (pico-8, sweetie-16, ...) or ["#rrggbb", ...].'),
  colors: z.int().min(2).max(256).optional().describe('Make a palette of this many colours.'),
  dither: z.enum(DITHERS).optional().describe('Dither mode (default none).'),
  strength: z.number().min(0).max(1).optional().describe('Dither strength (default 1).'),
  outline: z.boolean().optional().describe('Add a 1 px outline (canvas +2 px).'),
  clean: z.boolean().optional().describe('Alpha cut and lone-pixel removal (default true).'),
  variants: z
    .strictObject({
      method: z.array(z.enum(METHODS)).min(1).optional(),
      dither: z.array(z.enum(DITHERS)).min(1).optional(),
      palette: z.array(z.string()).min(1).optional().describe('Preset ids.'),
    })
    .optional()
    .describe(`Run every combination (max ${String(DEFAULT_MAX_VARIANTS)}).`),
};

/** The parsed shape of {@link convertFields}. */
export type ConvertInput = z.output<z.ZodObject<typeof convertFields>>;

/** Compact output description of a run, shared by the convert ops. */
export const ReportOut = z.strictObject({
  steps: z.array(z.string()).describe('Size after each step, e.g. "downscale 32x32".'),
  grid: z.string().optional().describe('Cell size used by the downscale, "WxH".'),
});

/** The `steps` and `grid` of a {@link ReportOut}. */
export function reportOf(report: RecipeReport): z.output<typeof ReportOut> {
  const steps = report.steps.map(
    (s) =>
      `${s.step} ${String(s.width)}x${String(s.height)}${s.note === undefined ? '' : ` (${s.note})`}`,
  );
  return {
    steps,
    ...(report.grid === undefined
      ? {}
      : { grid: `${String(report.grid.cellWidth)}x${String(report.grid.cellHeight)}` }),
  };
}

const bad = (path: string, message: string): OpError =>
  new OpError('BAD_INPUT', message, { issues: [{ path, message }] });

const SHORTCUTS = [
  'crop',
  'background',
  'tolerance',
  'grid',
  'width',
  'height',
  'method',
  'dither',
  'strength',
  'outline',
  'clean',
] as const;

/** What an op decided from its input, before any pixel is touched. */
export interface ConvertPlan {
  /** The base recipe; it has a `quantize` step when the result is quantised. */
  readonly recipe: ConvertRecipe;
  readonly axes: VariantAxes | undefined;
  /** A palette the caller named. */
  readonly given: NamedPalette | undefined;
  /** Make a palette of this many colours from the result. */
  readonly generate: number | undefined;
  /** The quantise step has no palette of its own: use the caller's fallback, else generate. */
  readonly needsDefault: boolean;
}

function presetPalette(id: string, at: string): NamedPalette {
  const p = PRESETS.find((x) => x.id === id);
  if (p === undefined)
    throw bad(at, `unknown palette preset "${id}"; valid: ${PRESET_IDS.join(', ')}`);
  return { name: p.id, colors: p.hex.map((h) => parseHex(`#${h}`) as RGBA8) };
}

/** The recipe of the shortcut fields (everything but the quantise step's dither). */
function shortcutRecipe(input: ConvertInput): Record<string, unknown> {
  const r: Record<string, unknown> = { version: 1 };
  if (input.crop !== undefined) {
    const [x, y, w, h] = input.crop;
    r.crop = { x, y, w, h };
  }
  if (input.background !== undefined && input.background !== 'none') {
    r.background =
      input.background === 'alpha'
        ? { mode: 'alpha' }
        : { mode: input.background, color: 'auto', tolerance: input.tolerance ?? 0 };
  }
  if (input.grid !== undefined) {
    if (input.width !== undefined || input.height !== undefined) {
      throw bad('grid', '"grid" and "width"/"height" are alternatives; give one');
    }
    r.downscale = {
      method: input.method ?? 'mode',
      grid:
        input.grid === 'auto'
          ? 'auto'
          : { cellWidth: input.grid, cellHeight: input.grid, offsetX: 0, offsetY: 0 },
      ...(input.grid === 'auto' ? { onNoGrid: 'error' } : {}),
    };
  } else if (input.width !== undefined || input.height !== undefined) {
    r.downscale = {
      method: input.method ?? 'kcentroid',
      ...(input.width === undefined ? {} : { width: input.width }),
      ...(input.height === undefined ? {} : { height: input.height }),
    };
  } else if (input.method !== undefined) {
    throw bad('method', '"method" needs a target: width, height or grid');
  }
  if (input.clean !== false || input.outline === true) {
    r.cleanup = input.outline === true ? { outline: { color: 'darken' } } : {};
  }
  return r;
}

/**
 * Turns the shared input fields into a {@link ConvertPlan}.
 * @throws OpError `BAD_INPUT` for a recipe mixed with shortcuts, an unknown preset or a bad recipe
 */
export function planConvert(input: ConvertInput): ConvertPlan {
  let raw: Record<string, unknown>;
  if (input.recipe !== undefined) {
    const mixed = SHORTCUTS.find((k) => input[k] !== undefined);
    if (mixed !== undefined) throw bad(mixed, `"recipe" replaces the shortcuts; remove "${mixed}"`);
    raw = { ...input.recipe };
  } else {
    raw = shortcutRecipe(input);
  }
  const axes: { -readonly [K in keyof VariantAxes]: VariantAxes[K] } = {};
  const v = input.variants;
  if (v?.method !== undefined) axes.method = v.method;
  if (v?.palette !== undefined) {
    axes.palette = v.palette.map((id, i) => presetPalette(id, `variants.palette.${String(i)}`));
  }
  if (v?.dither !== undefined) axes.dither = v.dither;

  const given =
    input.palette === undefined
      ? undefined
      : typeof input.palette === 'string'
        ? presetPalette(input.palette, 'palette')
        : { name: 'custom', colors: input.palette.map((h) => parseHex(h) as RGBA8) };
  const quantizes =
    raw.quantize !== undefined ||
    given !== undefined ||
    input.colors !== undefined ||
    input.dither !== undefined ||
    input.strength !== undefined ||
    v?.palette !== undefined ||
    v?.dither !== undefined;
  if (quantizes) {
    const q = (raw.quantize ?? {}) as Record<string, unknown>;
    raw.quantize = {
      ...q,
      ...(input.dither === undefined ? {} : { dither: input.dither }),
      ...(input.strength === undefined ? {} : { strength: input.strength }),
    };
  }
  const recipe = validateRecipe(raw);
  const ownPalette = recipe.quantize?.palette !== undefined;
  return {
    recipe,
    axes: input.variants === undefined ? undefined : axes,
    given,
    generate: input.colors,
    needsDefault:
      recipe.quantize !== undefined &&
      !ownPalette &&
      given === undefined &&
      input.colors === undefined &&
      v?.palette === undefined,
  };
}

/** Largest source image, in pixels (the palette generator's limit). */
export const MAX_SOURCE_PIXELS = MAX_GENERATE_PIXELS;

/**
 * The palette a plan quantises to: the named one, one made from the recipe's result without its
 * quantise step, or `fallback`. `undefined` when the recipe does not quantise or brings its own.
 */
export function choosePalette(
  img: RgbaImage,
  plan: ConvertPlan,
  fallback?: NamedPalette,
): NamedPalette | undefined {
  if (plan.given !== undefined) return plan.given;
  if (plan.generate === undefined) {
    if (!plan.needsDefault) return undefined;
    if (fallback !== undefined) return fallback;
  }
  const rest: Record<string, unknown> = { ...plan.recipe };
  delete rest.quantize;
  const prepared = runRecipe(img, rest as unknown as ConvertRecipe).image;
  const n = plan.generate ?? DEFAULT_GENERATED_COLORS;
  const made = generatePalette(prepared.data, { n, minAlpha: 128 });
  if (made.colors.length === 0) {
    throw new OpError('REFUSED', 'the result has no visible pixel to make a palette from', {
      reason: 'no-visible-pixels',
    });
  }
  return { name: 'generated', colors: made.colors };
}

/** One result of {@link runPlan}. */
export interface Converted {
  readonly label: string;
  readonly image: RgbaImage;
  readonly report: RecipeReport;
}

/** Runs the plan: one result, or one per variant. */
export function runPlan(
  img: RgbaImage,
  plan: ConvertPlan,
  palette: NamedPalette | undefined,
): Converted[] {
  const ctx = palette === undefined ? {} : { palette: palette.colors };
  if (plan.axes === undefined) {
    const { image, report } = runRecipe(img, plan.recipe, ctx);
    return [{ label: 'base', image, report }];
  }
  return runVariants(img, plan.recipe, plan.axes, ctx).map((r: VariantResult): Converted => ({
    label: r.label,
    image: r.image,
    report: r.report,
  }));
}

/** A layer name (`a-z0-9_-`, at most 48) from a variant label such as `method=box dither=bayer4`. */
export function layerNameOf(label: string): string {
  const name = label
    .toLowerCase()
    .replace(/=/g, '-')
    .replace(/[^a-z0-9_-]+/g, '_')
    .slice(0, 48);
  return name === '' ? 'sprite' : name;
}

/** Where a result of `image` size sits on the canvas: aligned to the origin unless it fills the canvas. */
export function placement(
  image: RgbaImage,
  canvas: { readonly w: number; readonly h: number },
  origin: { readonly x: number; readonly y: number },
): { x: number; y: number } {
  return image.width === canvas.w && image.height === canvas.h
    ? { x: 0, y: 0 }
    : cellOffset([image.width, image.height], origin);
}

/** A layer to add: the first visible layer of a set is the one the render shows. */
export interface NewLayer {
  readonly name: string;
  readonly image: RgbaImage;
  readonly visible: boolean;
}

/** Adds one pixel layer per entry on top of the stack, each with a cel at `frameId`. */
export function addLayersTx(tx: Transaction, frameId: FrameId, layers: readonly NewLayer[]): void {
  const { canvas, origin } = tx.doc.meta;
  const made = layers.map((l) => ({
    id: tx.newId('layer'),
    name: l.name,
    visible: l.visible,
    imageId: tx.createImage(TiledImage.fromRGBA(l.image)),
    offset: placement(l.image, canvas, origin),
  }));
  tx.update((d) => {
    for (const m of made) {
      const layer: PixelLayer = {
        kind: 'pixel',
        id: m.id,
        name: m.name,
        visible: m.visible,
        opacity: 255,
        export: true,
        cels: { [frameId]: { imageId: m.imageId, offset: m.offset, opacity: 255 } },
      };
      d.layers.push(layer);
    }
  });
}

/** Opens a new RGBA document: canvas = the largest layer, animation `default` with one frame. */
export async function createSpriteDocument(
  ctx: OpContext,
  opts: {
    readonly name: string;
    readonly layers: readonly NewLayer[];
    readonly palette?: NamedPalette | undefined;
  },
): Promise<{ doc: string; canvas: { w: number; h: number }; store: DocumentStore }> {
  const w = Math.max(...opts.layers.map((l) => l.image.width));
  const h = Math.max(...opts.layers.map((l) => l.image.height));
  // Same id-seed rule as doc.create: from the clock port, bumped while a document with that id is open.
  let seed = Math.abs(ctx.host.clock.now().getTime()) % ID_SPACE;
  for (let i = 0; i < 1000; i++, seed = (seed + 1) % ID_SPACE) {
    if (ctx.host.get(createIdGenerator({ seed, next: 0 }).next('doc')) !== undefined) continue;
    const store = createEmptyDocumentStore([w, h], { name: opts.name, idSeed: seed });
    const tx = store.begin(`AI: ${ctx.op}`);
    try {
      const frameId = tx.newId('frame');
      const animationId = tx.newId('animation');
      const paletteId = opts.palette === undefined ? undefined : tx.newId('palette');
      tx.update((d) => {
        d.animations.push({
          id: animationId,
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
        if (opts.palette !== undefined && paletteId !== undefined) {
          d.palettes.push({
            id: paletteId,
            name: opts.palette.name,
            colors: opts.palette.colors.map((c): RGBA8 => [c[0], c[1], c[2], c[3]]),
            ramps: [],
          });
          d.activePaletteId = paletteId;
        }
      });
      addLayersTx(tx, frameId, opts.layers);
      tx.commit();
      store.clearHistory(); // like doc.create and doc.open: a new document starts with no undo entries
    } catch (e) {
      if (tx.isOpen) tx.cancel();
      throw e;
    }
    const hosted = await ctx.host.adopt({ store });
    return { doc: hosted.id, canvas: { w, h }, store };
  }
  throw new OpError('CONFLICT', 'could not find a free document id', { reason: 'id-seed-taken' });
}

/** Refuses a source image over {@link MAX_SOURCE_PIXELS} pixels. */
export function checkSourceSize(w: number, h: number): void {
  if (w * h > MAX_SOURCE_PIXELS) {
    throw new OpError(
      'REFUSED',
      `the image is ${String(w)}x${String(h)}; at most ${String(MAX_SOURCE_PIXELS)} pixels (4096x4096) are read`,
      { reason: 'too-large' },
    );
  }
}
