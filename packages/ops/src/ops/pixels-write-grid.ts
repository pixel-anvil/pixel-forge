/**
 * `pixels.writeGrid`: paint a text grid (at most 32x32 px) into a frame (FR-AI-13). On a rig frame the
 * edit becomes override(s) through `attributeEdit`; on a flat frame it writes one pixel layer's cel.
 * @packageDocumentation
 */
import { attributeEditTxReport, referencedImages } from '@pixel-forge/core';
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import type { Rgba } from '@pixel-forge/raster';
import type { Document, LayerId } from '@pixel-forge/schema';
import { z } from 'zod';
import {
  activePalette,
  celContent,
  celPixelReader,
  paletteIndexOf,
  resolveCelLayer,
  transparentIndexOf,
} from '../cel.js';
import { defineOp } from '../define.js';
import { partRenderer } from '../part-renderer.js';
import { OpError } from '../errors.js';
import type { InputIssue } from '../errors.js';
import {
  GRID_SYMBOLS,
  HexColor,
  KEEP_SYMBOL,
  MAX_WRITE_GRID,
  TRANSPARENT_SYMBOL,
  parseHex,
  toHex,
} from '../grid.js';
import { frameIndexOf } from '../overlay.js';
import {
  AnimRef,
  DocRef,
  FrameRef,
  LayerRef,
  animationLabel,
  resolveAnimation,
  resolveAuthoredAnimation,
  resolveFrame,
  walkLayers,
} from '../refs.js';
import type { ReadonlyDocument } from '../refs.js';

/** What one grid cell asks for. */
type Cell = 'keep' | Rgba;

const TRANSPARENT: Rgba = [0, 0, 0, 0];

const sameColor = (a: Rgba, b: Rgba): boolean =>
  (a[3] === 0 && b[3] === 0) || (a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]);

function badGrid(message: string, issues: InputIssue[]): OpError {
  return new OpError('BAD_INPUT', message, { issues });
}

/**
 * Parses the legend and rows into a `height` x `width` array of cells.
 * @throws OpError `BAD_INPUT` (`details.issues`: `legend.<symbol>` / `rows.<n>`).
 */
function parseGrid(rows: readonly string[], legend: Readonly<Record<string, string>>): Cell[][] {
  const issues: InputIssue[] = [];
  const colours = new Map<string, Rgba>();
  for (const [symbol, hex] of Object.entries(legend)) {
    if (symbol === TRANSPARENT_SYMBOL || symbol === KEEP_SYMBOL) {
      issues.push({
        path: `legend.${symbol}`,
        message: `"${symbol}" is reserved ("." is transparent, "_" keeps the pixel); do not list it`,
      });
    } else if (symbol.length !== 1 || !GRID_SYMBOLS.includes(symbol)) {
      issues.push({ path: `legend.${symbol}`, message: 'a legend symbol is one of 0-9A-Za-z' });
    } else if (!HexColor.safeParse(hex).success) {
      issues.push({ path: `legend.${symbol}`, message: 'use "#rrggbb" or "#rrggbbaa"' });
    } else {
      colours.set(symbol, parseHex(hex));
    }
  }
  const width = rows[0]?.length ?? 0;
  rows.forEach((row, r) => {
    if (row.length !== width) {
      issues.push({
        path: `rows.${String(r)}`,
        message: `row ${String(r)} has ${String(row.length)} symbols, row 0 has ${String(width)}; all rows must be equally long`,
      });
    }
  });
  const grid = rows.map((row, r) =>
    Array.from({ length: row.length }, (_, c): Cell => {
      const ch = row.charAt(c);
      if (ch === TRANSPARENT_SYMBOL) return TRANSPARENT;
      if (ch === KEEP_SYMBOL) return 'keep';
      const colour = colours.get(ch);
      if (colour === undefined && issues.length < 20) {
        issues.push({
          path: `rows.${String(r)}`,
          message: `symbol "${ch}" at column ${String(c)} is not in the legend (legend: ${[...colours.keys()].join('') || 'empty'})`,
        });
      }
      return colour ?? TRANSPARENT;
    }),
  );
  if (issues.length > 0) {
    throw badGrid('the grid or its legend is invalid', issues);
  }
  return grid;
}

