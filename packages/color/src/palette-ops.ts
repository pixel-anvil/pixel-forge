/**
 * Pure palette operations. Each returns a new palette and never mutates its input. Operations that
 * change indices also return a `remap` (old index to new index, or `null` if the colour was
 * removed) so callers can fix pixel indices, skins and ramps.
 * @packageDocumentation
 */
import { MAX_PALETTE_COLORS, type Palette, type RGBA8 } from '@pixel-forge/schema';
import { srgb8ToOklab } from './convert.js';
import { packRgba } from './nearest.js';

/** Maps old palette index to new index; `null` when the colour was removed. */
export type IndexRemap = readonly (number | null)[];

/** Result of an index-changing palette operation. */
export interface PaletteEdit {
  /** The new palette (ramps already remapped). */
  readonly palette: Palette;
  /** `remap[oldIndex]` is the new index, or `null` if removed. */
  readonly remap: IndexRemap;
}

/** Result of {@link sortBy}: an edit plus the permutation. */
export interface SortEdit extends PaletteEdit {
  /** `order[newIndex] = oldIndex`. */
  readonly order: readonly number[];
}

/** Applies a remap to one index. Returns `null` for a removed or unknown colour. */
export function remapIndex(remap: IndexRemap, index: number): number | null {
  return remap[index] ?? null;
}

/** Remaps ramps: drops removed indices, drops ramps left empty. */
function remapRamps(ramps: Palette['ramps'], remap: IndexRemap): Palette['ramps'] {
  const out: Palette['ramps'][number][] = [];
  for (const ramp of ramps) {
    const indices: number[] = [];
    for (const i of ramp.indices) {
      const n = remap[i];
      if (n !== null && n !== undefined) indices.push(n);
    }
    if (indices.length > 0) out.push({ ...ramp, indices });
  }
  return out;
}

function identity(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Inserts a colour at `at` (default: append). Later colours shift up by one; ramps follow.
 * @throws RangeError if the palette is full (256) or `at` is outside `0..length`.
 */
export function addColor(palette: Palette, color: RGBA8, at?: number): PaletteEdit {
  const n = palette.colors.length;
  const pos = at ?? n;
  if (n >= MAX_PALETTE_COLORS) throw new RangeError('addColor: palette is full');
  if (!Number.isInteger(pos) || pos < 0 || pos > n) {
    throw new RangeError(`addColor: bad position ${String(pos)}`);
  }
  const colors = [...palette.colors.slice(0, pos), color, ...palette.colors.slice(pos)];
  const remap = identity(n).map((i) => (i >= pos ? i + 1 : i));
  return { palette: { ...palette, colors, ramps: remapRamps(palette.ramps, remap) }, remap };
}

/**
 * Removes the colour at `index`. Later colours shift down; `remap[index]` is `null`. Ramps lose the
 * removed index and a ramp left empty is removed (ramps need at least one index).
 * @throws RangeError for an out-of-range index.
 */
export function removeColor(palette: Palette, index: number): PaletteEdit {
  const n = palette.colors.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) {
    throw new RangeError(`removeColor: bad index ${String(index)}`);
  }
  const colors = palette.colors.filter((_, i) => i !== index);
  const remap: (number | null)[] = identity(n).map((i) =>
    i === index ? null : i > index ? i - 1 : i,
  );
  return { palette: { ...palette, colors, ramps: remapRamps(palette.ramps, remap) }, remap };
}

/**
 * Reorders colours: `order[newIndex] = oldIndex`, a permutation of `0..length-1`.
 * @throws RangeError if `order` is not a permutation.
 */
export function reorder(palette: Palette, order: readonly number[]): PaletteEdit {
  const n = palette.colors.length;
  const valid =
    order.length === n &&
    new Set(order).size === n &&
    order.every((o) => Number.isInteger(o) && o >= 0 && o < n);
  if (!valid) throw new RangeError('reorder: order must be a permutation of the palette indices');
  const colors = order.map((o): RGBA8 => palette.colors[o] ?? [0, 0, 0, 0]);
  const remap: number[] = new Array<number>(n).fill(0);
  order.forEach((oldIndex, newIndex) => {
    remap[oldIndex] = newIndex;
  });
  return { palette: { ...palette, colors, ramps: remapRamps(palette.ramps, remap) }, remap };
}

/**
 * Moves the colour at `from` so it ends at index `to`, shifting the colours between.
 * @throws RangeError for out-of-range indices.
 */
export function moveColor(palette: Palette, from: number, to: number): PaletteEdit {
  const n = palette.colors.length;
  for (const v of [from, to]) {
    if (!Number.isInteger(v) || v < 0 || v >= n) {
      throw new RangeError(`moveColor: bad index ${String(v)}`);
    }
  }
  const order = identity(n);
  order.splice(from, 1);
  order.splice(to, 0, from);
  return reorder(palette, order);
}

/**
 * Replaces the colour at `index`. No index moves, so the remap is the identity and ramps stay.
 * @throws RangeError for an out-of-range index.
 */
