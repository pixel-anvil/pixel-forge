/**
 * `convert.apply`: run a convert recipe on one layer's cel (FR-CONV-08, FR-CONV-09), or a variant
 * grid of it as a contact sheet in a new document.
 * @packageDocumentation
 */
import { variantSheet } from '@pixel-forge/convert';
import type { NamedPalette } from '@pixel-forge/convert';
import { referencedImages } from '@pixel-forge/core';
import { TiledImage } from '@pixel-forge/raster';
import type { RgbaImage } from '@pixel-forge/raster';
import { DocId, Name } from '@pixel-forge/schema';
import type { RGBA8 } from '@pixel-forge/schema';
import { z } from 'zod';
import { activePalette, celContent, celPixelReader, resolveCelLayer } from '../cel.js';
import {
  ReportOut,
  addLayersTx,
  checkSourceSize,
  choosePalette,
  convertFields,
  createSpriteDocument,
  planConvert,
  reportOf,
  runPlan,
} from '../convert-support.js';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import type { ReadonlyDocument } from '../refs.js';
import {
  AnimRef,
  DocRef,
  FrameRef,
  LayerRef,
  resolveAuthoredAnimation,
  resolveFrame,
  walkLayers,
} from '../refs.js';
import { setCel } from './pixels-write-grid.js';

/** Refuses a result with an opaque colour the palette-locked document's active palette lacks. */
function checkLocked(doc: ReadonlyDocument, image: RgbaImage): void {
  if (!doc.meta.paletteLocked) return;
  const palette = activePalette(doc);
  if (palette === undefined) {
    throw new OpError('REFUSED', 'the document is palette-locked but has no active palette', {
      reason: 'no-palette',
    });
  }
  const key = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;
  const allowed = new Set(palette.colors.filter((c) => c[3] > 0).map((c) => key(c[0], c[1], c[2])));
  for (let o = 0; o < image.data.length; o += 4) {
    if (
      (image.data[o + 3] ?? 0) > 0 &&
      !allowed.has(key(image.data[o] ?? 0, image.data[o + 1] ?? 0, image.data[o + 2] ?? 0))
    ) {
      throw new OpError(
        'REFUSED',
        `the result has colours outside the locked palette "${palette.name}"; quantise to it (omit palette/colors) or unlock the document`,
        { reason: 'off-palette', palette: palette.name },
      );
    }
  }
}

