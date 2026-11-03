/**
 * `palette.remap`: recolour the drawings by a mapping table, or swap the active palette's colours
 * (FR-PAL-05).
 *
 * Design: one op, two modes.
 * - `map`: `[{from, to}]`. Indexed documents map palette indices, RGBA documents map exact colours.
 *   The table applies at once (1 to 2 and 2 to 1 swaps two entries). Unlisted pixels and
 *   transparent pixels stay. Scope: the whole document, or one pixel layer and/or some frames.
 * - `swap`: the active palette's colours are replaced by another palette's (by id) or by a list of
 *   the same length; entry `i` keeps its index. Indexed pixels change colour on their own; RGBA
 *   pixels that equal old entry `i` become new entry `i`.
 * Palette-locked RGBA documents: `map` refuses a `to` colour that is not a palette entry (the result
 * would leave the palette; E5.2 only warns because its edit is on the palette itself), `swap` always
 * stays on the new palette.
 * @packageDocumentation
 */
import {
  applyColorTable,
  applyIndexLut,
  colorTable,
  indexLut,
  swapPairs,
} from '@pixel-forge/color';
import type { ColorPair, IndexPair } from '@pixel-forge/color';
import type { FrameId, RGBA8 } from '@pixel-forge/schema';
import { z } from 'zod';
import { activePalette, resolveCelLayer } from '../cel.js';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import type { InputIssue } from '../errors.js';
import { HexColor, toHex } from '../grid.js';
import type { OpContext } from '../context.js';
import { colorOf } from '../palette-target.js';
import { colorRecolor, indexRecolor, recolorDrawings } from '../recolor-drawings.js';
import type { DrawingScope, RecolorFn } from '../recolor-drawings.js';
import {
  AnimRef,
  DocRef,
  FrameRef,
  LayerRef,
  resolveAuthoredAnimation,
  resolveFrame,
} from '../refs.js';

const Entry = z.union([z.int().min(0).max(255), HexColor]);

const Pair = z.strictObject({
  from: Entry,
  to: Entry,
});

