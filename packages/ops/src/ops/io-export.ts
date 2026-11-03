/**
 * `io.export`: render animations into a spritesheet PNG plus Aseprite-style JSON.
 * @packageDocumentation
 */
import { exportSpritesheet, saveAtomic } from '@pixel-forge/io';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { utf8 } from '../file-io.js';
import { AnimRef, DocRef } from '../refs.js';

/** `io.export` (MCP `export`, CLI `pf export`). */
export const ioExport = defineOp({
  name: 'io.export',
  safety: 'io',
  group: 'core',
  summary: 'Export animations as a spritesheet PNG plus a JSON description (Aseprite hash format).',
  description:
    'Renders every frame like the game would see it (export layers only; rig, overrides and post-passes applied; mirrors flipped) and writes <name>.png and <name>.json side by side, atomically. layout "rows" puts one animation per row; "packed" fills a near-square grid. scale is an integer 1..16. The JSON lists a frame per cell with its duration, and one tag per animation. To look at art use render_contact_sheet instead; a scale 1 export of one animation is the base for override_import.',
  mcp: { name: 'export' },
  cli: { command: ['export'] },
  input: z.strictObject({
    doc: DocRef,
    path: z
      .string()
      .min(1)
      .regex(/\.png$/i, 'expected a .png path')
      .describe('Output PNG path (absolute, inside the workspace roots); the JSON goes beside it.'),
    animations: z
      .array(AnimRef)
      .optional()
      .describe('Animations to export, in order (default: all).'),
    layout: z.enum(['rows', 'packed']).default('rows').describe('"rows" (default) or "packed".'),
    scale: z.int().min(1).max(16).default(1).describe('Integer scale, 1..16 (default 1).'),
    skin: z.string().min(1).default('base').describe('Skin name, or "base" (default).'),
    exportOnly: z.boolean().default(true).describe('Only layers with export: true (default true).'),
  }),
  output: z.strictObject({
    png: z.string().describe('Path of the written PNG.'),
    json: z.string().describe('Path of the written JSON.'),
    size: z.strictObject({ w: z.int(), h: z.int() }).describe('Sheet size, px.'),
    frames: z.int().describe('Frames exported.'),
    animations: z.array(z.string()).describe('Animation tags in sheet order.'),
  }),
  examples: [
    {
      title: 'Export the hero as a 2x sheet',
      input: { doc: 'doc_g1ed5q', path: '/work/out/hero.png', scale: 2 },
      output: {
        png: '/work/out/hero.png',
        json: '/work/out/hero.json',
        size: { w: 96, h: 96 },
        frames: 1,
        animations: ['default'],
      },
    },
  ],
  handler: async (ctx, input) => {
    const { host } = ctx;
    const png = host.resolvePath(input.path);
    const json = `${png.slice(0, -4)}.json`;
    const sheet = exportSpritesheet(ctx.view, {
      layout: input.layout,
      scale: input.scale,
      exportOnly: input.exportOnly,
      imageName: png.slice(png.lastIndexOf('/') + 1),
      rig: host.renderer,
      ...(input.animations === undefined ? {} : { animations: input.animations }),
      ...(input.skin === 'base' ? {} : { skin: { name: input.skin } }),
    });
    const text = utf8(`${JSON.stringify(sheet.json, null, 2)}\n`);
    await saveAtomic(host.fs, png, sheet.png);
    await saveAtomic(host.fs, json, text);
    return {
      png,
      json,
      size: { w: sheet.json.meta.size.w, h: sheet.json.meta.size.h },
      frames: Object.keys(sheet.json.frames).length,
      animations: sheet.json.meta.frameTags.map((t) => t.name),
    };
  },
});
