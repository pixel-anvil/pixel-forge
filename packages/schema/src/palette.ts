/**
 * Palettes, ramps and skins (spec 3.1, FR-PAL-06/07).
 * @packageDocumentation
 */
import { z } from 'zod';
import { MAX_PALETTE_COLORS } from './constants.js';
import { PaletteId, SkinId } from './ids.js';
import { DisplayName, Name, PaletteIndex, RGBA8, SkinName } from './primitives.js';

/** A named, ordered list of palette indices, e.g. `skin: [3, 4, 5, 6, 7]` (dark to light by convention). */
export const Ramp = z.strictObject({
  name: Name,
  indices: z.array(PaletteIndex).min(1),
});
/** A named, ordered list of palette indices. */
export type Ramp = z.infer<typeof Ramp>;

/**
 * Ordered RGBA8 colours plus ramps. In indexed mode a pixel stores its colour's index, and a colour
 * with alpha 0 is how an index is transparent.
 */
export const Palette = z.strictObject({
  id: PaletteId,
  /** Display name, free text (e.g. a preset's published name). */
  name: DisplayName,
  colors: z.array(RGBA8).max(MAX_PALETTE_COLORS),
  /** Ramps in display order; names unique within the palette (checked by `validate()`). */
  ramps: z.array(Ramp),
});
/** Ordered RGBA8 colours plus ramps. */
export type Palette = z.infer<typeof Palette>;

/** One `[fromIndex, toIndex]` pair of a skin remap. */
export const RemapPair = z.tuple([PaletteIndex, PaletteIndex]);
/** One `[fromIndex, toIndex]` pair of a skin remap. */
export type RemapPair = z.infer<typeof RemapPair>;

const ascendingSources = (pairs: readonly RemapPair[]): boolean =>
  pairs.every((pair, i) => i === 0 || (pairs[i - 1]?.[0] ?? -1) < pair[0]);

const noIdentityPairs = (pairs: readonly RemapPair[]): boolean =>
  pairs.every(([from, to]) => from !== to);

/**
 * A skin that remaps palette indices of the active palette. Pairs are sorted by `fromIndex` with no
 * duplicates and no identity pairs (`[n, n]`), so each remap has one canonical form; unlisted
 * indices map to themselves.
 */
export const RemapSkin = z.strictObject({
  id: SkinId,
  name: SkinName,
  remap: z
    .array(RemapPair)
    .refine(ascendingSources, 'remap pairs must be sorted by source index, without duplicates')
    .refine(noIdentityPairs, 'remap pairs must change the index: omit identity pairs [n, n]'),
});
/** A skin that remaps palette indices. */
export type RemapSkin = z.infer<typeof RemapSkin>;

/** A skin that renders with another palette, index for index (team kits). */
export const PaletteSkin = z.strictObject({
  id: SkinId,
  name: SkinName,
  paletteId: PaletteId,
});
/** A skin that renders with another palette. */
export type PaletteSkin = z.infer<typeof PaletteSkin>;

/**
 * A palette mapping applied at render and export time (spec 3.1, FR-PAL-07, FR-RIG-20 step 8):
 * either a {@link RemapSkin} or a {@link PaletteSkin}. The unskinned render is the implicit skin
 * `base`.
 */
export const Skin = z.union([RemapSkin, PaletteSkin]);
/** A palette mapping applied at render and export time. */
export type Skin = z.infer<typeof Skin>;
