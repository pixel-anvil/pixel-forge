/**
 * Variant grid (FR-CONV-08): run one base recipe with several parameter sets and lay the results out
 * side by side, so a person (or a model looking at the sheet) can pick the best.
 * @packageDocumentation
 */
import type { RgbaImage } from '@pixel-forge/raster';
import type { RGBA8 } from '@pixel-forge/schema';
import type { DownscaleMethod } from './downscale.js';
import { ConvertError } from './errors.js';
import type { DitherMode } from './quantize.js';
import { runRecipe, validateRecipe } from './recipe.js';
import type { ConvertRecipe, RecipeResult, RunRecipeContext } from './recipe.js';

/** Default cap on the number of variants of one {@link runVariants} call. */
export const DEFAULT_MAX_VARIANTS = 64;
/** Largest cap a caller may ask for. */
export const MAX_VARIANTS_LIMIT = 256;

/** A palette with a name, for the `palette` axis. */
export interface NamedPalette {
  /** Shown in the variant label; unique within the axis. */
  readonly name: string;
  readonly colors: readonly RGBA8[];
}

/**
 * Parameter lists to combine. Every field is optional and, if present, must hold at least one value
 * and no duplicates. The variants are the cartesian product of the lists.
 *
 * Order: the axes run in the fixed order of the fields below (not the order of the object's keys); the
 * last given axis changes fastest, and values keep the order of their list.
 *
 * An axis changes a field of the base recipe, so the base must have that step: `method` and `k` need
 * `downscale`; `palette`, `dither`, `strength` and `spread` need `quantize` (it may be `{}` when the
 * palette comes from the context); `orphanMinSize` needs `cleanup`.
 */
export interface VariantAxes {
  readonly method?: readonly DownscaleMethod[];
  readonly k?: readonly number[];
  readonly palette?: readonly NamedPalette[];
  readonly dither?: readonly DitherMode[];
  readonly strength?: readonly number[];
  readonly spread?: readonly (number | 'auto')[];
  readonly orphanMinSize?: readonly number[];
}

/** Axis names in run order. */
export const VARIANT_AXIS_ORDER = [
  'method',
  'k',
  'palette',
  'dither',
  'strength',
  'spread',
  'orphanMinSize',
] as const;

/** Options of {@link runVariants}. */
export interface RunVariantsOptions extends RunRecipeContext {
  /** Refuse more variants than this; integer 1..{@link MAX_VARIANTS_LIMIT}. Default {@link DEFAULT_MAX_VARIANTS}. */
  readonly maxVariants?: number;
}

/** One variant: its parameters, the recipe that made it and the result. */
export interface VariantResult {
  /** Position in the product, from 0. */
  readonly index: number;
  /** Parameters as `name=value` words in axis order, for example `method=mode dither=bayer4`; `base` when there are no axes. */
  readonly label: string;
  /** The chosen value per axis (a palette is its name). */
  readonly params: Readonly<Record<string, string | number>>;
  /** The full recipe that was run. */
  readonly recipe: ConvertRecipe;
  readonly image: RgbaImage;
  readonly report: RecipeResult['report'];
}

type AxisName = (typeof VARIANT_AXIS_ORDER)[number];
type Step = 'downscale' | 'quantize' | 'cleanup';

/** One value of one axis: what it shows in labels and how it changes a recipe. */
interface Entry {
  readonly shown: string | number;
  readonly patch: (r: ConvertRecipe) => ConvertRecipe;
}

interface Axis {
  readonly name: AxisName;
  /** The recipe step the axis changes; the base recipe must have it. */
  readonly step: Step;
  readonly entries: readonly Entry[];
}

const downscaleWith =
  (patch: { method?: DownscaleMethod; k?: number }) =>
  (r: ConvertRecipe): ConvertRecipe =>
    r.downscale === undefined ? r : { ...r, downscale: { ...r.downscale, ...patch } };

const quantizeWith =
  (patch: {
    palette?: readonly RGBA8[];
    dither?: DitherMode;
    strength?: number;
    spread?: number | 'auto';
  }) =>
  (r: ConvertRecipe): ConvertRecipe =>
    r.quantize === undefined ? r : { ...r, quantize: { ...r.quantize, ...patch } };

const cleanupWith =
  (patch: { orphanMinSize?: number }) =>
  (r: ConvertRecipe): ConvertRecipe =>
    r.cleanup === undefined ? r : { ...r, cleanup: { ...r.cleanup, ...patch } };