/**
 * Refuses colours the document's palette does not hold, when it is palette-locked or indexed (FR-PAL-06).
 * An RGBA document compares RGB; an indexed one needs the exact RGBA (the index is the colour).
 */
function checkPalette(doc: ReadonlyDocument, cells: readonly (readonly Cell[])[]): void {
  const palette = activePalette(doc);
  const indexed = doc.meta.colorMode === 'indexed';
  if (!indexed && !doc.meta.paletteLocked) return;
  if (palette === undefined) {
    throw new OpError('REFUSED', 'the document is palette-locked but has no active palette', {
      reason: 'no-palette',
    });
  }
  const missing = new Set<string>();
  for (const row of cells) {
    for (const cell of row) {
      if (cell === 'keep' || cell[3] === 0) continue;
      const found = indexed
        ? paletteIndexOf(palette, cell) !== undefined
        : palette.colors.some(
            (p) => p[3] > 0 && p[0] === cell[0] && p[1] === cell[1] && p[2] === cell[2],
          );
      if (!found) missing.add(toHex(cell));
    }
  }
  if (missing.size > 0) {
    throw new OpError(
      'REFUSED',
      `colours not in the ${indexed ? 'indexed' : 'palette-locked'} document's palette "${palette.name}": ${[...missing].sort().join(', ')}. Use palette colours (doc.summary lists them)`,
      { reason: 'off-palette', colors: [...missing].sort(), palette: palette.name },
    );
  }
}

/** Sets `layer`'s cel at `frameId` to `imageId` (a canvas-sized image at offset 0,0) in the draft. */
function setCel(
  draft: Document,
  layerId: LayerId,
  frameId: string,
  cel: { imageId: string; opacity: number },
): void {
  const visit = (layers: Document['layers']): boolean => {
    for (const l of layers) {
      if (l.kind === 'group' && visit(l.children)) return true;
      if ((l.kind === 'pixel' || l.kind === 'reference') && l.id === layerId) {
        Reflect.set(l.cels, frameId, {
          imageId: cel.imageId,
          offset: { x: 0, y: 0 },
          opacity: cel.opacity,
        });
        return true;
      }
    }
    return false;
  };
  visit(draft.layers);
}

