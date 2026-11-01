/**
 * `doc.save`: write a hosted document to a `.pxf` file (first save, save, save-as), atomically.
 * @packageDocumentation
 */
import { buildPxf, saveAtomic } from '@pixel-forge/io';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { DocRef } from '../refs.js';

/** `doc.save` (MCP `doc_save`, CLI `pf doc save`). */
export const docSave = defineOp({
  name: 'doc.save',
  safety: 'io',
  summary: 'Save the document to its .pxf file, or to a new path (first save, save as).',
  description:
    "The path must be inside the workspace roots. Writes a temp file in the same folder and renames it over the target, so a crash never leaves a torn file. A new path takes the document's lock first (DOC_LOCKED if another process owns it) and releases the old one. An existing file at a new path is refused unless overwrite is true. Saving an unchanged, already saved document writes nothing.",
  input: z.strictObject({
    doc: DocRef,
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Target .pxf path (absolute, inside the workspace roots). Default: the current path.',
      ),
    overwrite: z
      .boolean()
      .default(false)
      .describe('Replace an existing file at a new path (default false).'),
  }),
  output: z.strictObject({
    path: z.string().describe('Normalised path saved to.'),
    wrote: z.boolean().describe('False when the document was unchanged and nothing was written.'),
    bytes: z.int().describe('Size of the file written, bytes (0 when nothing was written).'),
    version: z.int().describe('Store version that was saved.'),
  }),
  examples: [
    {
      title: 'Save the hero under a new name',
      input: { doc: 'doc_g1ed5q', path: '/work/hero-v2.pxf' },
    },
  ],
  handler: async (ctx, input) => {
    const hosted = ctx.document;
    const { host } = ctx;
    const previousPath = hosted.path;
    const wanted = input.path ?? previousPath;
    if (wanted === undefined) {
      throw new OpError('BAD_INPUT', 'this document has no path yet; pass "path"', {
        issues: [{ path: 'path', message: 'required for a document that was never saved' }],
      });
    }
    const target = host.resolvePath(wanted);
    const moved = target !== previousPath;
    if (moved && !input.overwrite && (await host.fs.exists(target))) {
      throw new OpError('CONFLICT', `${target} exists; pass "overwrite": true to replace it`, {
        reason: 'file-exists',
        path: target,
      });
    }
    // Build before taking the new lock: a render failure then leaves everything as it was.
    const version = hosted.store.version;
    const built = buildPxf(hosted.store, {
      clock: host.clock,
      rig: host.renderer,
      ...(hosted.file === undefined ? {} : { previous: hosted.file }),
    });
    if (!moved && !built.changed && hosted.file !== undefined) {
      hosted.savedVersion = version;
      return { path: target, wrote: false, bytes: 0, version };
    }
    if (moved) await host.rebind(hosted.id, target);
    try {
      await saveAtomic(host.fs, target, built.bytes);
    } catch (e) {
      // Give the lock of the old path back; a never-saved document keeps the new path (retry works).
      if (moved && previousPath !== undefined) {
        await host.rebind(hosted.id, previousPath).catch(() => undefined);
      }
      throw e;
    }
    hosted.file = built.file;
    hosted.savedVersion = version;
    ctx.log.info('saved', { doc: hosted.id, path: target, bytes: built.bytes.length });
    return { path: target, wrote: true, bytes: built.bytes.length, version };
  },
});
