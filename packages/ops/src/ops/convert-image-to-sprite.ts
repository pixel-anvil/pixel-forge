/**
 * `convert.imageToSprite`: a PNG file becomes a pixel-art document (FR-CONV-01..09).
 * @packageDocumentation
 */
import { decodeImageFile } from '@pixel-forge/io';
import { DocId } from '@pixel-forge/schema';
import { z } from 'zod';
import {
  ReportOut,
  checkSourceSize,
  choosePalette,
  convertFields,
  createSpriteDocument,
  layerNameOf,
  planConvert,
  reportOf,
  runPlan,
} from '../convert-support.js';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { pngSize, readBytes } from '../file-io.js';

/** Last path segment without its extension, as a document name. */
function baseName(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return (dot > 0 ? file.slice(0, dot) : file) || 'sprite';
}

/** `convert.imageToSprite` (MCP `image_to_sprite`, CLI `pf convert image-to-sprite`). */
export const convertImageToSprite = defineOp({
  name: 'convert.imageToSprite',
  safety: 'io',
  group: 'convert',
  summary:
    'Turn a PNG into pixel art: crop, background, grid or size, palette, dither. Opens a new document.',
  description:
    'PNG only. Steps run in order: crop, background, downscale (width/height or grid), clean, quantise (any of palette, colors, dither). Quantising adds the palette to the document. With variants each combination is a layer (the first is visible).',
  mcp: { name: 'image_to_sprite' },
  cli: { command: ['convert', 'image-to-sprite'] },
  input: z.strictObject({
    file: z.string().min(1).describe('Absolute PNG path inside the workspace roots.'),
    name: z.string().min(1).max(128).optional().describe('Document name (default: the file name).'),
    ...convertFields,
  }),
  output: z.strictObject({
    doc: DocId.describe('The new document.'),
    canvas: z.strictObject({ w: z.int(), h: z.int() }),
    layers: z.array(z.string()).describe('Layer names.'),
    palette: z
      .strictObject({ name: z.string(), colors: z.int() })
      .optional()
      .describe('Active palette, if quantised.'),
    ...ReportOut.shape,
  }),
  examples: [
    {
      title: '32 px tall, PICO-8 colours, Bayer dither',
      input: {
        file: '/work/photo.png',
        height: 32,
        background: 'flood',
        tolerance: 40,
        palette: 'pico-8',
        dither: 'bayer4',
      },
    },
  ],
  handler: async (ctx, input) => {
    const { file, name, ...rest } = input;
    const plan = planConvert(rest);
    const path = ctx.host.resolvePath(file);
    const bytes = await readBytes(ctx, path);
    let size: { w: number; h: number } | undefined;
    try {
      size = pngSize(bytes, path);
    } catch (e) {
      // not a PNG: decodeImageFile below says which format it is and to convert it first
      if (!(e instanceof OpError && e.code === 'BAD_FILE')) throw e;
    }
    if (size !== undefined) checkSourceSize(size.w, size.h);
    const img = decodeImageFile(bytes);
    checkSourceSize(img.width, img.height);

    const palette = choosePalette(img, plan);
    const results = runPlan(img, plan, palette);
    const single = results.length === 1;
    const layers = results.map((r, i) => ({
      name: single ? 'sprite' : layerNameOf(r.label),
      image: r.image,
      visible: i === 0,
    }));
    const quantised = plan.recipe.quantize !== undefined;
    const made = await createSpriteDocument(ctx, {
      name: name ?? baseName(path),
      layers,
      ...(quantised && palette !== undefined ? { palette } : {}),
    });
    const first = results[0];
    return {
      doc: made.doc,
      canvas: made.canvas,
      layers: layers.map((l) => l.name),
      ...(quantised && palette !== undefined
        ? { palette: { name: palette.name, colors: palette.colors.length } }
        : {}),
      ...(first === undefined ? { steps: [] } : reportOf(first.report)),
    };
  },
});
