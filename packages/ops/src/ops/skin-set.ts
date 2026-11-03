/**
 * `skin.set`: create, replace or remove a skin (FR-PAL-07).
 *
 * Design: one op, four modes, exactly one of them per call.
 * - `map`: a remap skin, `[{from, to}]` over the active palette (index, or the exact colour of a
 *   palette entry). Built with `indexLut` from `@pixel-forge/color` (the same table as `palette.remap`)
 *   and stored in the schema's canonical form: sorted by source, no identity pairs.
 * - `palette`: a palette skin that uses another palette of the document, index for index.
 * - `colors`: a palette skin with its own new palette (`skin:<name>`), the same length as the active one.
 * - `remove`: deletes the skin (and its `skin:<name>` palette when nothing else uses it).
 * A skin of the same name is replaced and keeps its id and its place in the list. Skins never change
 * pixels; they apply at render and export time (render step 8), so the base render stays as it is.
 * @packageDocumentation
 */
import { indexLut } from '@pixel-forge/color';
import type { Document, Palette, RemapPair, Skin } from '@pixel-forge/schema';
import { SkinName } from '@pixel-forge/schema';
import { z } from 'zod';
import { activePalette } from '../cel.js';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { HexColor, parseHex, toHex } from '../grid.js';
import { colorOf } from '../palette-target.js';
import { DocRef } from '../refs.js';
import type { ReadonlyDocument } from '../refs.js';

const Entry = z.union([z.int().min(0).max(255), HexColor]);

/** Name of the palette `skin.set` makes for a `colors` skin. */
const skinPaletteName = (skin: string): string => `skin:${skin}`;

