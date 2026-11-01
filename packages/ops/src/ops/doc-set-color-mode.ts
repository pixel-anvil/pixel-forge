/**
 * `doc.setColorMode`: RGBA or indexed pixels, and the palette lock.
 * @packageDocumentation
 */
import { setColorMode } from '@pixel-forge/core';
import { COLOR_MODES } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { DocRef } from '../refs.js';

/** `doc.setColorMode` (MCP `doc_set_color_mode`, CLI `pf doc set-color-mode`). */
export const docSetColorMode = defineOp({
  name: 'doc.setColorMode',
  safety: 'mutate',
  summary:
    'Switch the document between "rgba" and "indexed" pixels, and/or lock it to its palette.',
  description:
    'Converting is exact: to "indexed" every colour must be an entry of the active palette (the first alpha-0 entry is the transparent index), else the call is refused and nothing changes; to "rgba" indices resolve through the palette. Both need an active palette. The lock does not recolour: lint (palette.offPalette) judges the render.',
  input: z.strictObject({
    doc: DocRef,
    colorMode: z.enum(COLOR_MODES).optional().describe('"rgba" or "indexed" (default: unchanged).'),
    paletteLocked: z
      .boolean()
      .optional()
      .describe('Lock colours to the active palette (default: unchanged).'),
  }),
  output: z.strictObject({
    colorMode: z.enum(COLOR_MODES).describe('Mode afterwards.'),
    paletteLocked: z.boolean().describe('Lock afterwards.'),
    converted: z.int().describe('Drawings (cels, variants, override images) converted.'),
  }),
  examples: [
    {
      title: 'Lock a document that has a palette to it',
      input: { doc: 'doc_g1ed5q', paletteLocked: true },
    },
  ],
  handler: (ctx, input) => {
    if (input.colorMode === undefined && input.paletteLocked === undefined) {
      throw new OpError('BAD_INPUT', 'doc.setColorMode needs "colorMode" or "paletteLocked"', {
        issues: [{ path: '', message: 'give colorMode, paletteLocked or both' }],
      });
    }
    return setColorMode(ctx.tx, {
      ...(input.colorMode === undefined ? {} : { colorMode: input.colorMode }),
      ...(input.paletteLocked === undefined ? {} : { paletteLocked: input.paletteLocked }),
    });
  },
});