/** `palette.remap` (MCP `palette_remap`, CLI `pf palette remap`). */
export const paletteRemap = defineOp({
  name: 'palette.remap',
  safety: 'mutate',
  group: 'palette',
  summary: 'Recolour drawings with a mapping table, or swap the palette colours.',
  description:
    'Give map or swap. map: [{from,to}] by palette index (indexed document) or exact "#rrggbb[aa]" (RGBA); applied at once, unlisted and transparent pixels stay. Scope: all drawings, or layer and/or animation+frames (cels only). swap: {palette: id} or {colors: [...]} of the same length replaces the active colours, indices stay. Locked RGBA: a map target off the palette is refused.',
  input: z.strictObject({
    doc: DocRef,
    map: z.array(Pair).min(1).max(256).optional().describe('Mapping table.'),
    swap: z
      .strictObject({
        palette: z.string().optional().describe('Id of another palette of this document.'),
        colors: z.array(HexColor).min(1).max(256).optional().describe('New colours, same count.'),
      })
      .optional()
      .describe('Replace the active palette colours. Whole document only.'),
    layer: LayerRef.optional().describe('map: only this pixel layer.'),
    animation: AnimRef.optional().describe('map: only the cels of this animation (with frames).'),
    frames: z.array(FrameRef).min(1).max(256).optional().describe('map: only these frames.'),
  }),
  output: z.strictObject({
    mode: z.enum(['map', 'swap']),
    changed: z.int().describe('Pixels changed in all drawings.'),
    drawings: z
      .array(z.strictObject({ where: z.string(), changed: z.int() }))
      .describe('Drawings that changed, with their changed pixels.'),
    scanned: z.int().describe('Drawings looked at.'),
    palette: z.string().optional().describe('swap: palette id.'),
    colors: z.array(z.string()).optional().describe('swap: the colours afterwards.'),
  }),
  examples: [
    {
      title: 'Indexed: move red (3) to blue (5) in one layer',
      input: { doc: 'doc_g1ed5q', map: [{ from: 3, to: 5 }], layer: 'Body' },
    },
    {
      title: 'Swap in a team palette of the same length',
      input: { doc: 'doc_g1ed5q', swap: { colors: ['#00000000', '#1a1c2c', '#b13e53'] } },
    },
  ],
  handler: (ctx, input) => {
    const { doc, tx } = ctx;
    if ((input.map === undefined) === (input.swap === undefined)) {
      throw bad('', 'give exactly one of "map" and "swap"');
    }
    const palette = activePalette(doc);
    const indexed = doc.meta.colorMode === 'indexed';
    if (input.swap !== undefined) {
      if (
        input.layer !== undefined ||
        input.animation !== undefined ||
        input.frames !== undefined
      ) {
        throw bad('swap', 'swap changes the whole document; drop layer, animation and frames');
      }
      if (palette === undefined) {
        throw new OpError('REFUSED', 'the document has no active palette to swap', {
          reason: 'no-palette',
        });
      }
      const now: RGBA8[] = palette.colors.map((c) => [c[0], c[1], c[2], c[3]]);
      const next = swapColors(ctx, input.swap, palette.id);
      if (next.length !== now.length) {
        throw bad(
          'swap',
          `the new palette has ${String(next.length)} colours, the active one ${String(now.length)}; swap needs the same count`,
        );
      }
      let pairs: ColorPair[] = [];
      if (indexed) {
        now.forEach((a, i) => {
          if ((a[3] === 0) !== ((next[i]?.[3] ?? 0) === 0)) {
            throw new OpError(
              'REFUSED',
              `entry ${String(i)}: transparency must stay in the same entries`,
              { reason: 'transparency' },
            );
          }
        });
      } else {
        try {
          pairs = swapPairs(now, next);
        } catch (e) {
          if (!(e instanceof RangeError)) throw e;
          throw new OpError('REFUSED', e.message, { reason: 'swap' });
        }
      }
      let result;
      if (indexed) {
        const moved = new Set<number>();
        now.forEach((a, i) => {
          const b = next[i];
          if (b !== undefined && toHex(a) !== toHex(b)) moved.add(i);
        });
        // count only: the indices stay, the palette changes
        result = recolorDrawings(tx, {}, countIndexed(moved));
      } else {
        const table = colorTable(pairs);
        result = recolorDrawings(
          tx,
          {},
          colorRecolor((rgba) => applyColorTable(rgba, table)),
        );
      }
      tx.update((d) => {
        const p = d.palettes.find((x) => x.id === palette.id);
        if (p !== undefined) p.colors = next;
      });
      return {
        mode: 'swap' as const,
        ...result,
        palette: palette.id,
        colors: next.map((c) => toHex(c)),
      };
    }
    const map = input.map ?? [];
    const scope = resolveScope(ctx, input);
    let fn: RecolorFn;
    if (indexed) {
      if (palette === undefined) {
        throw new OpError('REFUSED', 'the document is indexed but has no active palette', {
          reason: 'no-palette',
        });
      }
      const pairs: IndexPair[] = [];
      const issues: InputIssue[] = [];
      map.forEach((m, n) => {
        for (const side of ['from', 'to'] as const) {
          const v = m[side];
          const at = `map.${String(n)}.${side}`;
          if (typeof v !== 'number') {
            issues.push({ path: at, message: 'this document is indexed: use a palette index' });
          } else if (v >= palette.colors.length) {
            issues.push({
              path: at,
              message: `index ${String(v)} is outside the palette (0..${String(palette.colors.length - 1)})`,
            });
          } else if ((palette.colors[v]?.[3] ?? 255) === 0) {
            throw new OpError(
              'REFUSED',
              `${at}: index ${String(v)} is transparent; transparent pixels stay transparent (erase with pixels_write_grid)`,
              { reason: 'transparent', index: v },
            );
          }
        }
        if (typeof m.from === 'number' && typeof m.to === 'number') pairs.push([m.from, m.to]);
      });
      if (issues.length > 0) {
        throw new OpError('BAD_INPUT', issues[0]?.message ?? 'bad mapping', { issues });
      }
      let lut: Uint8Array;
      try {
        lut = indexLut(pairs, palette.colors.length);
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        throw bad('map', e.message);
      }
      fn = indexRecolor((idx, keep) => applyIndexLut(idx, lut, keep));
    } else {
      const pairs: ColorPair[] = [];
      const issues: InputIssue[] = [];
      map.forEach((m, n) => {
        if (typeof m.from !== 'string' || typeof m.to !== 'string') {
          issues.push({
            path: `map.${String(n)}`,
            message: 'this document is RGBA: use "#rrggbb[aa]" colours',
          });
          return;
        }
        pairs.push([colorOf(m.from), colorOf(m.to)]);
      });
      if (issues.length > 0) {
        throw new OpError('BAD_INPUT', issues[0]?.message ?? 'bad mapping', { issues });
      }
      let table;
      try {
        table = colorTable(pairs);
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        throw new OpError('REFUSED', `${e.message} (erase with pixels_write_grid)`, {
          reason: 'transparent',
        });
      }
      if (doc.meta.paletteLocked && palette !== undefined) {
        const allowed = new Set(palette.colors.map((c) => toHex([c[0], c[1], c[2], c[3]])));
        for (const [, to] of table) {
          if (!allowed.has(toHex(to))) {
            throw new OpError(
              'REFUSED',
              `the document is palette-locked and ${toHex(to)} is not a palette colour; add it with palette_edit or unlock first`,
              { reason: 'off-palette', color: toHex(to) },
            );
          }
        }
      }
      fn = colorRecolor((rgba) => applyColorTable(rgba, table));
    }
    return { mode: 'map' as const, ...recolorDrawings(tx, scope, fn) };
  },
});