/** `skin.set` (MCP `skin_set`, CLI `pf skin set`). */
export const skinSet = defineOp({
  name: 'skin.set',
  safety: 'mutate',
  group: 'palette',
  summary: 'Create, replace or remove a skin (a recoloured render for team kits).',
  description:
    'Name a skin and give exactly one of: map [{from,to}] (remap skin: palette index, or the exact colour of a palette entry), palette (id or name of another palette: palette skin), colors (new palette, same length as the active one), remove true. Same name replaces the skin. Skins never change pixels; render_frame, io.export (allSkins) and lint (palette.offPalette) apply them. Palette edits that move indices are refused while a palette skin exists.',
  input: z.strictObject({
    doc: DocRef,
    skin: z.string().min(1).describe('Skin name (a-z, 0-9, "-", "_"; not "base") or id.'),
    map: z
      .array(z.strictObject({ from: Entry, to: Entry }))
      .max(256)
      .optional()
      .describe('Remap skin: index (or palette colour) from to to; applied at once.'),
    palette: z.string().min(1).optional().describe('Palette skin: id or name of another palette.'),
    colors: z
      .array(HexColor)
      .min(1)
      .max(256)
      .optional()
      .describe('Palette skin: a new palette, one colour per active palette entry.'),
    remove: z.literal(true).optional().describe('Delete the skin.'),
  }),
  output: z.strictObject({
    skin: z.string().describe('Skin name.'),
    id: z.string().describe('Skin id.'),
    action: z.enum(['created', 'updated', 'removed']),
    kind: z.enum(['remap', 'palette']).optional().describe('Absent when removed.'),
    skins: z.array(z.string()).describe('All skin names afterwards.'),
    warnings: z.array(z.string()).optional(),
  }),
  examples: [
    {
      title: 'A rival kit: swap the body colour (1) and the accent (4)',
      input: {
        doc: 'doc_g1ed5q',
        skin: 'rival',
        map: [
          { from: 1, to: 4 },
          { from: 4, to: 1 },
        ],
      },
    },
  ],
  handler: (ctx, input) => {
    const { doc, tx } = ctx;
    const modes = [input.map, input.palette, input.colors, input.remove].filter(
      (m) => m !== undefined,
    );
    if (modes.length !== 1) {
      throw bad('', 'give exactly one of "map", "palette", "colors" and "remove"');
    }
    const existing = doc.skins.find((s) => s.name === input.skin || s.id === input.skin);
    if (input.remove === true) {
      if (existing === undefined) throw notFound(doc, input.skin);
      tx.update((d) => {
        d.skins = d.skins.filter((s) => s.id !== existing.id);
        dropOwnPalette(d, existing);
      });
      return {
        skin: existing.name,
        id: existing.id,
        action: 'removed' as const,
        skins: tx.doc.skins.map((s) => s.name),
      };
    }
    const name = existing?.name ?? parseName(input.skin);
    const base = activePalette(doc);
    if (base === undefined) {
      throw new OpError(
        'REFUSED',
        'the document has no active palette; add colours with palette_edit first',
        { reason: 'no-palette' },
      );
    }
    const warnings: string[] = [];
    const id = existing?.id ?? tx.newId('skin');
    let skin: Skin;
    let ownPalette: Palette | undefined;
    if (input.map !== undefined) {
      skin = { id, name, remap: remapPairs(input.map, base.colors, warnings) };
    } else if (input.palette !== undefined) {
      const found = doc.palettes.find((p) => p.id === input.palette || p.name === input.palette);
      if (found === undefined) {
        throw new OpError('NOT_FOUND', `no palette "${input.palette}"`, {
          kind: 'palette',
          available: doc.palettes.map((p) => p.name),
        });
      }
      if (found.id === base.id) throw bad('palette', 'that is the active palette: the base render');
      checkSkinColors(base.colors, found.colors, warnings);
      skin = { id, name, paletteId: found.id };
    } else {
      const colors = (input.colors ?? []).map(colorOf);
      if (colors.length !== base.colors.length) {
        throw bad(
          'colors',
          `the active palette has ${String(base.colors.length)} colours, "colors" has ${String(colors.length)}; give one per entry`,
        );
      }
      checkSkinColors(base.colors, colors, warnings);
      // Reuse the skin's own palette when it has one nothing else uses, else make a new one.
      const own =
        existing !== undefined && 'paletteId' in existing ? ownPaletteOf(doc, existing) : undefined;
      ownPalette = {
        id: own?.id ?? tx.newId('palette'),
        name: skinPaletteName(name),
        colors,
        ramps: [],
      };
      skin = { id, name, paletteId: ownPalette.id };
    }
    tx.update((d) => {
      if (existing !== undefined) dropOwnPalette(d, existing, ownPalette?.id);
      if (ownPalette !== undefined) {
        const at = d.palettes.findIndex((p) => p.id === ownPalette.id);
        if (at >= 0) d.palettes[at] = ownPalette;
        else d.palettes.push(ownPalette);
      }
      const at = d.skins.findIndex((s) => s.id === id);
      if (at >= 0) d.skins[at] = skin;
      else d.skins.push(skin);
    });
    return {
      skin: name,
      id,
      action: existing === undefined ? ('created' as const) : ('updated' as const),
      kind: 'remap' in skin ? ('remap' as const) : ('palette' as const),
      skins: tx.doc.skins.map((s) => s.name),
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  },
});

function bad(path: string, message: string): OpError {
  return new OpError('BAD_INPUT', message, { issues: [{ path, message }] });
}

function notFound(doc: ReadonlyDocument, ref: string): OpError {
  return new OpError(
    'NOT_FOUND',
    `no skin "${ref}"; the document has ${doc.skins.length === 0 ? 'none' : doc.skins.map((s) => s.name).join(', ')}`,
    { kind: 'skin', ref, available: doc.skins.map((s) => s.name) },
  );
}

function parseName(text: string): string {
  const parsed = SkinName.safeParse(text);
  if (!parsed.success) throw bad('skin', parsed.error.issues[0]?.message ?? 'bad skin name');
  return parsed.data;
}

/**
 * The canonical remap pairs of a `map` input: entries resolve to palette indices (a colour takes
 * its lowest matching index), `indexLut` checks range and repeated sources, identity pairs drop,
 * the rest sorts by source. Transparent entries are refused: a skin recolours, it never erases.
 */
function remapPairs(
  map: readonly { readonly from: number | string; readonly to: number | string }[],
  colors: readonly (readonly number[])[],
  warnings: string[],
): RemapPair[] {
  const size = colors.length;
  const index = (v: number | string, at: string): number => {
    if (typeof v === 'number') return v;
    const want = parseHex(v);
    const found = colors.findIndex(
      (c) => c[0] === want[0] && c[1] === want[1] && c[2] === want[2] && c[3] === want[3],
    );
    if (found < 0) throw bad(at, `${v} is not a colour of the active palette`);
    return found;
  };
  const pairs = map.map((m, n): [number, number] => [
    index(m.from, `map.${String(n)}.from`),
    index(m.to, `map.${String(n)}.to`),
  ]);
  let lut: Uint8Array;
  try {
    lut = indexLut(pairs, size);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    throw bad('map', e.message);
  }
  for (const [from, to] of pairs) {
    for (const v of [from, to]) {
      if ((colors[v]?.[3] ?? 255) === 0) {
        throw new OpError('REFUSED', `index ${String(v)} is transparent; a skin only recolours`, {
          reason: 'transparent',
          index: v,
        });
      }
    }
    // Render step 8 matches by colour and the lowest index wins: a later duplicate never fires.
    const first = colors.findIndex(
      (c) => c[0] === colors[from]?.[0] && c[1] === colors[from]?.[1] && c[2] === colors[from]?.[2],
    );
    if (first < from && (colors[first]?.[3] ?? 0) > 0) {
      warnings.push(
        `index ${String(from)} has the same colour as index ${String(first)}; the render uses index ${String(first)}, so this pair has no effect`,
      );
    }
  }
  const out: RemapPair[] = [];
  for (let i = 0; i < size; i++) {
    const to = lut[i] ?? i;
    if (to !== i) out.push([i, to]);
  }
  return out;
}

/** A skin palette must give an opaque colour wherever the base is opaque (a skin never erases). */
function checkSkinColors(
  base: readonly (readonly number[])[],
  skin: readonly (readonly number[])[],
  warnings: string[],
): void {
  base.forEach((c, i) => {
    const s = skin[i];
    if ((c[3] ?? 0) > 0 && s !== undefined && (s[3] ?? 255) === 0) {
      throw new OpError(
        'REFUSED',
        `skin colour ${String(i)} is transparent (${toHex([s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, 0])}) but the base colour is opaque; a skin only recolours`,
        { reason: 'transparent', index: i },
      );
    }
  });
  if (skin.length < base.length) {
    warnings.push(
      `the skin palette has ${String(skin.length)} colours, the active one ${String(base.length)}: pixels of the other indices keep their base colour`,
    );
  }
}

/** The palette `skin.set` made for `skin`, when nothing else (active palette, other skins) uses it. */
function ownPaletteOf(
  doc: ReadonlyDocument,
  skin: ReadonlyDocument['skins'][number],
): ReadonlyDocument['palettes'][number] | undefined {
  if (!('paletteId' in skin)) return undefined;
  const pal = doc.palettes.find((p) => p.id === skin.paletteId);
  const shared =
    doc.activePaletteId === skin.paletteId ||
    doc.skins.some((s) => s.id !== skin.id && 'paletteId' in s && s.paletteId === skin.paletteId);
  return pal !== undefined && !shared && pal.name === skinPaletteName(skin.name) ? pal : undefined;
}

/** Removes the `skin:<name>` palette of a skin that is going away (not `keep`, the one being rewritten). */
function dropOwnPalette(d: Document, skin: ReadonlyDocument['skins'][number], keep?: string): void {
  if (!('paletteId' in skin) || skin.paletteId === keep) return;
  const pal = d.palettes.find((p) => p.id === skin.paletteId);
  const used =
    d.activePaletteId === skin.paletteId ||
    d.skins.some((s) => s.id !== skin.id && 'paletteId' in s && s.paletteId === skin.paletteId);
  if (pal !== undefined && !used && pal.name === skinPaletteName(skin.name)) {
    d.palettes = d.palettes.filter((p) => p.id !== pal.id);
  }
}