/** Checks one axis list (non-empty, no duplicates) and turns it into an {@link Axis}. */
function axis<T>(
  name: AxisName,
  step: Step,
  values: readonly T[] | undefined,
  shown: (v: T) => string | number,
  patch: (v: T) => (r: ConvertRecipe) => ConvertRecipe,
): Axis | undefined {
  if (values === undefined) return undefined;
  const isList: boolean = Array.isArray(values);
  if (!isList || values.length === 0) {
    throw new ConvertError('BAD_AXES', `axis ${name} must be a non-empty list`);
  }
  const entries = values.map((v) => ({ shown: shown(v), patch: patch(v) }));
  if (new Set(entries.map((e) => e.shown)).size !== entries.length) {
    throw new ConvertError('BAD_AXES', `axis ${name} has duplicate values`);
  }
  return { name, step, entries };
}

function paletteName(p: NamedPalette): string {
  if (typeof p !== 'object' || typeof p.name !== 'string' || p.name === '' || /\s/.test(p.name)) {
    throw new ConvertError('BAD_AXES', 'palette axis entries need a name without spaces');
  }
  return p.name;
}

/** The axes of `axes` that are present, in the fixed run order. */
function axesOf(axes: VariantAxes): Axis[] {
  const known: readonly string[] = VARIANT_AXIS_ORDER;
  for (const k of Object.keys(axes)) {
    if (!known.includes(k)) {
      throw new ConvertError(
        'BAD_AXES',
        `unknown axis ${JSON.stringify(k)} (allowed: ${known.join(', ')})`,
      );
    }
  }
  const id = <T extends string | number>(v: T): T => v;
  const list = [
    axis('method', 'downscale', axes.method, id, (v) => downscaleWith({ method: v })),
    axis('k', 'downscale', axes.k, id, (v) => downscaleWith({ k: v })),
    axis('palette', 'quantize', axes.palette, paletteName, (v) =>
      quantizeWith({ palette: v.colors }),
    ),
    axis('dither', 'quantize', axes.dither, id, (v) => quantizeWith({ dither: v })),
    axis('strength', 'quantize', axes.strength, id, (v) => quantizeWith({ strength: v })),
    axis('spread', 'quantize', axes.spread, id, (v) => quantizeWith({ spread: v })),
    axis('orphanMinSize', 'cleanup', axes.orphanMinSize, id, (v) =>
      cleanupWith({ orphanMinSize: v }),
    ),
  ];
  return list.filter((a): a is Axis => a !== undefined);
}

/**
 * Runs `base` once for every combination of `axes` and returns the results in a fixed order (see
 * {@link VariantAxes}). Pure and deterministic. All variants are checked before the first runs: the
 * base recipe, the axes, and the count.
 * @throws ConvertError `BAD_RECIPE` (also for a combination the recipe validator refuses),
 *   `BAD_AXES`, `TOO_MANY_VARIANTS` (more than `maxVariants`; nothing is run), `BAD_OPTION` for a
 *   bad `maxVariants`, and any error of a step
 */
export function runVariants(
  img: RgbaImage,
  base: ConvertRecipe,
  axes: VariantAxes,
  opts: RunVariantsOptions = {},
): VariantResult[] {
  const cap = opts.maxVariants ?? DEFAULT_MAX_VARIANTS;
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_VARIANTS_LIMIT) {
    throw new ConvertError(
      'BAD_OPTION',
      `maxVariants must be an integer 1..${String(MAX_VARIANTS_LIMIT)}`,
    );
  }
  const baseRecipe = validateRecipe(base);
  const list = axesOf(axes);
  let total = 1;
  for (const a of list) {
    total *= a.entries.length;
    if (total > cap) {
      throw new ConvertError(
        'TOO_MANY_VARIANTS',
        `the axes give more than ${String(cap)} variants; use fewer values or a higher maxVariants`,
      );
    }
  }
  for (const a of list) {
    if (baseRecipe[a.step] === undefined) {
      throw new ConvertError(
        'BAD_AXES',
        `axis ${a.name} needs a ${a.step} step in the base recipe`,
      );
    }
  }
  // Build and validate every recipe first, so an error does not come after minutes of work.
  const plan: { recipe: ConvertRecipe; params: Record<string, string | number>; label: string }[] =
    [];
  for (let i = 0; i < total; i++) {
    // mixed-radix digits of i: the last axis changes fastest
    const picks: Entry[] = [];
    let rest = i;
    for (let a = list.length - 1; a >= 0; a--) {
      const entries = list[a]?.entries ?? [];
      const pick = entries[rest % entries.length];
      if (pick !== undefined) picks.unshift(pick);
      rest = Math.floor(rest / entries.length);
    }
    let recipe = baseRecipe;
    const params: Record<string, string | number> = {};
    list.forEach((a, n) => {
      const pick = picks[n];
      if (pick === undefined) return;
      recipe = pick.patch(recipe);
      params[a.name] = pick.shown;
    });
    const label =
      list.length === 0 ? 'base' : list.map((a) => `${a.name}=${String(params[a.name])}`).join(' ');
    plan.push({ recipe: validateRecipe(recipe), params, label });
  }
  const ctx: RunRecipeContext = opts.palette === undefined ? {} : { palette: opts.palette };
  return plan.map((p, index) => {
    const { image, report } = runRecipe(img, p.recipe, ctx);
    return { index, label: p.label, params: p.params, recipe: p.recipe, image, report };
  });
}

