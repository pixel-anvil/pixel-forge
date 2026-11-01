/**
 * `doc.create`: a new, empty, unsaved document.
 * @packageDocumentation
 */
import { DocumentStore } from '@pixel-forge/core';
import { defaultOrigin } from '@pixel-forge/io';
import { DocId, ID_SPACE, SCHEMA_VERSION, createIdGenerator } from '@pixel-forge/schema';
import type { Document } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';

/** `doc.create` (MCP `doc_create`, CLI `pf doc create`). */
export const docCreate = defineOp({
  name: 'doc.create',
  safety: 'io',
  summary:
    'Create a new empty RGBA document (no layers, no animations) and open it. Save it with doc_save.',
  description:
    'The origin defaults to the bottom-centre pixel of the canvas (where the feet go). Import art with import_file, add animations with anim_create, or apply a skeleton with rig_apply_template. Use doc_set_color_mode for indexed colour.',
  input: z.strictObject({
    name: z
      .string()
      .min(1)
      .max(128)
      .default('untitled')
      .describe('Display name (default "untitled").'),
    width: z.int().min(1).max(4096).describe('Canvas width, int px.'),
    height: z.int().min(1).max(4096).describe('Canvas height, int px.'),
    origin: z
      .strictObject({ x: z.int(), y: z.int() })
      .optional()
      .describe('Origin pixel on the canvas, int px (default: bottom-centre).'),
    pixelsPerUnit: z.number().gt(0).default(16).describe('Pixels per engine unit (default 16).'),
    idSeed: z
      .int()
      .min(0)
      .max(ID_SPACE - 1)
      .optional()
      .describe('Seed of the id generator (default: derived from the host clock).'),
  }),
  output: z.strictObject({
    doc: DocId.describe('Document id for the other ops.'),
    name: z.string().describe('Display name.'),
    canvas: z.strictObject({ w: z.int(), h: z.int() }).describe('Canvas size, px.'),
    origin: z.strictObject({ x: z.int(), y: z.int() }).describe('Origin pixel.'),
  }),
  examples: [
    {
      title: 'A 48x48 canvas',
      input: { name: 'hero', width: 48, height: 48 },
    },
  ],
  handler: async (ctx, input) => {
    // Ids derive from a seed; the default seed comes from the clock port (never Math.random) and is
    // bumped while a document with the same id is open, so two creates never collide.
    let seed = input.idSeed ?? Math.abs(ctx.host.clock.now().getTime()) % ID_SPACE;
    const tries = input.idSeed === undefined ? 1000 : 1;
    for (let i = 0; i < tries; i++, seed = (seed + 1) % ID_SPACE) {
      const gen = createIdGenerator({ seed, next: 0 });
      const id = gen.next('doc');
      if (ctx.host.get(id) !== undefined) continue;
      const w = input.width;
      const h = input.height;
      const doc: Document = {
        meta: {
          id,
          name: input.name,
          schemaVersion: SCHEMA_VERSION,
          canvas: { w, h },
          origin: input.origin ?? defaultOrigin([w, h]),
          pixelsPerUnit: input.pixelsPerUnit,
          colorMode: 'rgba',
          paletteLocked: false,
          ids: gen.state(),
        },
        palettes: [],
        skins: [],
        layers: [],
        animations: [],
        directionFallback: {},
        markerDefs: [],
        eventDefs: [],
      };
      const hosted = await ctx.host.adopt({ store: new DocumentStore(doc) });
      const meta = hosted.store.doc.meta;
      return {
        doc: hosted.id,
        name: meta.name,
        canvas: { w: meta.canvas.w, h: meta.canvas.h },
        origin: { x: meta.origin.x, y: meta.origin.y },
      };
    }
    throw new OpError('CONFLICT', `a document with id seed ${String(seed)} is already open`, {
      reason: 'id-seed-taken',
    });
  },
});
