/**
 * `palette.generate`: make a palette of N colours from an image (FR-PAL-04) and optionally keep it.
 * @packageDocumentation
 */
import {
  DEFAULT_PALETTE_SEED,
  MAX_GENERATED_COLORS,
  MAX_WORK_COLORS,
  MIN_GENERATED_COLORS,
  generatePalette,
} from '@pixel-forge/color';
import type { GeneratedPalette } from '@pixel-forge/color';
import { decodePng, PngError } from '@pixel-forge/png';
import { z } from 'zod';
import { celContent, celPixelReader, resolveCelLayer } from '../cel.js';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { readBytes } from '../file-io.js';
import { toHex } from '../grid.js';
import { frameIndexOf } from '../overlay.js';
import {
  AnimRef,
  DocRef,
  FrameRef,
  LayerRef,
  resolveAuthoredAnimation,
  resolveFrame,
} from '../refs.js';
import type { OpContext } from '../context.js';

interface Source {
  readonly data: ArrayLike<number>;
  readonly kind: 'file' | 'frame' | 'layer';
}

const bad = (path: string, message: string): OpError =>
  new OpError('BAD_INPUT', message, { issues: [{ path, message }] });

/** The RGBA pixels the input names: a PNG file, a rendered frame, or one layer's cel. */
async function readSource(
  ctx: OpContext,
  input: {
    readonly file?: string | undefined;
    readonly animation?: z.output<typeof AnimRef> | undefined;
    readonly frame?: z.output<typeof FrameRef> | undefined;
    readonly layer?: string | undefined;
  },
): Promise<Source> {
  if ((input.file === undefined) === (input.animation === undefined)) {
    throw bad('file', 'give either "file" (a PNG) or "animation" (a frame of the document)');
  }
  if (input.file !== undefined) {
    if (input.frame !== undefined || input.layer !== undefined) {
      throw bad('frame', '"frame" and "layer" only apply with "animation"');
    }
    const path = ctx.host.resolvePath(input.file);
    try {
      return { data: decodePng(await readBytes(ctx, path)).data, kind: 'file' };
    } catch (e) {
      if (!(e instanceof PngError)) throw e;
      throw new OpError('BAD_FILE', `${path} is not a usable PNG: ${e.message}`, { path });
    }
  }
  const animation = input.animation;
  if (animation === undefined) throw bad('animation', 'missing');
  const frame = input.frame ?? 0;
  if (input.layer === undefined) {
    const index = frameIndexOf(ctx, animation, frame);
    return {
      data: ctx.renderFrame(animation, index, { exportOnly: true }).toRGBA().data,
      kind: 'frame',
    };
  }
  const layer = resolveCelLayer(ctx.doc, input.layer);
  const { animation: authored } = resolveAuthoredAnimation(ctx.doc, animation);
  const read = celPixelReader(
    ctx.doc,
    celContent(ctx, layer, resolveFrame(authored, frame).frame.id),
  );
  const { w, h } = ctx.doc.meta.canvas;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(read(x, y), (y * w + x) * 4);
  }
  return { data, kind: 'layer' };
}

function noteOf(r: GeneratedPalette): string | undefined {
  if (r.exact && r.colors.length < r.requested) {
    return `the image has only ${String(r.unique)} distinct colour${r.unique === 1 ? '' : 's'}, fewer than ${String(r.requested)}; all of them are returned`;
  }
  if (r.binned) {
    return `the image has ${String(r.unique)} distinct colours (more than ${String(MAX_WORK_COLORS)}); similar colours were merged before choosing`;
  }
  return undefined;
}