/** Options of {@link variantSheet}. */
export interface VariantSheetOptions {
  /** Tiles per row, integer >= 1. Default `ceil(sqrt(count))`. */
  readonly columns?: number;
  /** Space between tiles and around the sheet, in pixels, integer >= 0. Default 2. */
  readonly gap?: number;
  /** Colour of the gaps and the space around small tiles. Default transparent `[0,0,0,0]`. */
  readonly background?: RGBA8;
}

/** Where one tile sits on the sheet. */
export interface SheetTile {
  readonly index: number;
  readonly label: string;
  /** Top-left of the image on the sheet. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Result of {@link variantSheet}. */
export interface VariantSheet {
  readonly image: RgbaImage;
  readonly columns: number;
  readonly rows: number;
  /** Size of one cell: the largest result in each direction. */
  readonly cell: { readonly w: number; readonly h: number };
  /** One entry per result, in order, so a caller can draw the labels. */
  readonly tiles: readonly SheetTile[];
}

/** Largest sheet side accepted, in pixels. */
export const MAX_SHEET_SIDE = 16384;

/**
 * Composes variant results into one contact sheet, row by row, left to right. Each image sits in a
 * cell as large as the biggest image, centred (the extra space is split, the smaller half first), on
 * `background`. Images are copied as they are (no blending, no scaling): scale the sheet with
 * `scaleInt` to look at it. There are no labels in the pixels; `tiles` says where each one is. Pure.
 * @throws ConvertError `BAD_OPTION` for no results, a bad `columns`, `gap` or `background`, or a sheet
 *   over {@link MAX_SHEET_SIDE} pixels on a side; `BAD_IMAGE` for a malformed image
 */
export function variantSheet(
  results: readonly Pick<VariantResult, 'index' | 'label' | 'image'>[],
  opts: VariantSheetOptions = {},
): VariantSheet {
  if (results.length === 0)
    throw new ConvertError('BAD_OPTION', 'variantSheet needs at least one result');
  const columns = opts.columns ?? Math.ceil(Math.sqrt(results.length));
  const gap = opts.gap ?? 2;
  if (!Number.isInteger(columns) || columns < 1) {
    throw new ConvertError('BAD_OPTION', 'columns must be an integer >= 1');
  }
  if (!Number.isInteger(gap) || gap < 0) {
    throw new ConvertError('BAD_OPTION', 'gap must be an integer >= 0');
  }
  const bg = opts.background ?? [0, 0, 0, 0];
  if (
    (bg as readonly number[]).length !== 4 ||
    !bg.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
  ) {
    throw new ConvertError('BAD_OPTION', 'background must be [r,g,b,a] integers 0..255');
  }
  let cw = 0;
  let ch = 0;
  for (const r of results) {
    const im = r.image;
    if (im.data.length !== im.width * im.height * 4 || im.width < 1 || im.height < 1) {
      throw new ConvertError('BAD_IMAGE', 'variant image is malformed');
    }
    cw = Math.max(cw, im.width);
    ch = Math.max(ch, im.height);
  }
  const cols = Math.min(columns, results.length);
  const rows = Math.ceil(results.length / cols);
  const W = gap + cols * (cw + gap);
  const H = gap + rows * (ch + gap);
  if (W > MAX_SHEET_SIDE || H > MAX_SHEET_SIDE) {
    throw new ConvertError(
      'BAD_OPTION',
      `the sheet would be ${String(W)}x${String(H)}, the limit is ${String(MAX_SHEET_SIDE)} per side`,
    );
  }
  const data = new Uint8Array(W * H * 4);
  if (bg.some((v) => v !== 0)) for (let p = 0; p < W * H; p++) data.set(bg, p * 4);
  const tiles: SheetTile[] = [];
  results.forEach((r, i) => {
    const im = r.image;
    const x = gap + (i % cols) * (cw + gap) + Math.floor((cw - im.width) / 2);
    const y = gap + Math.floor(i / cols) * (ch + gap) + Math.floor((ch - im.height) / 2);
    for (let row = 0; row < im.height; row++) {
      data.set(
        im.data.subarray(row * im.width * 4, (row + 1) * im.width * 4),
        ((y + row) * W + x) * 4,
      );
    }
    tiles.push({ index: r.index, label: r.label, x, y, w: im.width, h: im.height });
  });
  return {
    image: { width: W, height: H, data },
    columns: cols,
    rows,
    cell: { w: cw, h: ch },
    tiles,
  };
}
