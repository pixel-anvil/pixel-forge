/**
 * `ConvertRecipe` (FR-CONV-09): the whole image-to-sprite pipeline as plain JSON, and the runner.
 *
 * Step order is fixed: crop, background, downscale (size target, explicit grid or detected grid),
 * cleanup, quantise (with dither). Each step is optional; an absent step is skipped. The recipe holds
 * one `alphaThreshold` that `downscale`, `cleanup` and `quantize` all use, so "visible" means the same
 * thing in every step.
 *
 * Outline colours are chosen before quantising, so with a `quantize` step a fixed outline colour or a
 * darkened colour is snapped to the nearest palette colour like every other pixel.
 *
 * Flood over transparent pixels (E4.1 doubt, decided here): `background: {mode: 'flood'}` treats pixels
 * that are already fully transparent as part of the background. A flood therefore passes through an
 * existing transparent border into matching colour behind it, and `color: 'auto'` ignores transparent
 * corners. A recipe that must not do that uses `key`, or removes the background in a separate pass.
 * @packageDocumentation
 */
import type { RgbaImage } from '@pixel-forge/raster';
import type { RGBA8 } from '@pixel-forge/schema';
import { MAX_RGB_TOLERANCE, removeBackground } from './background.js';
import type { BackgroundOptions, RgbTriple } from './background.js';
import { cleanup } from './cleanup.js';
import type { CleanupOptions, CleanupOutline } from './cleanup.js';
import { assertImage, cropImage } from './crop.js';
import type { CropOptions } from './crop.js';
import { DOWNSCALE_METHODS, MAX_KCENTROID_K, downscale } from './downscale.js';
import type { DownscaleMethod } from './downscale.js';
import { ConvertError } from './errors.js';
import { MAX_GRID_CELL, detectGrid } from './grid.js';
import type { DetectGridOptions, GridDetection, GridSpec } from './grid.js';
import {
  DEFAULT_ALPHA_THRESHOLD,
  MAX_QUANTIZE_COLORS,
  autoDitherSpread,
  colorsOf,
  quantize,
} from './quantize.js';
import type { DitherMode } from './quantize.js';

/** The recipe format version this package reads and writes. */
export const RECIPE_VERSION = 1;

const DITHER_MODES: readonly DitherMode[] = [
  'none',
  'bayer2',
  'bayer4',
  'bayer8',
  'floyd-steinberg',
];

/** The downscale step of a recipe: a method and exactly one target. */
export interface RecipeDownscale {
  /** How each cell becomes one pixel. Required: there is no hidden default. */
  readonly method: DownscaleMethod;
  /** Size target, 1..source width. Alone, the height keeps the aspect. Not with `grid`. */
  readonly width?: number;
  /** Size target, 1..source height. Alone, the width keeps the aspect. Not with `grid`. */
  readonly height?: number;
  /** Grid target: `'auto'` runs `detectGrid` on the image at this point, or an explicit cell size and phase. Not with `width` or `height`. */
  readonly grid?: 'auto' | GridSpec;
  /** `grid: 'auto'` only: options of `detectGrid`. */
  readonly detect?: DetectGridOptions;
  /** `grid` targets: partial cells at the edge, see `downscale`. Default `'keep'`. */
  readonly edges?: 'keep' | 'drop';
  /** `kcentroid` only: clusters per cell, 1..8. Default 2. */
  readonly k?: number;
  /** `grid: 'auto'` only: when no grid is found, `'error'` (default) throws `NO_GRID`; `'skip'` leaves the image as it is and goes on (for art that is already at pixel size). */
  readonly onNoGrid?: 'error' | 'skip';
}

/** The quantise step of a recipe. */
export interface RecipeQuantize {
  /** Palette used by this recipe. Absent: the palette given to {@link runRecipe} in its context. */
  readonly palette?: readonly RGBA8[];
  /** Dither mode. Default `'none'`. */
  readonly dither?: DitherMode;
  /** Dither strength 0..1. Default 1. */
  readonly strength?: number;
  /** Ordered dither spread (see `quantize`), or `'auto'` (default): derived from the palette by {@link autoDitherSpread}. */
  readonly spread?: number | 'auto';
}

