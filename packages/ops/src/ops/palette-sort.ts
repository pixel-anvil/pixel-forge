/**
 * `palette.sort`: reorder the active palette by hue, lightness, luma or chroma.
 * @packageDocumentation
 */
import { sortBy } from '@pixel-forge/color';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { storePalette, targetPalette } from '../palette-target.js';
import { DocRef } from '../refs.js';

/** `palette.sort` (MCP `palette_sort`, CLI `pf palette sort`). */
export const paletteSort = defineOp({
  name: 'palette.sort',
  safety: 'mutate',
  group: 'palette',
  summary: 'Sort the active palette by hue, luminance, luma or chroma.',
  description:
    'Stable: equal keys keep their order. luminance = OKLab lightness, luma = Rec. 709 on 8-bit sRGB, hue puts greys first. Indexed documents: pixels, ramps and skins follow the colours.',
  input: z.strictObject({
    doc: DocRef,
    by: z.enum(['hue', 'luminance', 'luma', 'chroma']).describe('Sort key.'),
    descending: z.boolean().optional().describe('Largest first (default false).'),
  }),
  output: z.strictObject({
    order: z.array(z.int()).describe('order[newIndex] = oldIndex.'),
    images: z.int().describe('Indexed drawings rewritten.'),
    warning: z.string().optional(),
  }),
  examples: [{ title: 'Dark to light', input: { doc: 'doc_g1ed5q', by: 'luminance' } }],
  handler: (ctx, input) => {
    const target = targetPalette(ctx, false);
    const edit = sortBy(target.palette, input.by, input.descending ?? false);
    const done = storePalette(ctx, target, edit.palette, edit.remap, false);
    return {
      order: [...edit.order],
      images: done.images,
      ...(done.warning === undefined ? {} : { warning: done.warning }),
    };
  },
});
