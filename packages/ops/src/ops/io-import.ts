/**
 * `io.import`: import a PNG, a grid spritesheet (with cell ranges) or an `.aseprite` file into a document.
 * @packageDocumentation
 */
import { importAsepriteTx, importSpritesheetTx, reimportAsepriteTx } from '@pixel-forge/io';
import type { SheetAnimationSpec } from '@pixel-forge/io';
import { DirectionName, LoopMode, Name } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { pngSize, readBytes } from '../file-io.js';
import { DocRef, ViewRef, animationLabel, resolveView, walkLayers } from '../refs.js';

/** Most cells one animation may list after ranges are expanded. */
export const MAX_CELLS = 4096;

const Span = z.union([
  z.int().min(0),
  z.string().regex(/^\d+(-\d+)?$/, 'expected "n" or "from-to"'),
]);

/** One cell or range of cells: `[row, col]`, or `{row, col}` where either may be a range "3-6". */
export const CellSpec = z.union([
  z.tuple([z.int().min(0), z.int().min(0)]),
  z.strictObject({
    row: Span.describe('Row (0-based, row 0 on top), or a range "from-to".'),
    col: Span.describe('Column (0-based), or a range "from-to".'),
  }),
]);

function span(v: string | number, what: string): number[] {
  if (typeof v === 'number') return [v];
  const [a, b] = v.split('-').map(Number) as [number, number | undefined];
  const to = b ?? a;
  const out: number[] = [];
  const step = to >= a ? 1 : -1;
  for (let n = a; out.length <= MAX_CELLS; n += step) {
    out.push(n);
    if (n === to) break;
  }
  if (out.length > MAX_CELLS) {
    throw new OpError('BAD_INPUT', `${what} "${v}" is too long`, {
      issues: [{ path: what, message: `at most ${String(MAX_CELLS)} cells` }],
    });
  }
  return out;
}

/** Expands cell specs to `[row, col]` pairs: ranges ascend or descend, rows outer, columns inner. */
export function expandCells(
  cells: readonly z.infer<typeof CellSpec>[],
  at: string,
): [number, number][] {
  const out: [number, number][] = [];
  cells.forEach((c, i) => {
    if (Array.isArray(c)) out.push([c[0], c[1]]);
    else {
      const spec = c;
      for (const r of span(spec.row, `${at}.${String(i)}.row`)) {
        for (const col of span(spec.col, `${at}.${String(i)}.col`)) out.push([r, col]);
      }
    }
    if (out.length > MAX_CELLS) {
      throw new OpError('BAD_INPUT', `more than ${String(MAX_CELLS)} cells`, {
        issues: [{ path: at, message: `at most ${String(MAX_CELLS)} cells per animation` }],
      });
    }
  });
  return out;
}

const AnimationSpec = z.strictObject({
  group: Name.describe('Animation group, e.g. "move_gather".'),
  direction: DirectionName.optional().describe('Direction (omit for undirected).'),
  cells: z
    .array(CellSpec)
    .min(1)
    .describe(
      'Cells in play order: [row, col], or {"row": 4, "col": "3-6"} for row 4, columns 3 to 6.',
    ),
  durationMs: z.int().min(1).optional().describe('Frame duration, ms (wins over fps).'),
  fps: z.number().gt(0).optional().describe('Frames per second.'),
  loop: LoopMode.optional().describe('"loop" (default), "once" or "pingpong".'),
});

const FORMATS = ['spritesheet', 'aseprite'] as const;