/** The clean-up step of a recipe: {@link CleanupOptions} without the threshold, which the recipe owns. */
export type RecipeCleanup = Omit<CleanupOptions, 'alphaThreshold'>;

/**
 * An image-to-sprite pipeline as JSON-serialisable data (no functions, no typed arrays, no `undefined`
 * needed). Check an untrusted value with {@link validateRecipe}.
 */
export interface ConvertRecipe {
  /** Format version; must be {@link RECIPE_VERSION} (1). */
  readonly version: 1;
  /** The one alpha threshold of the pipeline, integer 1..255. Default 128. */
  readonly alphaThreshold?: number;
  /** Crop to a rectangle of the source. */
  readonly crop?: CropOptions;
  /** Background removal. */
  readonly background?: BackgroundOptions;
  /** Downscale by size or grid. */
  readonly downscale?: RecipeDownscale;
  /** Clean-up. `{}` runs it with the defaults. */
  readonly cleanup?: RecipeCleanup;
  /** Quantise and dither. */
  readonly quantize?: RecipeQuantize;
}

/** Context of {@link runRecipe}: data that cannot live in the recipe. */
export interface RunRecipeContext {
  /** Palette for a `quantize` step without its own `palette` (for example the active palette of a document). */
  readonly palette?: readonly RGBA8[] | { readonly colors: readonly RGBA8[] };
}

/** Names of the steps in run order. */
export type RecipeStepName = 'crop' | 'background' | 'downscale' | 'cleanup' | 'quantize';

/** Size after one step. */
export interface StepReport {
  readonly step: RecipeStepName;
  /** Output width of the step. */
  readonly width: number;
  /** Output height of the step. */
  readonly height: number;
  /** Short remark, for example why a step did nothing. */
  readonly note?: string;
}

/** What {@link runRecipe} did. Everything is plain data except `indices`. */
export interface RecipeReport {
  /** Input size. */
  readonly input: { readonly width: number; readonly height: number };
  /** One entry per step that ran, in order. */
  readonly steps: readonly StepReport[];
  /** Result of `detectGrid`, when the recipe asked for `grid: 'auto'`. */
  readonly detection?: GridDetection;
  /** The grid the downscale step used (detected or explicit). */
  readonly grid?: GridSpec;
  /** Clean-up counts and where the input origin sits in the result. */
  readonly cleanup?: {
    readonly removedPixels: number;
    readonly outlinePixels: number;
    readonly offset: { readonly x: number; readonly y: number };
  };
  /** Number of colours in the palette used. */
  readonly paletteSize?: number;
  /** The ordered-dither spread used (only for `bayer*` modes). */
  readonly ditherSpread?: number;
  /** Palette index per pixel of the result (-1 transparent), when the recipe quantised. Not JSON. */
  readonly indices?: Int16Array;
}

/** Output of {@link runRecipe}. */
export interface RecipeResult {
  readonly image: RgbaImage;
  readonly report: RecipeReport;
}

// ---------------------------------------------------------------------------------------------
// validation

type Obj = Record<string, unknown>;

function fail(path: string, msg: string): never {
  throw new ConvertError('BAD_RECIPE', `${path}: ${msg}`);
}

/** `v` must be a plain object whose keys are all in `keys`. */
function obj(v: unknown, path: string, keys: readonly string[]): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object');
  const o = v as Obj;
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) fail(`${path}.${k}`, `unknown key (allowed: ${keys.join(', ')})`);
  }
  return o;
}

function int(v: unknown, path: string, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
    fail(path, `must be an integer ${String(lo)}..${String(hi)}`);
  }
  return v;
}

function num(v: unknown, path: string, lo: number, hi: number, loOpen = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || (loOpen ? v <= lo : v < lo) || v > hi) {
    fail(path, `must be a number ${loOpen ? '>' : '>='} ${String(lo)} and <= ${String(hi)}`);
  }
  return v;
}

