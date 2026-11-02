/**
 * `pixels.readGrid`: a region of a frame (or of one layer's cel) as a text grid with a per-call legend
 * (FR-AI-13).
 * @packageDocumentation
 */
import { z } from 'zod';
import { celContent, celPixelReader, resolveCelLayer } from '../cel.js';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { MAX_READ_GRID, gridToText, withRulers } from '../grid.js';
import {
  AnimRef,
  DocRef,
  FrameRef,
  LayerRef,
  animationLabel,
  resolveAnimation,
  resolveAuthoredAnimation,
  resolveFrame,
} from '../refs.js';
import { frameIndexOf } from '../overlay.js';

/** `pixels.readGrid` (MCP `pixels_read_grid`, CLI `pf pixels read-grid`). */
export const pixelsReadGrid = defineOp({
  name: 'pixels.readGrid',
  safety: 'read',
  summary:
    'Read a region (at most 64x64 px) of a frame as a text grid: one symbol per pixel, "." transparent, with a legend of the colours present.',
  description:
    'Without "layer" the region is the rendered frame (what pixels_write_grid edits on a rig frame); with a pixel "layer" it is that cel. Symbols 0-9A-Za-z are assigned by first appearance and valid for this call only; at most 62 colours (else read less). "rulers" adds column and row numbers, about 2 characters per pixel in all: read only the area you need. Feed `rows` and `legend` to pixels_write_grid.',
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef,
    layer: LayerRef.optional().describe(
      "Read this pixel layer's cel instead of the rendered frame (mirror animations: not allowed).",
    ),
    x: z.int().min(0).optional().describe('Left column of the region, canvas px (default 0).'),
    y: z.int().min(0).optional().describe('Top row of the region, canvas px (default 0).'),
    width: z
      .int()
      .min(1)
      .max(MAX_READ_GRID)
      .optional()
      .describe('Region width, 1..64 px (default: to the right edge, if at most 64).'),
    height: z
      .int()
      .min(1)
      .max(MAX_READ_GRID)
      .optional()
      .describe('Region height, 1..64 px (default: to the bottom edge, if at most 64).'),
    rulers: z
      .boolean()
      .optional()
      .describe('Also return `ruled`: the rows with column and row numbers (default false).'),
  }),
  output: z.strictObject({
    animation: z.string().describe('"group/direction" of the animation read.'),
    frameIndex: z.int().describe('0-based index of the frame read.'),
    source: z
      .enum(['render', 'cel'])
      .describe('"render": the rendered frame; "cel": one layer\'s cel.'),
    x: z.int().describe('Left column of the region, canvas px.'),
    y: z.int().describe('Top row of the region, canvas px.'),
    width: z.int().describe('Region width, px.'),
    height: z.int().describe('Region height, px.'),
    legend: z
      .record(z.string(), z.string())
      .describe(
        'Symbol to colour "#rrggbb" ("#rrggbbaa" when translucent), for this call only. "." (transparent) is not listed.',
      ),
    rows: z.array(z.string()).describe('One string per pixel row, `width` symbols each.'),
    ruled: z
      .array(z.string())
      .optional()
      .describe(
        'Only with rulers: two header lines of column numbers, then each row prefixed by its row number.',
      ),
  }),
  examples: [
    {
      title: 'Read the hero head, 8x6 px at (21, 0)',
      input: {
        doc: 'doc_g1ed5q',
        animation: { group: 'default' },
        frame: 0,
        x: 21,
        y: 0,
        width: 8,
        height: 6,
      },
      output: {
        animation: 'default',
        frameIndex: 0,
        source: 'render',
        x: 21,
        y: 0,
        width: 8,
        height: 6,
        legend: { '0': '#462d1e', '1': '#e8be96', '2': '#1e1e28' },
        rows: ['00000000', '00000000', '00000000', '00111111', '00111121', '00111111'],
      },
    },
  ],
  handler: (ctx, input) => {
    const { w: cw, h: ch } = ctx.doc.meta.canvas;
    const x = input.x ?? 0;
    const y = input.y ?? 0;
    const width = input.width ?? cw - x;
    const height = input.height ?? ch - y;
    if (width > MAX_READ_GRID || height > MAX_READ_GRID) {
      throw new OpError(
        'REFUSED',
        `the region is ${String(width)}x${String(height)}; a read returns at most ${String(MAX_READ_GRID)}x${String(MAX_READ_GRID)} px. Pass x, y, width and height`,
        { reason: 'region-too-large', max: MAX_READ_GRID, canvas: { w: cw, h: ch } },
      );
    }
    if (width < 1 || height < 1 || x + width > cw || y + height > ch) {
      throw new OpError(
        'REFUSED',
        `the region (${String(x)},${String(y)}) ${String(width)}x${String(height)} is outside the ${String(cw)}x${String(ch)} canvas`,
        { reason: 'out-of-canvas', canvas: { w: cw, h: ch } },
      );
    }

    let label: string;
    let frameIndex: number;
    let pixel: Parameters<typeof gridToText>[0];
    let source: 'render' | 'cel';
    if (input.layer === undefined) {
      source = 'render';
      label = animationLabel(resolveAnimation(ctx.doc, input.animation).animation);
      frameIndex = frameIndexOf(ctx, input.animation, input.frame);
      const img = ctx.renderFrame(input.animation, frameIndex, { exportOnly: true });
      pixel = (px, py) => img.get(px, py);
    } else {
      source = 'cel';
      const layer = resolveCelLayer(ctx.doc, input.layer);
      const { animation } = resolveAuthoredAnimation(ctx.doc, input.animation);
      const { index, frame } = resolveFrame(animation, input.frame);
      label = animationLabel(animation);
      frameIndex = index;
      pixel = celPixelReader(ctx.doc, celContent(ctx, layer, frame.id));
    }

    const grid = gridToText(pixel, x, y, width, height);
    return {
      animation: label,
      frameIndex,
      source,
      x,
      y,
      width,
      height,
      legend: grid.legend,
      rows: grid.rows,
      ...(input.rulers === true ? { ruled: withRulers(grid.rows, x, y) } : {}),
    };
  },
});
