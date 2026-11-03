/**
 * `shade.withRamp`: move pixels along a palette ramp (darker or lighter by N steps).
 * @packageDocumentation
 */
import { z } from 'zod';
import { activePalette } from '../cel.js';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { editOutputShape, editPixels, RegionInput, resolveRegion } from '../pixel-edit.js';
import { AnimRef, DocRef, FrameRef, LayerRef } from '../refs.js';

/** `shade.withRamp` (MCP `shade_with_ramp`, CLI `pf shade with-ramp`). */
export const shadeWithRamp = defineOp({
  name: 'shade.withRamp',
  safety: 'mutate',
  group: 'draw',
  summary: 'Shift pixels along a palette ramp by N steps (negative: darker), int px.',
  description:
    'A pixel whose colour is on the ramp (palette_ramp with add: true makes one) gets the colour N places along it, stopping at the ends. Other pixels are left alone and counted in skipped. Without "ramp", each pixel uses the first ramp that holds its colour. Ramps run dark to light by convention. On a rig omit layer: the change becomes overrides of this frame (touch-ups only).',
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef,
    layer: LayerRef.optional().describe(
      'Pixel layer to shade. Omit on a rig frame, or when the document has one pixel layer.',
    ),
    region: RegionInput.optional().describe('Pixels to shade (default: the whole canvas).'),
    ramp: z.string().min(1).optional().describe('Ramp name in the active palette (default: any).'),
    steps: z
      .int()
      .min(-64)
      .max(64)
      .refine((n) => n !== 0, 'steps must not be 0')
      .describe('Places along the ramp: +1 lighter, -1 darker.'),
  }),
  output: z.strictObject({
    ...editOutputShape,
    skipped: z.int().describe('Opaque pixels in the region that are on no ramp.'),
  }),
  examples: [
    {
      title: 'Darken the head area by one step of the "skin" ramp',
      input: {
        doc: 'doc_g1ed5q',
        animation: { group: 'default' },
        frame: 0,
        region: { x: 21, y: 2, w: 8, h: 8 },
        ramp: 'skin',
        steps: -1,
      },
    },
  ],
  handler: (ctx, input) => {
    const palette = activePalette(ctx.doc);
    if (palette === undefined) {
      throw new OpError('REFUSED', 'the document has no active palette, so it has no ramps', {
        reason: 'no-palette',
      });
    }
    const ramps =
      input.ramp === undefined ? palette.ramps : palette.ramps.filter((r) => r.name === input.ramp);
    if (input.ramp !== undefined && ramps.length === 0) {
      throw new OpError(
        'NOT_FOUND',
        `no ramp "${input.ramp}" in palette "${palette.name}" (ramps: ${palette.ramps.map((r) => r.name).join(', ') || 'none'})`,
        { available: palette.ramps.map((r) => r.name) },
      );
    }
    const key = (c: readonly number[]): string => c.join(',');
    // colour -> the colour `steps` places along the first ramp that holds it
    const shaded = new Map<string, readonly [number, number, number, number]>();
    for (const ramp of ramps) {
      ramp.indices.forEach((index, pos) => {
        const from = palette.colors[index];
        const to =
          palette.colors[ramp.indices[clamp(pos + input.steps, ramp.indices.length)] ?? -1];
        if (from === undefined || to === undefined || from[3] === 0) return;
        if (!shaded.has(key(from))) shaded.set(key(from), [to[0], to[1], to[2], to[3]]);
      });
    }
    const region = resolveRegion(ctx, input.region);
    let skipped = 0;
    const report = editPixels(ctx, input, (field) => {
      for (let y = region.y; y < region.y + region.h; y++) {
        for (let x = region.x; x < region.x + region.w; x++) {
          const c = field.get(x, y);
          if (c[3] === 0) continue;
          const to = shaded.get(key(c));
          if (to === undefined) skipped += 1;
          else field.set(x, y, to);
        }
      }
    });
    return { ...report, skipped };
  },
});

function clamp(pos: number, length: number): number {
  return Math.max(0, Math.min(length - 1, pos));
}