function bad(path: string, message: string): OpError {
  return new OpError('BAD_INPUT', message, { issues: [{ path, message }] });
}

/** A count-only recolour: pixels whose index is in `moved` (not transparent). */
function countIndexed(moved: ReadonlySet<number>): RecolorFn {
  return indexRecolor((idx, keep) => {
    let n = 0;
    for (const v of idx) if (v !== keep && moved.has(v)) n++;
    return n;
  });
}

/** The colours a swap brings, from `swap.colors` or another palette of the document. */
function swapColors(
  ctx: OpContext,
  swap: { readonly palette?: string | undefined; readonly colors?: readonly string[] | undefined },
  activeId: string,
): RGBA8[] {
  if ((swap.palette === undefined) === (swap.colors === undefined)) {
    throw bad('swap', 'swap takes exactly one of "palette" and "colors"');
  }
  if (swap.colors !== undefined) return swap.colors.map((h) => colorOf(h));
  if (swap.palette === activeId) throw bad('swap.palette', 'that is the active palette already');
  const other = ctx.doc.palettes.find((p) => p.id === swap.palette);
  if (other === undefined) {
    throw new OpError('NOT_FOUND', `no palette ${String(swap.palette)}`, {
      kind: 'palette',
      available: ctx.doc.palettes.map((p) => p.id),
    });
  }
  return other.colors.map((c): RGBA8 => [c[0], c[1], c[2], c[3]]);
}

/** Resolves `layer`, `animation` and `frames` into a {@link DrawingScope}. */
function resolveScope(
  ctx: OpContext,
  input: {
    readonly layer?: string | undefined;
    readonly animation?: z.output<typeof AnimRef> | undefined;
    readonly frames?: readonly z.output<typeof FrameRef>[] | undefined;
  },
): DrawingScope {
  const layerId = input.layer === undefined ? undefined : resolveCelLayer(ctx.doc, input.layer).id;
  if (input.frames !== undefined && input.animation === undefined) {
    throw bad('frames', 'frames needs "animation" (frame indices belong to one animation)');
  }
  if (input.animation === undefined) return layerId === undefined ? {} : { layerId };
  const { animation } = resolveAuthoredAnimation(ctx.doc, input.animation);
  const picked =
    input.frames === undefined
      ? animation.frames
      : input.frames.map((f) => resolveFrame(animation, f).frame);
  const frameIds = new Set<FrameId>(picked.map((f) => f.id));
  return layerId === undefined ? { frameIds } : { layerId, frameIds };
}