/** `io.import` (MCP `import_file`, CLI `pf import`). */
export const ioImport = defineOp({
  name: 'io.import',
  safety: 'io',
  summary: 'Import a PNG spritesheet (cells per animation) or an .aseprite file into a document.',
  description:
    "Format is guessed from the extension. Spritesheet: animations maps cells to animations; repeated cells become linked cels; the cell's bottom-centre lands on the document origin. Aseprite: adds layers, tags (as animations) and the palette; the canvas must equal the document's. A failed import changes nothing.",
  mcp: { name: 'import_file' },
  cli: { command: ['import'] },
  input: z.strictObject({
    doc: DocRef,
    file: z.string().min(1).describe('Path of the file (absolute, inside the workspace roots).'),
    format: z.enum(FORMATS).optional().describe('Default: from the file extension.'),
    cell: z
      .tuple([z.int().min(1), z.int().min(1)])
      .optional()
      .describe('spritesheet: cell size [w, h] px (default: the whole image is one cell).'),
    animations: z
      .array(AnimationSpec)
      .min(1)
      .optional()
      .describe('spritesheet: the animations to cut (required for a spritesheet).'),
    outlineFile: z
      .string()
      .min(1)
      .optional()
      .describe('spritesheet: matching outline sheet, same size.'),
    layerName: Name.optional().describe(
      'spritesheet: layer for the cels (default "body"; reused if it exists).',
    ),
    outlineLayerName: Name.optional().describe(
      'spritesheet: layer of the outline sheet (default "outline").',
    ),
    defaultDurationMs: z
      .int()
      .min(1)
      .optional()
      .describe('spritesheet: frame duration when an animation gives none (default 100).'),
    reimport: z
      .boolean()
      .default(false)
      .describe('aseprite: update a file imported earlier instead of adding (default false).'),
    view: ViewRef.optional().describe(
      'aseprite: rig view for "part:" layers without #view (default: the first).',
    ),
    paletteName: z.string().min(1).optional().describe('aseprite: name of the imported palette.'),
  }),
  output: z.strictObject({
    format: z.enum(FORMATS),
    animations: z
      .array(z.string())
      .describe('Animations created or matched, as "group/direction".'),
    layers: z.array(z.string()).describe('Layers that received the pixels (names).'),
    frames: z.int().describe('Frames created (re-import: frames in the file).'),
    images: z.int().describe('Images created.'),
    parts: z
      .strictObject({ bound: z.int(), updated: z.int(), unbound: z.int() })
      .optional()
      .describe('aseprite: "part:" layers bound, updated (re-import) or left as pixel layers.'),
    warnings: z.array(z.string()).describe('Non-fatal findings.'),
  }),
  examples: [
    {
      title: 'Cut row 0, columns 0 to 2 of a 64x64 sheet into move_gather at 12 fps',
      input: {
        doc: 'doc_g1ed5q',
        file: '/work/run.png',
        cell: [64, 64],
        animations: [{ group: 'move_gather', cells: [{ row: 0, col: '0-2' }], fps: 12 }],
      },
    },
  ],
  handler: async (ctx, input) => {
    const { host } = ctx;
    const path = host.resolvePath(input.file);
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const format =
      input.format ??
      (ext === 'png'
        ? 'spritesheet'
        : ext === 'aseprite' || ext === 'ase'
          ? 'aseprite'
          : undefined);
    if (format === undefined) {
      throw new OpError('BAD_INPUT', `cannot tell the format of ${path}; pass "format"`, {
        issues: [{ path: 'format', message: 'required for this extension' }],
      });
    }

    if (format === 'aseprite') {
      const bytes = await readBytes(ctx, path);
      const viewId = input.view === undefined ? undefined : resolveView(ctx.doc, input.view).id;
      const run = input.reimport ? reimportAsepriteTx : importAsepriteTx;
      // Last: the transaction commits here (OPS-01); everything after only reads the result.
      const report = ctx.transact((tx) =>
        run(tx, bytes, {
          ...(viewId === undefined ? {} : { viewId }),
          ...(input.paletteName === undefined ? {} : { paletteName: input.paletteName }),
        }),
      );
      return {
        format,
        animations: report.animations.map(
          (a) => a.group + (a.tag === undefined ? '' : `/${a.tag}`),
        ),
        layers: report.layers.map((l) => l.name),
        frames: report.animations.reduce((n, a) => n + a.frames, 0),
        images: report.images.created,
        parts: {
          bound: report.parts.bound.length,
          updated: report.parts.updated.length,
          unbound: report.parts.unbound.length,
        },
        warnings: [...report.warnings],
      };
    }

    if (input.animations === undefined) {
      throw new OpError('BAD_INPUT', 'a spritesheet import needs "animations"', {
        issues: [{ path: 'animations', message: 'required for a spritesheet' }],
      });
    }
    const png = await readBytes(ctx, path);
    const size = input.cell === undefined ? pngSize(png, path) : undefined;
    const cell: [number, number] = input.cell ?? [size?.w ?? 1, size?.h ?? 1];
    const outlinePng =
      input.outlineFile === undefined
        ? undefined
        : await readBytes(ctx, host.resolvePath(input.outlineFile));
    const specs: SheetAnimationSpec[] = input.animations.map((a, i) => ({
      group: a.group,
      ...(a.direction === undefined ? {} : { direction: a.direction }),
      frames: expandCells(a.cells, `animations.${String(i)}.cells`),
      ...(a.durationMs === undefined ? {} : { durationMs: a.durationMs }),
      ...(a.fps === undefined ? {} : { fps: a.fps }),
      ...(a.loop === undefined ? {} : { loop: a.loop }),
    }));
    const result = ctx.transact((tx) =>
      importSpritesheetTx(tx, {
        png,
        cell,
        animations: specs,
        ...(outlinePng === undefined ? {} : { outlinePng }),
        ...(input.layerName === undefined ? {} : { layerName: input.layerName }),
        ...(input.outlineLayerName === undefined
          ? {}
          : { outlineLayerName: input.outlineLayerName }),
        ...(input.defaultDurationMs === undefined
          ? {}
          : { defaultDurationMs: input.defaultDurationMs }),
      }),
    );
    const doc = ctx.doc;
    const layerName = (id: string): string =>
      walkLayers(doc).find((l) => l.layer.id === id)?.layer.name ?? id;
    return {
      format,
      animations: result.animations.map((id) => {
        const a = doc.animations.find((x) => x.id === id);
        return a === undefined ? id : animationLabel(a);
      }),
      layers: [
        result.layer,
        ...(result.outlineLayer === undefined ? [] : [result.outlineLayer]),
      ].map(layerName),
      frames: result.frames,
      images: result.imageCels,
      warnings: [],
    };
  },
});
