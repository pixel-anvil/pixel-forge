/**
 * Mapping tables for palette remaps (FR-PAL-05): the pure part, shared by `palette.remap` and by
 * skins whose `map` is an index table (FR-PAL-07). Nothing here touches a document.
 *
 * A mapping applies **at once**, not in sequence: `[[1, 2], [2, 1]]` swaps two entries. Pixels
 * whose index or colour is not listed stay as they are.
 * @packageDocumentation
 */
import type { RGBA8 } from '@pixel-forge/schema';
import { packRgba } from './nearest.js';

/** One `[from, to]` pair of palette indices. */
export type IndexPair = readonly [from: number, to: number];

/** One `[from, to]` pair of exact colours. */
export type ColorPair = readonly [from: RGBA8, to: RGBA8];

/**
 * A 256-entry lookup table from a list of index pairs: `lut[i]` is the new index of index `i`
 * (identity for unlisted indices).
 * @param size palette length: every index in a pair must be below it.
 * @throws RangeError for a non-integer or out-of-range index, or two pairs with the same `from`.
 */
export function indexLut(pairs: readonly IndexPair[], size: number): Uint8Array {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = i;
  const seen = new Set<number>();
  for (const [from, to] of pairs) {
    for (const v of [from, to]) {
      if (!Number.isInteger(v) || v < 0 || v >= size || v > 255) {
        throw new RangeError(`index ${String(v)} is outside the palette (0..${String(size - 1)})`);
      }
    }
    if (seen.has(from)) throw new RangeError(`index ${String(from)} is mapped twice`);
    seen.add(from);
    lut[from] = to;
  }
  return lut;
}

/**
 * A colour table keyed by packed RGBA (see `packRgba`), the value being the new colour.
 * @throws RangeError when a colour has alpha 0 (transparent stays transparent) or is listed twice.
 */
export function colorTable(pairs: readonly ColorPair[]): Map<number, RGBA8> {
  const table = new Map<number, RGBA8>();
  for (const [from, to] of pairs) {
    if (from[3] === 0 || to[3] === 0) {
      throw new RangeError('transparent colours (alpha 0) cannot be mapped');
    }
    const key = packRgba(from);
    if (table.has(key)) throw new RangeError(`colour ${String(key)} is mapped twice`);
    table.set(key, [to[0], to[1], to[2], to[3]]);
  }
  return table;
}

/**
 * The colour pairs of a palette swap: entry `i` of `from` becomes entry `i` of `to`. Alpha-0
 * entries and entries that do not change are left out.
 * @throws RangeError when the lengths differ, when one old colour is listed twice with different
 *   new colours (the swap would be ambiguous in RGBA pixels), or when an alpha-0 entry does not
 *   stay alpha 0 (or the other way round), because transparent pixels must stay transparent.
 */
export function swapPairs(from: readonly RGBA8[], to: readonly RGBA8[]): ColorPair[] {
  if (from.length !== to.length) {
    throw new RangeError(
      `palettes differ in length (${String(from.length)} and ${String(to.length)})`,
    );
  }
  const out = new Map<number, ColorPair>();
  from.forEach((a, i) => {
    const b = to[i];
    if (b === undefined) return;
    if ((a[3] === 0) !== (b[3] === 0)) {
      throw new RangeError(`entry ${String(i)}: transparency must stay in the same entries`);
    }
    if (a[3] === 0 || packRgba(a) === packRgba(b)) return;
    const key = packRgba(a);
    const prior = out.get(key);
    if (prior !== undefined && packRgba(prior[1]) !== packRgba(b)) {
      throw new RangeError(
        `entry ${String(i)}: the same colour is listed twice with different replacements`,
      );
    }
    out.set(key, [a, b]);
  });
  return [...out.values()];
}

/**
 * Applies `lut` to `indices` in place, skipping pixels equal to `keep` (the transparent index).
 * @returns the number of pixels that changed.
 */
export function applyIndexLut(indices: Uint8Array, lut: Uint8Array, keep: number): number {
  let changed = 0;
  for (let p = 0; p < indices.length; p++) {
    const v = indices[p] ?? 0;
    if (v === keep) continue;
    const n = lut[v] ?? v;
    if (n !== v) {
      indices[p] = n;
      changed++;
    }
  }
  return changed;
}

/**
 * Applies a {@link colorTable} to dense straight RGBA bytes in place. Pixels with alpha 0 never match.
 * @returns the number of pixels that changed.
 */
export function applyColorTable(rgba: Uint8Array, table: ReadonlyMap<number, RGBA8>): number {
  let changed = 0;
  for (let o = 0; o + 3 < rgba.length; o += 4) {
    const a = rgba[o + 3] ?? 0;
    if (a === 0) continue;
    const to = table.get(
      (((rgba[o] ?? 0) << 24) | ((rgba[o + 1] ?? 0) << 16) | ((rgba[o + 2] ?? 0) << 8) | a) >>> 0,
    );
    if (to === undefined) continue;
    rgba[o] = to[0];
    rgba[o + 1] = to[1];
    rgba[o + 2] = to[2];
    rgba[o + 3] = to[3];
    changed++;
  }
  return changed;
}
