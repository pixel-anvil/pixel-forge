/**
 * `pxf.unpack` and `pxf.pack`: a `.pxf` file to and from its `.pxfd/` folder form (spec 7, ADR-005),
 * through `io` so the archive stays deterministic.
 * @packageDocumentation
 */
import { GDIGNORE, pack, unpack } from '@pixel-forge/io';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';

const PXFD = '.pxfd';
const PXF = '.pxf';

/** `path` without `ext`; `BAD_INPUT` (on `field`) when it does not end in it. */
function stem(path: string, ext: string, field: string): string {
  if (!path.toLowerCase().endsWith(ext)) {
    throw new OpError('BAD_INPUT', `${field} must end in ${ext}`, {
      issues: [{ path: field, message: `expected a ${ext} path` }],
    });
  }
  return path.slice(0, -ext.length);
}

/** `pxf.unpack` (MCP `pxf_unpack`, CLI `pf unpack`). */
export const pxfUnpack = defineOp({
  name: 'pxf.unpack',
  safety: 'io',
  cli: { command: ['unpack'] },
  summary: 'Expand a .pxf into a .pxfd folder (manifest, document, images, render cache).',
  description:
    'Writes one file per archive entry (bytes verbatim) plus an empty .gdignore so Godot ignores the PNGs; the folder diffs well in git. dir defaults to the file name with .pxfd. An existing folder is refused unless overwrite is true (only a folder named *.pxfd is ever replaced). Does not open the document; pxf_pack is the inverse.',
  input: z.strictObject({
    file: z.string().min(1).describe('The .pxf to expand (absolute, inside the workspace roots).'),
    dir: z
      .string()
      .min(1)
      .optional()
      .describe('Folder to create, named *.pxfd (default: beside the file).'),
    overwrite: z.boolean().default(false).describe('Replace an existing folder (default false).'),
  }),
  output: z.strictObject({
    file: z.string().describe('The .pxf that was read.'),
    dir: z.string().describe('The folder written.'),
  }),
  examples: [
    {
      title: 'Expand hero.pxf next to itself',
      input: { file: '/work/hero.pxf' },
      output: { file: '/work/hero.pxf', dir: '/work/hero.pxfd' },
    },
  ],
  handler: async (ctx, input) => {
    const { host } = ctx;
    const file = host.resolvePath(input.file);
    const dir = host.resolvePath(input.dir ?? `${stem(file, PXF, 'file')}${PXFD}`);
    stem(dir, PXFD, 'dir');
    await unpack(host.fs, file, dir, { overwrite: input.overwrite });
    return { file, dir };
  },
});

/** `pxf.pack` (MCP `pxf_pack`, CLI `pf pack`). */
export const pxfPack = defineOp({
  name: 'pxf.pack',
  safety: 'io',
  cli: { command: ['pack'] },
  summary: 'Build a .pxf from a .pxfd folder (the inverse of pxf_unpack).',
  description: `Packs manifest.json, document.json, images/ and render/ of the folder; ${GDIGNORE} and other files are ignored. The archive is built by the same deterministic writer as a save, atomically, replacing an existing file. file defaults to the folder name with .pxf. Does not open the document: open the result to validate it.`,
  input: z.strictObject({
    dir: z.string().min(1).describe('The .pxfd folder (absolute, inside the workspace roots).'),
    file: z
      .string()
      .min(1)
      .optional()
      .describe('The .pxf to write, named *.pxf (default: beside the folder).'),
  }),
  output: z.strictObject({
    dir: z.string().describe('The folder that was read.'),
    file: z.string().describe('The .pxf written.'),
  }),
  examples: [
    {
      title: 'Rebuild hero.pxf from its folder',
      input: { dir: '/work/hero.pxfd' },
      output: { dir: '/work/hero.pxfd', file: '/work/hero.pxf' },
    },
  ],
  handler: async (ctx, input) => {
    const { host } = ctx;
    const dir = host.resolvePath(input.dir);
    const file = host.resolvePath(input.file ?? `${stem(dir, PXFD, 'dir')}${PXF}`);
    stem(file, PXF, 'file');
    await pack(host.fs, file, dir);
    return { dir, file };
  },
});
