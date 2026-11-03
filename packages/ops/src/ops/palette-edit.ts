/**
 * `palette.edit`: add, remove, replace and move colours of the active palette.
 * @packageDocumentation
 */
import { addColor, composeRemaps, moveColor, removeColor, replaceColor } from '@pixel-forge/color';
import type { IndexRemap, PaletteEdit } from '@pixel-forge/color';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { HexColor, toHex } from '../grid.js';
import { colorOf, storePalette, targetPalette } from '../palette-target.js';
import { DocRef } from '../refs.js';

const Index = z.int().min(0).max(255);

/** One edit of {@link paletteEdit}. */
const Edit = z.discriminatedUnion('do', [
  z.strictObject({
    do: z.literal('add'),
    color: HexColor,
    at: Index.optional().describe('Insert here (default: the end).'),
  }),
  z.strictObject({ do: z.literal('remove'), index: Index }),
  z.strictObject({ do: z.literal('replace'), index: Index, color: HexColor }),
  z.strictObject({ do: z.literal('move'), from: Index, to: Index.describe('Final index.') }),
]);

/** `palette.edit` (MCP `palette_edit`, CLI `pf palette edit`). */
export const paletteEdit = defineOp({
  name: 'palette.edit',
  safety: 'mutate',
  group: 'palette',
  summary: 'Add, remove, replace or move colours of the active palette.',
  description:
    'Edits apply in order; indices refer to the palette as earlier edits left it. Indexed documents: pixels and skins follow moves; removing a colour pixels still use is refused. Replace recolours indexed pixels. With no palette, add creates one.',
  input: z.strictObject({
    doc: DocRef,
    edits: z.array(Edit).min(1).max(64).describe('Edits, in order.'),
    name: z.string().min(1).max(128).optional().describe('Name for a palette this call creates.'),
  }),
  output: z.strictObject({
    palette: z.string().describe('Palette id.'),
    colors: z.array(z.string()).describe('The colours afterwards, "#rrggbb[aa]".'),
    remap: z
      .array(z.int().nullable())
      .optional()
      .describe('New index of each old index (null: removed); omitted when nothing moved.'),
    images: z.int().describe('Indexed drawings rewritten.'),
    warning: z.string().optional(),
  }),
  examples: [
    {
      title: 'Add a dark outline colour, then recolour entry 2',
      input: {
        doc: 'doc_g1ed5q',
        edits: [
          { do: 'add', color: '#1a1c2c' },
          { do: 'replace', index: 2, color: '#b13e53' },
        ],
      },
    },
  ],
  handler: (ctx, input) => {
    const target = targetPalette(ctx, true, input.name);
    let pal = target.palette;
    let remap: IndexRemap = pal.colors.map((_, i) => i);
    let recolors = false;
    input.edits.forEach((e, n) => {
      let step: PaletteEdit;
      try {
        if (e.do === 'add') step = addColor(pal, colorOf(e.color), e.at);
        else if (e.do === 'remove') step = removeColor(pal, e.index);
        else if (e.do === 'replace') {
          recolors = true;
          step = replaceColor(pal, e.index, colorOf(e.color));
        } else step = moveColor(pal, e.from, e.to);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        throw new OpError('BAD_INPUT', `edit ${String(n)} (${e.do}): ${error.message}`, {
          issues: [{ path: `edits.${String(n)}`, message: error.message }],
        });
      }
      remap = composeRemaps(remap, step.remap);
      pal = step.palette;
    });
    const done = storePalette(ctx, target, pal, remap, recolors);
    const moved = remap.some((m, i) => m !== i);
    return {
      palette: pal.id,
      colors: pal.colors.map((c) => toHex(c)),
      ...(moved ? { remap: [...remap] } : {}),
      images: done.images,
      ...(done.warning === undefined ? {} : { warning: done.warning }),
    };
  },
});