function oneOf<T extends string>(v: unknown, path: string, list: readonly T[]): T {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) {
    fail(path, `must be one of ${list.map((x) => JSON.stringify(x)).join(', ')}`);
  }
  return v as T;
}

function triple(v: unknown, path: string): RgbTriple {
  if (!Array.isArray(v) || v.length !== 3) fail(path, 'must be [r,g,b]');
  const a = v as unknown[];
  return [
    int(a[0], `${path}[0]`, 0, 255),
    int(a[1], `${path}[1]`, 0, 255),
    int(a[2], `${path}[2]`, 0, 255),
  ];
}

function rgba(v: unknown, path: string): RGBA8 {
  if (!Array.isArray(v) || v.length !== 4) fail(path, 'must be [r,g,b,a]');
  const a = v as unknown[];
  return [
    int(a[0], `${path}[0]`, 0, 255),
    int(a[1], `${path}[1]`, 0, 255),
    int(a[2], `${path}[2]`, 0, 255),
    int(a[3], `${path}[3]`, 0, 255),
  ];
}

function has(o: Obj, k: string): boolean {
  return o[k] !== undefined;
}

function checkCrop(v: unknown, path: string): CropOptions {
  const o = obj(v, path, ['x', 'y', 'w', 'h']);
  for (const k of ['x', 'y', 'w', 'h']) if (!has(o, k)) fail(`${path}.${k}`, 'is required');
  return {
    x: int(o.x, `${path}.x`, 0, Number.MAX_SAFE_INTEGER),
    y: int(o.y, `${path}.y`, 0, Number.MAX_SAFE_INTEGER),
    w: int(o.w, `${path}.w`, 1, Number.MAX_SAFE_INTEGER),
    h: int(o.h, `${path}.h`, 1, Number.MAX_SAFE_INTEGER),
  };
}

function checkBackground(v: unknown, path: string): BackgroundOptions {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object');
  const mode = oneOf((v as Obj).mode, `${path}.mode`, ['none', 'key', 'flood', 'alpha']);
  if (mode === 'none') {
    obj(v, path, ['mode']);
    return { mode };
  }
  if (mode === 'alpha') {
    const o = obj(v, path, ['mode', 'threshold']);
    return has(o, 'threshold')
      ? { mode, threshold: int(o.threshold, `${path}.threshold`, 0, 255) }
      : { mode };
  }
  const o = obj(v, path, ['mode', 'color', 'tolerance']);
  const out: { mode: 'key' | 'flood'; color?: RgbTriple | 'auto'; tolerance?: number } = { mode };
  if (has(o, 'color')) out.color = o.color === 'auto' ? 'auto' : triple(o.color, `${path}.color`);
  if (has(o, 'tolerance'))
    out.tolerance = num(o.tolerance, `${path}.tolerance`, 0, MAX_RGB_TOLERANCE);
  return out;
}

function checkGridSpec(v: unknown, path: string): GridSpec {
  const o = obj(v, path, ['cellWidth', 'cellHeight', 'offsetX', 'offsetY']);
  for (const k of ['cellWidth', 'cellHeight', 'offsetX', 'offsetY']) {
    if (!has(o, k)) fail(`${path}.${k}`, 'is required');
  }
  const cellWidth = int(o.cellWidth, `${path}.cellWidth`, 1, MAX_GRID_CELL);
  const cellHeight = int(o.cellHeight, `${path}.cellHeight`, 1, MAX_GRID_CELL);
  return {
    cellWidth,
    cellHeight,
    offsetX: int(o.offsetX, `${path}.offsetX`, 0, cellWidth - 1),
    offsetY: int(o.offsetY, `${path}.offsetY`, 0, cellHeight - 1),
  };
}

