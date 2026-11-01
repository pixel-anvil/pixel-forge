/**
 * `render.contactSheet`: a labelled grid of frames as one PNG, optionally with bone and pivot overlays
 * (FR-AI-12).
 * @packageDocumentation
 */
import { contactSheet, contactSheetFrameOrigin, contactSheetPlan } from '@pixel-forge/io';
import type { ContactSheetOptions } from '@pixel-forge/io';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { ImageOutput, pngOutput } from '../image-output.js';
import { boneMarks, paintMarks } from '../overlay.js';
import { AnimRef, DocRef } from '../refs.js';
import { SkinArg, resolveSkin } from '../skin.js';

/** `render.contactSheet` (MCP `render_contact_sheet`, CLI `pf render contact-sheet`). */
export const renderContactSheet = defineOp({
  name: 'render.contactSheet',
  safety: 'read',
  summary:
    'Render the frames of some or all animations as one labelled PNG contact sheet (long edge at most 1568 px), optionally with bone lines and pivot markers.',
  description:
    'Use it to judge motion across frames (before/after a re-pose, a whole walk cycle): vision judges gesture and readability, lint owns precision (1 px gaps, off-palette pixels). Each tile is labelled "GROUP/DIRECTION #n" (n = 0-based frame index, the same number frames are addressed by). The scale is the largest that fits 1568 px, or lower than `scale` when that does not fit. The image is `output.image` (PNG, base64). `bones` draws yellow bone lines and `pivots` red pivot squares on every tile (they need a rig).',
  input: z.strictObject({
    doc: DocRef,
    animations: z
      .array(AnimRef)
      .min(1)
      .optional()
      .describe('Animations to show, in order (default: all).'),
    scale: z
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe(
        'Integer upscale to start from, 1..16 (default: the largest that fits 1568 px; reduced until it fits).',
      ),
    labels: z
      .boolean()
      .optional()
      .describe('Write "GROUP/DIRECTION #n" under each frame (default true).'),
    skin: SkinArg.optional(),
    bones: z
      .boolean()
      .optional()
      .describe('Draw a line from each bone pivot to its tip on every tile (default false).'),
    pivots: z
      .boolean()
      .optional()
      .describe('Draw a marker on each bone pivot pixel on every tile (default false).'),
  }),
  output: z.strictObject({
    frames: z.int().describe('Number of frames on the sheet.'),
    columns: z.int().describe('Tiles per row.'),
    rows: z.int().describe('Tile rows.'),
    scale: z.int().describe('The upscale used.'),
    image: ImageOutput.describe('The contact sheet PNG.'),
  }),
  examples: [
    {
      title: 'Show every frame of the hero with the skeleton drawn',
      input: { doc: 'doc_g1ed5q', bones: true, pivots: true },
    },
  ],
  handler: (ctx, input) => {
    const skin = resolveSkin(ctx.doc, input.skin);
    const options: ContactSheetOptions = {
      rig: ctx.renderer,
      ...(input.animations === undefined ? {} : { animations: input.animations }),
      ...(input.scale === undefined ? {} : { scale: input.scale }),
      ...(input.labels === undefined ? {} : { labels: input.labels }),
      ...(skin === undefined ? {} : { skin }),
    };
    const plan = contactSheetPlan(ctx.view, options);
    const sheet = contactSheet(ctx.view, options).toRGBA();
    const wantBones = input.bones === true;
    const wantPivots = input.pivots === true;
    if (wantBones || wantPivots) {
      const { w, h } = ctx.doc.meta.canvas;
      for (const tile of plan.tiles) {
        const at = contactSheetFrameOrigin(plan, w, tile);
        paintMarks(
          sheet,
          { x: at.x, y: at.y, scale: plan.scale, width: w, height: h },
          boneMarks(ctx, tile.anim, tile.index),
          { bones: wantBones, pivots: wantPivots },
        );
      }
    }
    return {
      frames: plan.tiles.length,
      columns: plan.columns,
      rows: plan.rows,
      scale: plan.scale,
      image: pngOutput(sheet),
    };
  },
});
