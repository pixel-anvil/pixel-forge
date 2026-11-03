/**
 * `draw.shapes`: lines, rectangles, ellipses and flood fills on a frame, pixel-exact.
 * Algorithms (all integer, in `@pixel-forge/raster`): Bresenham line (error-term form, same pixels
 * from A to B and B to A), rectangle outline or fill, ellipse after Alois Zingl's "A Rasterizing
 * Algorithm for Drawing Curves" (2012, free of copyright), 4-connected flood fill.
 * @packageDocumentation
 */
import { ellipse, floodFill, line, rect } from '@pixel-forge/raster';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import type { InputIssue } from '../errors.js';
import { HexColor, parseHex } from '../grid.js';
import { editOutputShape, editPixels } from '../pixel-edit.js';
import { AnimRef, DocRef, FrameRef, LayerRef } from '../refs.js';
import { checkPalette } from './pixels-write-grid.js';

/** The most shapes in one call. */
export const MAX_SHAPES = 64;

const Coord = z.int().min(-32768).max(32767);

const Shape = z.strictObject({
  type: z.enum(['line', 'rect', 'ellipse', 'fill']).describe('Shape kind.'),
  x: Coord.describe('line: start x. rect/ellipse: left. fill: seed x.'),
  y: Coord.describe('line: start y. rect/ellipse: top. fill: seed y.'),
  x2: Coord.optional().describe('line: end x (inclusive).'),
  y2: Coord.optional().describe('line: end y (inclusive).'),
  w: z.int().min(1).max(32768).optional().describe('rect/ellipse: width, px.'),
  h: z.int().min(1).max(32768).optional().describe('rect/ellipse: height, px.'),
  color: HexColor.describe('"#rrggbb[aa]"; "#00000000" erases.'),
  filled: z
    .boolean()
    .optional()
    .describe('rect/ellipse: fill the inside too (default: 1 px outline).'),
});

/** `draw.shapes` (MCP `draw_shapes`, CLI `pf draw shapes`). */
export const drawShapes = defineOp({
  name: 'draw.shapes',
  safety: 'mutate',
  group: 'draw',
  summary: 'Draw lines, rects, ellipses and flood fills (int px) on a frame, in order.',
  description:
    'Pixels are replaced, not blended. Line ends and box sizes are inclusive. Parts off the canvas are clipped. fill replaces the 4-connected area of the seed colour. On a rig omit layer: the change becomes overrides of this frame (touch-ups only). Locked palettes only take palette colours.',
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef,
    layer: LayerRef.optional().describe(
      'Pixel layer to draw on. Omit on a rig frame, or when the document has one pixel layer.',
    ),
    shapes: z
      .array(Shape)
      .min(1)
      .max(MAX_SHAPES)
      .describe('Drawn in order; later ones see earlier ones.'),
  }),
  output: z.strictObject({ ...editOutputShape, shapes: z.int().describe('Shapes drawn.') }),
  examples: [
    {
      title: 'A 6x4 red box with a blue diagonal',
      input: {
        doc: 'doc_g1ed5q',
        animation: { group: 'default' },
        frame: 0,
        shapes: [
          { type: 'rect', x: 2, y: 2, w: 6, h: 4, color: '#ff0000', filled: true },
          { type: 'line', x: 2, y: 2, x2: 7, y2: 5, color: '#0000ff' },
        ],
      },
    },
  ],
  handler: (ctx, input) => {
    const issues: InputIssue[] = [];
    input.shapes.forEach((s, i) => {
      const at = (f: string): string => `shapes.${String(i)}.${f}`;
      const need = (f: 'x2' | 'y2' | 'w' | 'h'): void => {
        if (s[f] === undefined) issues.push({ path: at(f), message: `${s.type} needs "${f}"` });
      };
      const forbid = (f: 'x2' | 'y2' | 'w' | 'h' | 'filled'): void => {
        if (s[f] !== undefined) issues.push({ path: at(f), message: `${s.type} has no "${f}"` });
      };
      if (s.type === 'line') {
        need('x2');
        need('y2');
        forbid('w');
        forbid('h');
        forbid('filled');
      } else if (s.type === 'fill') {
        for (const f of ['x2', 'y2', 'w', 'h', 'filled'] as const) forbid(f);
      } else {
        need('w');
        need('h');
        forbid('x2');
        forbid('y2');
      }
    });
    if (issues.length > 0) throw new OpError('BAD_INPUT', 'a shape has wrong fields', { issues });
    checkPalette(ctx.doc, [input.shapes.map((s) => parseHex(s.color))]);
    const { w: cw, h: ch } = ctx.doc.meta.canvas;
    const result = editPixels(ctx, input, (field) => {
      input.shapes.forEach((s, i) => {
        const colour = parseHex(s.color);
        if (s.type === 'line') {
          line(field.image, s.x, s.y, s.x2 ?? s.x, s.y2 ?? s.y, colour);
        } else if (s.type === 'rect') {
          rect(field.image, s.x, s.y, s.w ?? 1, s.h ?? 1, colour, { fill: s.filled === true });
        } else if (s.type === 'ellipse') {
          ellipse(field.image, s.x, s.y, s.x + (s.w ?? 1) - 1, s.y + (s.h ?? 1) - 1, colour, {
            fill: s.filled === true,
          });
        } else {
          if (s.x < 0 || s.y < 0 || s.x >= cw || s.y >= ch) {
            throw new OpError(
              'REFUSED',
              `shapes.${String(i)}: the fill seed (${String(s.x)},${String(s.y)}) is outside the ${String(cw)}x${String(ch)} canvas`,
              { reason: 'out-of-canvas', canvas: { w: cw, h: ch } },
            );
          }
          floodFill(field.image, s.x, s.y, colour);
        }
      });
    });
    return { ...result, shapes: input.shapes.length };
  },
});