/** `palette.generate` (MCP `palette_generate`, CLI `pf palette generate`). */
export const paletteGenerate = defineOp({
  name: 'palette.generate',
  safety: 'io',
  group: 'palette',
  summary:
    'Make a palette of N colours from an image (k-means++ in OKLab or median cut); optionally keep it.',
  description:
    'Source: "file" (a PNG) or "animation"+"frame" (rendered; "layer" = one cel). Seeded: same image, method and seed give the same colours everywhere. Alpha 0 pixels are ignored, others count by their RGB; colours come out opaque, darkest first, and occur in the image. With n or fewer distinct colours you get those (fewer than n). Without add: true it only returns them; add stores a NEW palette (activate: also make it active; refused for an indexed document, whose pixels would change colour).',
  input: z.strictObject({
    doc: DocRef,
    n: z
      .int()
      .min(MIN_GENERATED_COLORS)
      .max(MAX_GENERATED_COLORS)
      .describe('Colours wanted, 2 to 256.'),
    file: z
      .string()
      .min(1)
      .optional()
      .describe('Source: absolute path of a PNG inside the workspace roots.'),
    animation: AnimRef.optional().describe(
      'Source: the animation to take a frame from (instead of "file").',
    ),
    frame: FrameRef.optional().describe('With animation: the frame (default 0).'),
    layer: LayerRef.optional().describe(
      "With animation: use this pixel layer's cel instead of the whole rendered frame.",
    ),
    method: z
      .enum(['kmeans', 'mediancut'])
      .optional()
      .describe(
        '"kmeans" (default): k-means++ in OKLab. "mediancut": splits colour boxes; ignores seed.',
      ),
    seed: z
      .int()
      .min(0)
      .max(4294967295)
      .optional()
      .describe(`Random seed of kmeans (default ${String(DEFAULT_PALETTE_SEED)}).`),
    minAlpha: z
      .int()
      .min(1)
      .max(255)
      .optional()
      .describe('Ignore pixels with alpha below this (default 1: only fully transparent pixels).'),
    add: z
      .boolean()
      .optional()
      .describe(
        'Store the colours as a new palette of the document (default false: only return them).',
      ),
    activate: z
      .boolean()
      .optional()
      .describe('With add: make it the active palette (default: only when the document has none).'),
    name: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe('With add: palette name (default "generated").'),
  }),
  output: z.strictObject({
    colors: z.array(z.string()).describe('The palette, darkest first, "#rrggbb".'),
    method: z.enum(['kmeans', 'mediancut']),
    seed: z.int().optional().describe('Seed used (kmeans).'),
    source: z.enum(['file', 'frame', 'layer']).describe('Where the pixels came from.'),
    pixels: z.int().describe('Pixels that counted.'),
    ignored: z.int().describe('Pixels ignored (alpha below minAlpha).'),
    unique: z.int().describe('Distinct colours among the counted pixels.'),
    palette: z.string().optional().describe('Id of the stored palette (with add).'),
    active: z
      .boolean()
      .optional()
      .describe('True when the stored palette is now active (with add).'),
    note: z
      .string()
      .optional()
      .describe('Set when fewer colours than n were found or colours were merged.'),
  }),
  examples: [
    {
      title: '16 colours from frame 0, kept as a new palette',
      input: {
        doc: 'doc_g1ed5q',
        n: 16,
        animation: { group: 'default' },
        frame: 0,
        add: true,
        name: 'sprite16',
      },
    },
  ],
  handler: async (ctx, input) => {
    if (input.add !== true && (input.activate !== undefined || input.name !== undefined)) {
      throw bad(input.activate === undefined ? 'name' : 'activate', 'only applies with add: true');
    }
    const source = await readSource(ctx, input);
    let result: GeneratedPalette;
    try {
      result = generatePalette(source.data, {
        n: input.n,
        ...(input.method === undefined ? {} : { method: input.method }),
        ...(input.seed === undefined ? {} : { seed: input.seed }),
        ...(input.minAlpha === undefined ? {} : { minAlpha: input.minAlpha }),
      });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new OpError('REFUSED', error.message, { reason: 'too-large' });
    }
    if (result.colors.length === 0) {
      throw new OpError('REFUSED', 'the source has no visible pixel (all alpha below minAlpha)', {
        reason: 'no-visible-pixels',
      });
    }
    const colors = result.colors.map((c) => toHex(c));
    const note = noteOf(result);
    const out = {
      colors,
      method: result.method,
      ...(result.method === 'kmeans' ? { seed: input.seed ?? DEFAULT_PALETTE_SEED } : {}),
      source: source.kind,
      pixels: result.pixels,
      ignored: result.ignored,
      unique: result.unique,
      ...(note === undefined ? {} : { note }),
    };
    if (input.add !== true) return out;

    const { doc } = ctx;
    const hasActive = doc.palettes.some((p) => p.id === doc.activePaletteId);
    const activate = input.activate ?? !hasActive;
    if (activate && hasActive && doc.meta.colorMode === 'indexed') {
      throw new OpError(
        'REFUSED',
        'the document is indexed: making another palette active would change the colour of its pixels',
        { reason: 'indexed-document' },
      );
    }
    const id = ctx.transact((tx) => {
      const paletteId = tx.newId('palette');
      tx.update((d) => {
        d.palettes.push({
          id: paletteId,
          name: input.name ?? 'generated',
          colors: result.colors.map((c) => [c[0], c[1], c[2], c[3]]),
          ramps: [],
        });
        if (activate) d.activePaletteId = paletteId;
      });
      return paletteId;
    });
    return { ...out, palette: id, active: activate };
  },
});
