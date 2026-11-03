/**
 * What the palette ops share: find (or make) the active palette, and write an edited one back
 * together with the pixel remap that keeps the render unchanged.
 * @packageDocumentation
 */
import { remapPaletteIndices } from '@pixel-forge/core';
import type { IndexRemap } from '@pixel-forge/color';
import { Palette } from '@pixel-forge/schema';
import type { RGBA8 } from '@pixel-forge/schema';
import { activePalette } from './cel.js';
import type { OpContext } from './context.js';
import { OpError } from './errors.js';
import { parseHex } from './grid.js';

/** A mutable copy of the active palette (or a new, empty one when the document has none and `create`). */
export interface PaletteTarget {
  readonly palette: Palette;
  /** True when the palette does not exist in the document yet. */
  readonly created: boolean;
}

/**
 * The active palette as a plain copy. With `create`, a document without one gets a new empty palette
 * (written by {@link storePalette}); otherwise that is `REFUSED` (`reason: 'no-palette'`).
 */
export function targetPalette(ctx: OpContext, create: boolean, name = 'palette'): PaletteTarget {
  const found = activePalette(ctx.doc);
  if (found !== undefined) {
    return { palette: Palette.parse(JSON.parse(JSON.stringify(found))), created: false };
  }
  if (!create) {
    throw new OpError(
      'REFUSED',
      'the document has no active palette; add colours with palette_edit first',
      { reason: 'no-palette' },
    );
  }
  return { palette: { id: ctx.tx.newId('palette'), name, colors: [], ramps: [] }, created: true };
}

/** `#rrggbb[aa]` as an RGBA8 colour. */
export const colorOf = (hex: string): RGBA8 => {
  const [r, g, b, a] = parseHex(hex);
  return [r, g, b, a];
};

/** Result of {@link storePalette}. */
export interface StoreResult {
  readonly images: number;
  readonly skins: number;
  /** Set when the render may now differ from the palette (locked RGBA documents). */
  readonly warning?: string;
}

/**
 * Writes `next` as the active palette. `remap` (old index to new, `null` removed) is followed through
 * indexed pixels and skins first (`remapPaletteIndices`), so a refusal leaves the document unchanged.
 * @param recolors true when an existing colour changed value (replace), for the locked-RGBA warning.
 */
export function storePalette(
  ctx: OpContext,
  target: PaletteTarget,
  next: Palette,
  remap: IndexRemap,
  recolors: boolean,
): StoreResult {
  const { tx } = ctx;
  const moved = remapPaletteIndices(tx, remap);
  tx.update((d) => {
    const at = d.palettes.findIndex((p) => p.id === next.id);
    if (at >= 0) d.palettes[at] = next;
    else d.palettes.push(next);
    d.activePaletteId = next.id;
  });
  const meta = tx.doc.meta;
  const changes = recolors || remap.some((m, i) => m !== i);
  const warning =
    meta.paletteLocked && meta.colorMode === 'rgba' && changes && !target.created
      ? 'palette-locked RGBA document: drawn pixels keep their old colours; run lint (palette.offPalette)'
      : undefined;
  return { ...moved, ...(warning === undefined ? {} : { warning }) };
}
