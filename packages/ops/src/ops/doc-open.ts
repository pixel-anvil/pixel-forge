/**
 * `doc.open`: read a `.pxf` through the host's file system and host it.
 * @packageDocumentation
 */
import { pxfStore, readPxf } from '@pixel-forge/io';
import { DocId } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import type { OpContext } from '../context.js';
import { OpError } from '../errors.js';
import type { OpHost } from '../host.js';

const Output = z.strictObject({
  doc: DocId.describe('Document id for the other ops.'),
  path: z.string().describe('Normalised path.'),
  name: z.string().describe('Document display name.'),
  alreadyOpen: z.boolean().describe('True when the file was open already.'),
  warnings: z
    .array(z.string())
    .describe('Problems found while reading (e.g. a dropped render cache).'),
});

/** `doc.open` (MCP `doc_open`, CLI `pf doc open`). */
export const docOpen = defineOp({
  name: 'doc.open',
  safety: 'io',
  summary: 'Open a .pxf file and return its document id, which every other op takes as "doc".',
  description:
    'Opening a file that is already open returns the same id (alreadyOpen: true) without re-reading it. Follow with doc_summary to see layers, rig and animations.',
  input: z.strictObject({
    path: z
      .string()
      .min(1)
      .describe('Path of the .pxf file (absolute, inside the workspace roots).'),
  }),
  output: Output,
  examples: [
    {
      title: 'Open the synthetic hero',
      input: { path: '/work/hero.pxf' },
      output: {
        doc: 'doc_g1ed5q',
        path: '/work/hero.pxf',
        name: 'hero',
        alreadyOpen: false,
        warnings: [],
      },
    },
  ],
  handler: async (ctx, input) => {
    const path = ctx.host.resolvePath(input.path);
    const open = ctx.host.byPath(path);
    if (open !== undefined) {
      return {
        doc: open.id,
        path,
        name: open.store.doc.meta.name,
        alreadyOpen: true,
        warnings: [],
      };
    }
    // A second call for a path that is being opened waits for the first and shares its document
    // (otherwise it would read the file again and fail with CONFLICT in `adopt`).
    let opening = pending.get(ctx.host);
    if (opening === undefined) {
      opening = new Map<string, Promise<Opened>>();
      pending.set(ctx.host, opening);
    }
    const inFlight = opening.get(path);
    if (inFlight !== undefined) {
      const first = await inFlight;
      return { ...first, alreadyOpen: true, warnings: [] };
    }
    const mine = openFile(ctx, path);
    opening.set(path, mine);
    try {
      return await mine;
    } finally {
      opening.delete(path);
    }
  },
});

type Opened = z.infer<typeof Output>;

/** `doc.open` calls in flight, per host and normalised path. */
const pending = new WeakMap<OpHost, Map<string, Promise<Opened>>>();

/** Reads `path` and hands the store to the host. */
async function openFile(ctx: OpContext, path: string): Promise<Opened> {
  let bytes: Uint8Array;
  try {
    bytes = await ctx.host.fs.readFile(path);
  } catch (e) {
    throw new OpError(
      'IO_FAILED',
      `cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`,
      { path },
      { cause: e },
    );
  }
  const file = readPxf(bytes);
  const hosted = await ctx.host.adopt({ store: pxfStore(file), path, file });
  ctx.log.info('opened', { doc: hosted.id, path });
  return {
    doc: hosted.id,
    path,
    name: file.doc.meta.name,
    alreadyOpen: false,
    warnings: [...file.warnings],
  };
}