/** `convert.apply` (MCP `convert_apply`, CLI `pf convert apply`). */
export const convertApply = defineOp({
  name: 'convert.apply',
  safety: 'io',
  group: 'convert',
  summary:
    'Run a convert recipe on a layer cel: replace it, add a layer, or make a variant contact sheet.',
  description:
    'Source: the cel of "layer" at animation/frame. Without newLayer the result replaces the cel and must keep the canvas size (so no downscale or outline). With newLayer it is added aligned to the origin. Quantises to the active palette unless palette/colors is given. With variants the document is untouched: a new document holds the sheet, "tiles" says where each combination sits.',
  mcp: { name: 'convert_apply' },
  cli: { command: ['convert', 'apply'] },
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef.describe('{"group": "idle"}'),
    frame: FrameRef,
    layer: LayerRef,
    newLayer: Name.optional().describe('Add the result as a new layer of this name.'),
    ...convertFields,
  }),
  output: z.strictObject({
    layer: z.string().optional().describe('Layer that holds the result.'),
    size: z.strictObject({ w: z.int(), h: z.int() }).optional().describe('Result size, px.'),
    sheetDoc: DocId.optional().describe('Variants: the new document with the contact sheet.'),
    tiles: z
      .array(z.strictObject({ label: z.string(), x: z.int(), y: z.int(), w: z.int(), h: z.int() }))
      .optional()
      .describe('Variants: label and position of each result on the sheet.'),
    palette: z.strictObject({ name: z.string(), colors: z.int() }).optional(),
    ...ReportOut.shape,
  }),
  examples: [
    {
      title: 'Variant grid: two dither modes on layer "body"',
      input: {
        doc: 'doc_g1ed5q',
        animation: { group: 'idle' },
        frame: 0,
        layer: 'body',
        variants: { dither: ['none', 'bayer4'] },
      },
    },
  ],
  handler: async (ctx, input) => {
    const { animation, frame, layer: layerRef, newLayer, ...rest } = input;
    const doc = ctx.doc;
    const plan = planConvert(rest);
    const layer = resolveCelLayer(doc, layerRef);
    const { animation: authored } = resolveAuthoredAnimation(doc, animation);
    const { frame: fr } = resolveFrame(authored, frame);
    const cel = celContent(ctx, layer, fr.id);
    const { w, h } = doc.meta.canvas;
    checkSourceSize(w, h);
    const read = celPixelReader(doc, cel);
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) data.set(read(x, y), (y * w + x) * 4);
    }
    const source: RgbaImage = { width: w, height: h, data };

    const active = activePalette(doc);
    const fallback: NamedPalette | undefined =
      active === undefined
        ? undefined
        : { name: active.name, colors: active.colors.map((c): RGBA8 => [c[0], c[1], c[2], c[3]]) };
    const palette = choosePalette(source, plan, fallback);
    const results = runPlan(source, plan, palette);
    const palOut =
      plan.recipe.quantize !== undefined && palette !== undefined
        ? { palette: { name: palette.name, colors: palette.colors.length } }
        : {};
    const first = results[0];
    const report = first === undefined ? { steps: [] } : reportOf(first.report);

    if (plan.axes !== undefined) {
      const sheet = variantSheet(
        results.map((r, index) => ({ index, label: r.label, image: r.image })),
      );
      const made = await createSpriteDocument(ctx, {
        name: `${layer.name}-variants`.slice(0, 128),
        layers: [{ name: 'variants', image: sheet.image, visible: true }],
        ...(palOut.palette !== undefined && palette !== undefined ? { palette } : {}),
      });
      return {
        sheetDoc: made.doc,
        size: { w: sheet.image.width, h: sheet.image.height },
        tiles: sheet.tiles.map((t) => ({ label: t.label, x: t.x, y: t.y, w: t.w, h: t.h })),
        ...palOut,
        ...report,
      };
    }

    const result = results[0];
    if (result === undefined) throw new OpError('INTERNAL', 'convert produced no result');
    const image = result.image;
    if (layer.kind === 'reference') {
      throw new OpError('REFUSED', `layer ${layer.name} is a reference layer and is not written`, {
        reason: 'reference-layer',
      });
    }
    if (doc.meta.colorMode === 'indexed') {
      throw new OpError(
        'REFUSED',
        'the document is indexed: convert_apply does not write indexed cels; use variants for a sheet document, or doc_set_color_mode to rgba first',
        { reason: 'indexed-document' },
      );
    }
    checkLocked(doc, image);
    const size = { w: image.width, h: image.height };
    if (newLayer !== undefined) {
      if (walkLayers(doc).some((l) => l.layer.name === newLayer)) {
        throw new OpError('REFUSED', `a layer named "${newLayer}" exists; pick another name`, {
          reason: 'layer-exists',
        });
      }
      if (image.width > w || image.height > h) {
        throw new OpError(
          'REFUSED',
          `the result is ${String(image.width)}x${String(image.height)}, larger than the ${String(w)}x${String(h)} canvas (an outline adds 2 px); use variants for a separate document, or a smaller target`,
          { reason: 'larger-than-canvas' },
        );
      }
      ctx.transact((tx) => {
        addLayersTx(tx, fr.id, [{ name: newLayer, image, visible: true }]);
      });
      return { layer: newLayer, size, ...palOut, ...report };
    }
    if (image.width !== w || image.height !== h) {
      throw new OpError(
        'REFUSED',
        `the result is ${String(image.width)}x${String(image.height)} but the canvas is ${String(w)}x${String(h)}; replacing a cel needs the same size. Use newLayer to add it as a layer, or drop the downscale/outline`,
        { reason: 'size-mismatch', result: size, canvas: { w, h } },
      );
    }
    if (cel?.linked === true) {
      throw new OpError(
        'REFUSED',
        `layer ${layer.name} shares this cel with another frame; unlink it first or use newLayer`,
        { reason: 'linked-cel' },
      );
    }
    ctx.transact((tx) => {
      const imageId = tx.createImage(TiledImage.fromRGBA(image));
      tx.update((d) => {
        setCel(d, layer.id, fr.id, { imageId, opacity: cel?.opacity ?? 255 });
      });
      if (cel !== undefined && !referencedImages(tx.doc).has(cel.imageId)) {
        tx.deleteImage(cel.imageId);
      }
    });
    return { layer: layer.name, size, ...palOut, ...report };
  },
});