/** `pixels.writeGrid` (MCP `pixels_write_grid`, CLI `pf pixels write-grid`). */
export const pixelsWriteGrid = defineOp({
  name: 'pixels.writeGrid',
  safety: 'mutate',
  summary:
    'Paint a text grid (at most 32x32 px) at (x, y) of a frame: "." transparent, "_" keep, other symbols from "legend". Rig frames get overrides; flat frames get a layer cel.',
  description:
    'Pass `rows` (equally long strings) and `legend` (symbol to "#rrggbb" or "#rrggbbaa"), as pixels.readGrid returns them. "." writes a transparent pixel and "_" leaves the pixel as it is. On a document with part layers (a rig) the grid edits the rendered frame and the differences are stored as overrides: a part override where a stroke lies inside one part, a final override otherwise; they survive re-posing and are listed by override.list (a new part override can make an earlier final override stale: see `newlyStale`). Otherwise name the pixel `layer` (optional when there is only one): its cel is rewritten. A palette-locked or indexed document only takes palette colours. Writing what is already there changes nothing. Check the result with render_frame and lint.',
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef,
    layer: LayerRef.optional().describe(
      'Pixel layer whose cel to write. Omit on a rig frame (the rendered frame is edited into overrides), or when the document has exactly one pixel layer.',
    ),
    x: z.int().min(0).optional().describe("Canvas column of the grid's left edge (default 0)."),
    y: z.int().min(0).optional().describe("Canvas row of the grid's top edge (default 0)."),
    rows: z
      .array(z.string().min(1).max(MAX_WRITE_GRID))
      .min(1)
      .max(MAX_WRITE_GRID)
      .describe(
        'Pixel rows, at most 32 rows of at most 32 equally long symbols: "." transparent, "_" keep, 0-9A-Za-z from the legend.',
      ),
    legend: z
      .record(z.string(), HexColor)
      .describe(
        'Symbol (one of 0-9A-Za-z) to colour "#rrggbb" or "#rrggbbaa". Only symbols used in `rows` need an entry.',
      ),
  }),
  output: z.strictObject({
    animation: z.string().describe('"group/direction" of the animation written.'),
    frameIndex: z.int().describe('0-based index of the frame written.'),
    target: z
      .enum(['overrides', 'cel'])
      .describe(
        '"overrides": rig frame, edits stored as overrides; "cel": a pixel layer cel was rewritten.',
      ),
    changed: z.int().describe('Pixels whose colour changed (0: nothing was written).'),
    layer: z.string().optional().describe('Name of the layer written; only for target "cel".'),
    overrides: z
      .array(z.string())
      .describe('Ids of the overrides created, in order; empty unless target is "overrides".'),
    newlyStale: z
      .array(z.string())
      .describe(
        'Ids of earlier overrides this edit made stale (still applied; re-base or discard them).',
      ),
  }),
  examples: [
    {
      title: "Move the hero's eye one pixel left (an override on the head)",
      input: {
        doc: 'doc_g1ed5q',
        animation: { group: 'default' },
        frame: 0,
        x: 26,
        y: 4,
        rows: ['21'],
        legend: { '1': '#e8be96', '2': '#1e1e28' },
      },
    },
  ],
  handler: (ctx, input) => {
    const doc = ctx.doc;
    const { w: cw, h: ch } = doc.meta.canvas;
    const x = input.x ?? 0;
    const y = input.y ?? 0;
    const cells = parseGrid(input.rows, input.legend);
    const width = cells[0]?.length ?? 0;
    const height = cells.length;
    if (x + width > cw || y + height > ch) {
      throw new OpError(
        'REFUSED',
        `the grid (${String(x)},${String(y)}) ${String(width)}x${String(height)} reaches outside the ${String(cw)}x${String(ch)} canvas`,
        { reason: 'out-of-canvas', canvas: { w: cw, h: ch } },
      );
    }
    checkPalette(doc, cells);

    const layers = walkLayers(doc);
    const hasParts = layers.some((l) => l.layer.kind === 'part');
    const pixelLayers = layers.filter((l) => l.layer.kind === 'pixel');
    let layerRef = input.layer;
    if (layerRef === undefined && !hasParts) {
      const only = pixelLayers[0];
      if (only === undefined || pixelLayers.length > 1) {
        throw new OpError(
          'REFUSED',
          pixelLayers.length === 0
            ? 'the document has no pixel layer to write'
            : `name the pixel layer to write: ${pixelLayers.map((l) => l.path).join(', ')}`,
          { reason: 'layer-required', available: pixelLayers.map((l) => l.path) },
        );
      }
      layerRef = only.layer.id;
    }

    // ---- rig frame: the rendered frame, edited into overrides --------------------------------
    if (layerRef === undefined) {
      const { animation } = resolveAnimation(doc, input.animation);
      const frameIndex = frameIndexOf(ctx, input.animation, input.frame);
      const before = ctx.renderFrame(input.animation, frameIndex, { exportOnly: true });
      const edited = before.clone();
      let changed = 0;
      cells.forEach((row, r) => {
        row.forEach((cell, c) => {
          if (cell === 'keep') return;
          if (sameColor(before.get(x + c, y + r), cell)) return;
          edited.set(x + c, y + r, cell);
          changed += 1;
        });
      });
      const base = {
        animation: animationLabel(animation),
        frameIndex,
        target: 'overrides' as const,
      };
      if (changed === 0) return { ...base, changed, overrides: [], newlyStale: [] };
      const rig = partRenderer(ctx);
      const report = attributeEditTxReport(
        ctx.tx,
        input.animation,
        frameIndex,
        edited,
        rig === undefined ? {} : { rig },
      );
      return {
        ...base,
        changed,
        overrides: [...report.ids],
        newlyStale: report.newlyStale.map((s) => s.overrideId),
      };
    }

    // ---- flat frame: one pixel layer's cel ---------------------------------------------------
    const layer = resolveCelLayer(doc, layerRef);
    if (layer.kind === 'reference') {
      throw new OpError('REFUSED', `layer ${layer.name} is a reference layer and is not written`, {
        reason: 'reference-layer',
      });
    }
    const { animation } = resolveAuthoredAnimation(doc, input.animation);
    const { index: frameIndex, frame } = resolveFrame(animation, input.frame);
    const cel = celContent(ctx, layer, frame.id);
    if (cel?.linked === true) {
      const link = layer.cels[frame.id];
      throw new OpError(
        'REFUSED',
        `layer ${layer.name} at frame ${String(frameIndex)} shares the cel of frame ${link !== undefined && 'linkTo' in link ? link.linkTo : '?'}; unlink it first, or write that frame (both change)`,
        { reason: 'linked-cel' },
      );
    }
    const palette = activePalette(doc);
    const indexed = doc.meta.colorMode === 'indexed';
    const read = celPixelReader(doc, cel);
    const base = {
      animation: animationLabel(animation),
      frameIndex,
      target: 'cel' as const,
      layer: layer.name,
      overrides: [],
      newlyStale: [],
    };

    let changed = 0;
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const cell = cells[r]?.[c];
        if (cell === undefined || cell === 'keep') continue;
        if (!sameColor(read(x + c, y + r), cell)) changed += 1;
      }
    }
    if (changed === 0) return { ...base, changed };

    // A new canvas-sized image holding the old cel pixels with the grid written over them.
    let next: TiledImage | IndexedImage;
    if (indexed) {
      if (palette === undefined) {
        throw new OpError('REFUSED', 'the document is indexed but has no active palette', {
          reason: 'no-palette',
        });
      }
      const transparent =
        cel?.image instanceof IndexedImage
          ? cel.image.transparentIndex
          : transparentIndexOf(palette);
      if (transparent === undefined) {
        throw new OpError('REFUSED', 'the palette has no transparent entry (alpha 0) for "."', {
          reason: 'no-transparent-index',
        });
      }
      const out = new IndexedImage(cw, ch, transparent);
      if (cel?.image instanceof IndexedImage) copyInto(cel.image, cel.offset, out);
      cells.forEach((row, r) => {
        row.forEach((cell, c) => {
          if (cell === 'keep') return;
          const index = cell[3] === 0 ? transparent : paletteIndexOf(palette, cell);
          if (index !== undefined) out.set(x + c, y + r, index);
        });
      });
      next = out;
    } else {
      const out = new TiledImage(cw, ch);
      if (cel?.image instanceof TiledImage) copyInto(cel.image, cel.offset, out);
      cells.forEach((row, r) => {
        row.forEach((cell, c) => {
          if (cell !== 'keep') out.set(x + c, y + r, cell);
        });
      });
      next = out;
    }
    const imageId = ctx.tx.createImage(next);
    ctx.tx.update((d) => {
      setCel(d, layer.id, frame.id, { imageId, opacity: cel?.opacity ?? 255 });
    });
    if (cel !== undefined && !referencedImages(ctx.tx.doc).has(cel.imageId)) {
      ctx.tx.deleteImage(cel.imageId);
    }
    return { ...base, changed };
  },
});

/** Copies the non-empty pixels of `src` (placed at `offset`) into `dst`. */
function copyInto(
  src: TiledImage | IndexedImage,
  offset: { readonly x: number; readonly y: number },
  dst: TiledImage | IndexedImage,
): void {
  const box = src.bounds();
  if (box === undefined) return;
  for (let yy = box.y; yy < box.y + box.h; yy++) {
    for (let xx = box.x; xx < box.x + box.w; xx++) {
      if (src instanceof TiledImage && dst instanceof TiledImage) {
        dst.set(xx + offset.x, yy + offset.y, src.get(xx, yy));
      } else if (src instanceof IndexedImage && dst instanceof IndexedImage) {
        dst.set(xx + offset.x, yy + offset.y, src.get(xx, yy));
      }
    }
  }
}