function checkDetect(v: unknown, path: string): DetectGridOptions {
  const o = obj(v, path, ['maxCell', 'minConfidence', 'noiseFloor', 'square']);
  const out: {
    maxCell?: number;
    minConfidence?: number;
    noiseFloor?: number;
    square?: boolean;
  } = {};
  if (has(o, 'maxCell')) out.maxCell = int(o.maxCell, `${path}.maxCell`, 2, MAX_GRID_CELL);
  if (has(o, 'minConfidence')) {
    out.minConfidence = num(o.minConfidence, `${path}.minConfidence`, 0, 1, true);
  }
  if (has(o, 'noiseFloor')) out.noiseFloor = int(o.noiseFloor, `${path}.noiseFloor`, 0, 1020);
  if (has(o, 'square')) {
    if (typeof o.square !== 'boolean') fail(`${path}.square`, 'must be a boolean');
    out.square = o.square;
  }
  return out;
}

function checkDownscale(v: unknown, path: string): RecipeDownscale {
  const o = obj(v, path, ['method', 'width', 'height', 'grid', 'detect', 'edges', 'k', 'onNoGrid']);
  if (!has(o, 'method')) fail(`${path}.method`, 'is required');
  const method = oneOf(o.method, `${path}.method`, DOWNSCALE_METHODS);
  const size = has(o, 'width') || has(o, 'height');
  if (size === has(o, 'grid')) {
    fail(path, 'needs exactly one target: width and/or height, or grid');
  }
  const out: {
    -readonly [K in keyof RecipeDownscale]: RecipeDownscale[K];
  } = { method };
  if (has(o, 'width')) out.width = int(o.width, `${path}.width`, 1, Number.MAX_SAFE_INTEGER);
  if (has(o, 'height')) out.height = int(o.height, `${path}.height`, 1, Number.MAX_SAFE_INTEGER);
  if (has(o, 'grid')) {
    out.grid = o.grid === 'auto' ? 'auto' : checkGridSpec(o.grid, `${path}.grid`);
  }
  if (has(o, 'detect')) {
    if (o.grid !== 'auto') fail(`${path}.detect`, `is only allowed with grid: 'auto'`);
    out.detect = checkDetect(o.detect, `${path}.detect`);
  }
  if (has(o, 'onNoGrid')) {
    if (o.grid !== 'auto') fail(`${path}.onNoGrid`, `is only allowed with grid: 'auto'`);
    out.onNoGrid = oneOf(o.onNoGrid, `${path}.onNoGrid`, ['error', 'skip']);
  }
  if (has(o, 'edges')) {
    if (!has(o, 'grid')) fail(`${path}.edges`, 'is only allowed with a grid target');
    out.edges = oneOf(o.edges, `${path}.edges`, ['keep', 'drop']);
  }
  if (has(o, 'k')) out.k = int(o.k, `${path}.k`, 1, MAX_KCENTROID_K);
  return out;
}

function checkOutline(v: unknown, path: string): CleanupOutline {
  const o = obj(v, path, ['color', 'shade', 'corners', 'canvas']);
  const out: { -readonly [K in keyof CleanupOutline]: CleanupOutline[K] } = {};
  if (has(o, 'color'))
    out.color = o.color === 'darken' ? 'darken' : triple(o.color, `${path}.color`);
  if (has(o, 'shade')) out.shade = int(o.shade, `${path}.shade`, 0, 100);
  if (has(o, 'corners')) out.corners = oneOf(o.corners, `${path}.corners`, ['round', 'square']);
  if (has(o, 'canvas')) out.canvas = oneOf(o.canvas, `${path}.canvas`, ['grow', 'keep']);
  return out;
}

function checkCleanup(v: unknown, path: string): RecipeCleanup {
  const o = obj(v, path, ['orphanMinSize', 'connectivity', 'outline']);
  const out: { -readonly [K in keyof RecipeCleanup]: RecipeCleanup[K] } = {};
  if (has(o, 'orphanMinSize')) {
    out.orphanMinSize = int(o.orphanMinSize, `${path}.orphanMinSize`, 1, Number.MAX_SAFE_INTEGER);
  }
  if (has(o, 'connectivity')) {
    const c = o.connectivity;
    if (c !== 4 && c !== 8) fail(`${path}.connectivity`, 'must be 4 or 8');
    out.connectivity = c;
  }
  if (has(o, 'outline')) out.outline = checkOutline(o.outline, `${path}.outline`);
  return out;
}

