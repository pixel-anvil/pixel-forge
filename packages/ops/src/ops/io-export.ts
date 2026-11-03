/**
 * `io.export`: render animations into a spritesheet PNG plus Aseprite-style JSON.
 * @packageDocumentation
 */
import { exportSpritesheet, saveAtomic } from '@pixel-forge/io';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { utf8 } from '../file-io.js';
import { OpError } from '../errors.js';
import { AnimRef, DocRef } from '../refs.js';

/** `io.export` (MCP `export`, CLI `pf export`). */
export const ioExport = defineOp({
  name: 'io.export',
  safety: 'io',
  group: 'core',
  summary: 'Export animations as a spritesheet PNG plus a JSON description (Aseprite hash format).',
  description:
    'Renders every frame like the game would see it (export layers only; rig, overrides and post-passes applied; mirrors flipped) and writes <name>.png and <name>.json side by side, atomically. layout "rows" puts one animation per row; "packed" fills a near-square grid. scale is an integer 1..16. The JSON lists a frame per cell with its duration, and one tag per animation. skin renders one skin; allSkins writes one sheet per skin (base, then each skin) with the same layout: <name>.png, <name>.<skin>.png. To look at art use render_contact_sheet instead; a scale 1 export of one animation is the base for override_import.',
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
    allSkins: z
      .boolean()
      .default(false)
      .describe('One sheet per skin: base as <name>.png, each skin as <name>.<skin>.png.'),
    exportOnly: z.boolean().default(true).describe('Only layers with export: true (default true).'),
  }),
  output: z.strictObject({
    png: z.string().describe('Path of the written PNG.'),
    json: z.string().describe('Path of the written JSON.'),
    size: z.strictObject({ w: z.int(), h: z.int() }).describe('Sheet size, px.'),
    frames: z.int().describe('Frames exported.'),
    animations: z.array(z.string()).describe('Animation tags in sheet order.'),
    sheets: z
      .array(z.strictObject({ skin: z.string(), png: z.string(), json: z.string() }))
      .optional()
      .describe('allSkins: every sheet written, base first.'),
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
    const stem = png.slice(0, -4);
    if (input.allSkins && input.skin !== 'base') {
      throw new OpError('BAD_INPUT', 'give "skin" or "allSkins", not both', {
        issues: [{ path: 'allSkins', message: 'allSkins already includes every skin' }],
      });
    }
    // One sheet per skin: `base` keeps the plain name, a skin adds `.<skin>` (same layout in all).
    const skins = input.allSkins ? ['base', ...ctx.doc.skins.map((s) => s.name)] : [input.skin];
    // Render every skin first, so a failing render writes nothing.
    const sheets = skins.map((skin) => {
      const suffix = input.allSkins && skin !== 'base' ? `.${skin}` : '';
      const pngPath = `${stem}${suffix}.png`;
      const sheet = exportSpritesheet(ctx.view, {
        layout: input.layout,
        scale: input.scale,
        exportOnly: input.exportOnly,
        imageName: pngPath.slice(pngPath.lastIndexOf('/') + 1),
        rig: host.renderer,
        ...(input.animations === undefined ? {} : { animations: input.animations }),
        ...(skin === 'base' ? {} : { skin: { name: skin } }),
      });
      return { skin, pngPath, jsonPath: `${stem}${suffix}.json`, sheet };
    });
    const written: { skin: string; png: string; json: string }[] = [];
    for (const { skin, pngPath, jsonPath, sheet } of sheets) {
      await saveAtomic(host.fs, pngPath, sheet.png);
      await saveAtomic(host.fs, jsonPath, utf8(`${JSON.stringify(sheet.json, null, 2)}\n`));
      written.push({ skin, png: pngPath, json: jsonPath });
    }
    const first = sheets[0]?.sheet;
    if (first === undefined) throw new OpError('INTERNAL', 'no sheet was rendered');
    return {
      png: written[0]?.png ?? png,
      json: written[0]?.json ?? `${stem}.json`,
      size: { w: first.json.meta.size.w, h: first.json.meta.size.h },
      frames: Object.keys(first.json.frames).length,
      animations: first.json.meta.frameTags.map((t) => t.name),
      ...(input.allSkins ? { sheets: written } : {}),
    };
  },
});