export function replaceColor(palette: Palette, index: number, color: RGBA8): PaletteEdit {
  const n = palette.colors.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) {
    throw new RangeError(`replaceColor: bad index ${String(index)}`);
  }
  const colors = palette.colors.map((c, i): RGBA8 => (i === index ? color : c));
  return { palette: { ...palette, colors }, remap: identity(n) };
}

/** Options of {@link insertRamp}. */
export interface InsertRampOptions {
  /** Position of the first new colour (default: append). */
  readonly at?: number;
  /** When given, the new colours are also recorded as a ramp of this name. */
  readonly name?: string;
}

/**
 * Inserts `colors` as one block at `at` (default: append). Later colours shift up by `colors.length`
 * and ramps follow. With `name`, a new ramp listing the block (dark to light as given) is added.
 * @throws RangeError for a bad position, a full palette, no colours, or a ramp name already used.
 */
export function insertRamp(
  palette: Palette,
  colors: readonly RGBA8[],
  options: InsertRampOptions = {},
): PaletteEdit {
  const n = palette.colors.length;
  const pos = options.at ?? n;
  if (colors.length === 0) throw new RangeError('insertRamp: no colours to insert');
  if (n + colors.length > MAX_PALETTE_COLORS) {
    throw new RangeError(
      `insertRamp: ${String(colors.length)} more colours do not fit the palette`,
    );
  }
  if (!Number.isInteger(pos) || pos < 0 || pos > n) {
    throw new RangeError(`insertRamp: bad position ${String(pos)}`);
  }
  if (options.name !== undefined && palette.ramps.some((r) => r.name === options.name)) {
    throw new RangeError(`insertRamp: the palette already has a ramp named ${options.name}`);
  }
  const all = [...palette.colors.slice(0, pos), ...colors, ...palette.colors.slice(pos)];
  const remap = identity(n).map((i) => (i >= pos ? i + colors.length : i));
  const ramps = [...remapRamps(palette.ramps, remap)];
  if (options.name !== undefined) {
    ramps.push({ name: options.name, indices: colors.map((_, i) => pos + i) });
  }
  return { palette: { ...palette, colors: all, ramps }, remap };
}

/** Composes edits applied one after the other into one remap (first edit's indices to the last's). */
export function composeRemaps(first: IndexRemap, second: IndexRemap): IndexRemap {
  return first.map((m) => (m === null ? null : (second[m] ?? null)));
}

/** Sort keys for {@link sortBy}. */
export type SortKey = 'hue' | 'luminance' | 'luma' | 'chroma';

/**
 * A number that grows with the angle of `(a, b)` from the +a axis, counter-clockwise, in `[0, 4)`
 * (the "diamond angle"). It orders like `atan2` but uses only `+ - /`, so it is exact on every platform.
 */
function pseudoAngle(a: number, b: number): number {
  if (b >= 0) return a >= 0 ? b / (a + b) : 1 + -a / (-a + b);
  return a < 0 ? 2 + -b / (-a - b) : 3 + a / (a - b);
}

/**
 * Sorts colours by an OKLab-derived key (stable: ties keep original order).
 * - `luminance`: OKLab L ascending (dark to light).
 * - `luma`: Rec. 709 luma of the 8-bit sRGB values, `2126 R + 7152 G + 722 B` (integers, exact).
 * - `chroma`: OKLCH C ascending, ties by L.
 * - `hue`: near-greys (C < 0.02) first, ordered by L, then chromatic colours by hue ascending
 *   (ties by L). Hue is ordered by a trig-free angle (`pseudoAngle`), so it is platform-exact.
 *
 * Pass `descending` to reverse the key order (ties still keep original order).
 */
export function sortBy(palette: Palette, key: SortKey, descending = false): SortEdit {
  const keyed = palette.colors.map((c, i) => {
    const lab = srgb8ToOklab(c[0], c[1], c[2]);
    const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
    let k1 = lab.L;
    let k2 = 0;
    if (key === 'luma') {
      k1 = 2126 * c[0] + 7152 * c[1] + 722 * c[2];
    } else if (key === 'chroma') {
      k1 = chroma;
      k2 = lab.L;
    } else if (key === 'hue') {
      k1 = chroma < 0.02 ? -1 : pseudoAngle(lab.a, lab.b);
      k2 = lab.L;
    }
    return { i, k1, k2 };
  });
  const sign = descending ? -1 : 1;
  keyed.sort((x, y) => sign * (x.k1 - y.k1) || sign * (x.k2 - y.k2) || x.i - y.i);
  const order = keyed.map((k) => k.i);
  return { ...reorder(palette, order), order };
}

/**
 * Merges colours with identical RGBA, keeping the first occurrence. Duplicates remap to the
 * survivor's new index. Ramps are remapped; an index repeated inside a ramp after merging is kept.
 */
export function dedupe(palette: Palette): PaletteEdit {
  const first = new Map<number, number>();
  const colors: RGBA8[] = [];
  const remap: number[] = [];
  for (const c of palette.colors) {
    const k = packRgba(c);
    let idx = first.get(k);
    if (idx === undefined) {
      idx = colors.length;
      colors.push(c);
      first.set(k, idx);
    }
    remap.push(idx);
  }
  return { palette: { ...palette, colors, ramps: remapRamps(palette.ramps, remap) }, remap };
}