function checkQuantize(v: unknown, path: string): RecipeQuantize {
  const o = obj(v, path, ['palette', 'dither', 'strength', 'spread']);
  const out: { -readonly [K in keyof RecipeQuantize]: RecipeQuantize[K] } = {};
  if (has(o, 'palette')) {
    const p = o.palette;
    if (!Array.isArray(p) || p.length < 1 || p.length > MAX_QUANTIZE_COLORS) {
      fail(
        `${path}.palette`,
        `must be a list of 1..${String(MAX_QUANTIZE_COLORS)} [r,g,b,a] colours`,
      );
    }
    out.palette = (p as unknown[]).map((c, i) => rgba(c, `${path}.palette[${String(i)}]`));
  }
  if (has(o, 'dither')) out.dither = oneOf(o.dither, `${path}.dither`, DITHER_MODES);
  if (has(o, 'strength')) out.strength = num(o.strength, `${path}.strength`, 0, 1);
  if (has(o, 'spread')) {
    out.spread =
      o.spread === 'auto' ? 'auto' : num(o.spread, `${path}.spread`, 0, Number.MAX_VALUE, true);
  }
  return out;
}

/**
 * Checks an untrusted value (for example parsed JSON) and returns a clean copy typed as
 * {@link ConvertRecipe}. Strict: an unknown key at any level, a wrong type, an out-of-range number,
 * a missing `version` or a `version` other than 1 is refused. Bounds that depend on the image
 * (crop rectangle, target size larger than the source) are checked when the recipe runs.
 * @throws ConvertError `BAD_RECIPE`, with the path of the offending field in the message
 */
export function validateRecipe(value: unknown): ConvertRecipe {
  const o = obj(value, 'recipe', [
    'version',
    'alphaThreshold',
    'crop',
    'background',
    'downscale',
    'cleanup',
    'quantize',
  ]);
  if (o.version !== RECIPE_VERSION) {
    fail('recipe.version', `must be ${String(RECIPE_VERSION)}`);
  }
  const out: { -readonly [K in keyof ConvertRecipe]: ConvertRecipe[K] } = { version: 1 };
  if (has(o, 'alphaThreshold')) {
    out.alphaThreshold = int(o.alphaThreshold, 'recipe.alphaThreshold', 1, 255);
  }
  if (has(o, 'crop')) out.crop = checkCrop(o.crop, 'recipe.crop');
  if (has(o, 'background')) out.background = checkBackground(o.background, 'recipe.background');
  if (has(o, 'downscale')) out.downscale = checkDownscale(o.downscale, 'recipe.downscale');
  if (has(o, 'cleanup')) out.cleanup = checkCleanup(o.cleanup, 'recipe.cleanup');
  if (has(o, 'quantize')) out.quantize = checkQuantize(o.quantize, 'recipe.quantize');
  return out;
}

// ---------------------------------------------------------------------------------------------
// runner

/**
 * Runs a recipe on `img`: crop, background, downscale, cleanup, quantise, each only if the recipe has
 * it. Pure and deterministic; the input is not changed. The recipe is validated first (see
 * {@link validateRecipe}), so a recipe parsed from JSON can be passed as it is.
 *
 * - `downscale.grid: 'auto'` runs `detectGrid` on the image as it is after background removal.
 *   Found: its cells are used. Not found: `NO_GRID` is thrown, or with `onNoGrid: 'skip'` the step is
 *   skipped (the report says why).
 * - `quantize` uses its own palette, else `ctx.palette`; with neither it throws `BAD_PALETTE`.
 *   `spread: 'auto'` (default) is {@link autoDitherSpread} of that palette.
 * - One `alphaThreshold` is passed to `downscale`, `cleanup` and `quantize`.
 *
 * @throws ConvertError `BAD_RECIPE`, `NO_GRID`, and any error of a step (`BAD_RECT`, `BAD_OPTION`,
 *   `BAD_PALETTE`, `BAD_IMAGE`)
 */
export function runRecipe(
  img: RgbaImage,
  recipe: ConvertRecipe,
  ctx: RunRecipeContext = {},
): RecipeResult {
  assertImage(img);
  const r = validateRecipe(recipe);
  const alphaThreshold = r.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
  const steps: StepReport[] = [];
  const note = (step: RecipeStepName, im: RgbaImage, remark?: string): void => {
    steps.push(
      remark === undefined
        ? { step, width: im.width, height: im.height }
        : { step, width: im.width, height: im.height, note: remark },
    );
  };
  let cur = img;
  let detection: GridDetection | undefined;
  let grid: GridSpec | undefined;
  let cleanupInfo: RecipeReport['cleanup'];
  let paletteSize: number | undefined;
  let ditherSpread: number | undefined;
  let indices: Int16Array | undefined;

  if (r.crop !== undefined) {
    cur = cropImage(cur, r.crop);
    note('crop', cur);
  }
  if (r.background !== undefined) {
    cur = removeBackground(cur, r.background);
    note('background', cur);
  }
  if (r.downscale !== undefined) {
    const d = r.downscale;
    let target: GridSpec | undefined;
    let skipped: string | undefined;
    if (d.grid === 'auto') {
      detection = detectGrid(cur, d.detect);
      if (detection.found) {
        target = detection;
      } else if (d.onNoGrid === 'skip') {
        skipped = `no grid (${detection.reason}), step skipped`;
      } else {
        throw new ConvertError(
          'NO_GRID',
          `no pixel grid found (${detection.reason}); use a size target or onNoGrid: 'skip'`,
        );
      }
    } else if (d.grid !== undefined) {
      target = d.grid;
    }
    if (skipped === undefined) {
      grid =
        target === undefined
          ? undefined
          : {
              cellWidth: target.cellWidth,
              cellHeight: target.cellHeight,
              offsetX: target.offsetX,
              offsetY: target.offsetY,
            };
      cur = downscale(cur, {
        method: d.method,
        ...(d.width !== undefined ? { width: d.width } : {}),
        ...(d.height !== undefined ? { height: d.height } : {}),
        ...(grid !== undefined ? { grid } : {}),
        ...(d.edges !== undefined ? { edges: d.edges } : {}),
        ...(d.k !== undefined ? { k: d.k } : {}),
        alphaThreshold,
      });
      note('downscale', cur);
    } else {
      note('downscale', cur, skipped);
    }
  }
  if (r.cleanup !== undefined) {
    const c = cleanup(cur, { ...r.cleanup, alphaThreshold });
    cur = c.image;
    cleanupInfo = {
      removedPixels: c.removedPixels,
      outlinePixels: c.outlinePixels,
      offset: c.offset,
    };
    note('cleanup', cur);
  }
  if (r.quantize !== undefined) {
    const q = r.quantize;
    const source = q.palette ?? ctx.palette;
    if (source === undefined) {
      throw new ConvertError(
        'BAD_PALETTE',
        'the recipe quantises but has no palette and none was given to runRecipe',
      );
    }
    const colors = colorsOf(source);
    const mode = q.dither ?? 'none';
    const spread =
      q.spread === undefined || q.spread === 'auto' ? autoDitherSpread(colors) : q.spread;
    const res = quantize(cur, colors, {
      dither: mode,
      ...(q.strength !== undefined ? { strength: q.strength } : {}),
      spread,
      alphaThreshold,
    });
    cur = res.image;
    indices = res.indices;
    paletteSize = colors.length;
    if (mode.startsWith('bayer')) ditherSpread = spread;
    note('quantize', cur);
  }

  return {
    // an empty recipe still returns a new image, never the caller's own
    image: cur === img ? { width: img.width, height: img.height, data: img.data.slice() } : cur,
    report: {
      input: { width: img.width, height: img.height },
      steps,
      ...(detection !== undefined ? { detection } : {}),
      ...(grid !== undefined ? { grid } : {}),
      ...(cleanupInfo !== undefined ? { cleanup: cleanupInfo } : {}),
      ...(paletteSize !== undefined ? { paletteSize } : {}),
      ...(ditherSpread !== undefined ? { ditherSpread } : {}),
      ...(indices !== undefined ? { indices } : {}),
    },
  };
}
