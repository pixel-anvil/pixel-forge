/**
 * Labelled contact sheet (FR-AI-12): a grid of frames on a checkerboard with a "group/direction #n"
 * label under each, sized so the long edge stays within a limit (default 1568 px, the vision-model
 * budget).
 * @packageDocumentation
 */
import type { DocumentView, SkinRef } from '@pixel-forge/core';
import { TiledImage } from '@pixel-forge/raster';
import type { AnimRef } from '@pixel-forge/schema';
import { MAX_SCALE, blank, blitScaled, checkScale, fillRect } from './dense.js';
import type { Dense } from './dense.js';
import { IoError } from './errors.js';
import { FONT_H, FONT_W, glyph, textWidth } from './font.js';
import { renderDense, sheetAnimations } from './sheet-export.js';

/** Default long-edge limit in pixels. */
export const DEFAULT_MAX_LONG_EDGE = 1568;

/** Options of {@link contactSheet}. */
export interface ContactSheetOptions {
  /** Animations to show, in order. Default: all. */
  animations?: readonly AnimRef[];
  /**
   * Integer scale 1..16 to start from. Default: the largest scale that fits `maxLongEdge`. If an
   * explicit scale does not fit, it is reduced until it does ("auto-reduce").
   */
  scale?: number;
  /** Draw "group/direction #n" under each frame. Default true. */
  labels?: boolean;
  /** Longest allowed side of the result in pixels. Default 1568. */
  maxLongEdge?: number;
  /** Skin; default base. */
  skin?: SkinRef | 'base';
  /** Render only export layers. Default true. */
  exportOnly?: boolean;
  /** Marks drawn on each frame: the document origin (magenta) and/or the frame's markers (cyan). */
  overlay?: { origin?: boolean; markers?: boolean };
}

/** One frame tile of a {@link ContactSheetPlan}. */
export interface ContactSheetTile {
  /** `group/direction #n` (`group #n` when undirected); n is the 0-based frame index. */
  label: string;
  anim: AnimRef;
  index: number;
  /** Top-left of the tile (frame plus label area). */
  x: number;
  y: number;
}

/** The computed layout of a contact sheet. */
export interface ContactSheetPlan {
  scale: number;
  /** Integer scale of the label font (1 or 2). */
  fontScale: number;
  columns: number;
  rows: number;
  tileW: number;
  tileH: number;
  width: number;
  height: number;
  tiles: ContactSheetTile[];
}

const PAD = 2;
const GAP = 2;
const BG: readonly [number, number, number, number] = [32, 32, 36, 255];
const CHECK_A: readonly [number, number, number, number] = [200, 200, 200, 255];
const CHECK_B: readonly [number, number, number, number] = [150, 150, 150, 255];
const LABEL_COLOR: readonly [number, number, number, number] = [255, 255, 255, 255];
const ORIGIN_COLOR: readonly [number, number, number, number] = [255, 0, 255, 255];
const MARKER_COLOR: readonly [number, number, number, number] = [0, 255, 255, 255];
const CHECK_SIZE = 4;

interface Entry {
  label: string;
  anim: AnimRef;
  index: number;
}

/**
 * Computes the layout without rendering: tries scales from the requested (or 16) down to 1 and label
 * font scales 2 then 1, and for each the column count with the smallest long edge; the first
 * combination whose long edge is within `maxLongEdge` wins.
 * @throws IoError `TOO_LARGE` when even scale 1 with a 1x font does not fit.
 */
export function contactSheetPlan(
  view: DocumentView,
  options: ContactSheetOptions = {},
): ContactSheetPlan {
  const maxLongEdge = options.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE;
  if (!Number.isInteger(maxLongEdge) || maxLongEdge < 1) {
    throw new IoError(
      'BAD_INPUT',
      `maxLongEdge must be an integer >= 1, got ${String(maxLongEdge)}`,
    );
  }
  if (options.scale !== undefined) checkScale(options.scale);
  const labels = options.labels ?? true;
  const anims = sheetAnimations(view, options.animations);
  const entries: Entry[] = anims.flatMap(({ ref, anim }) =>
    anim.durations.map((_, index) => ({
      label: `${anim.label} #${String(index)}`,
      anim: ref,
      index,
    })),
  );
  if (entries.length === 0) throw new IoError('BAD_INPUT', 'nothing to show: no animations');
  const { w: cw, h: ch } = view.doc.meta.canvas;
  const widest = Math.max(...entries.map((e) => textWidth(e.label)));

  for (let scale = options.scale ?? MAX_SCALE; scale >= 1; scale--) {
    for (const fontScale of labels ? [2, 1] : [1]) {
      const tileW = Math.max(cw * scale, labels ? widest * fontScale : 0) + 2 * PAD;
      const labelH = labels ? FONT_H * fontScale + PAD : 0;
      const tileH = ch * scale + labelH + 2 * PAD;
      let best: { columns: number; rows: number; width: number; height: number } | undefined;
      for (let columns = 1; columns <= entries.length; columns++) {
        const rows = Math.ceil(entries.length / columns);
        const width = columns * tileW + (columns - 1) * GAP;
        const height = rows * tileH + (rows - 1) * GAP;
        if (!best || Math.max(width, height) < Math.max(best.width, best.height)) {
          best = { columns, rows, width, height };
        }
      }
      if (best && Math.max(best.width, best.height) <= maxLongEdge) {
        return {
          scale,
          fontScale,
          columns: best.columns,
          rows: best.rows,
          tileW,
          tileH,
          width: best.width,
          height: best.height,
          tiles: entries.map((e, i) => ({
            ...e,
            x: (i % best.columns) * (tileW + GAP),
            y: Math.floor(i / best.columns) * (tileH + GAP),
          })),
        };
      }
    }
  }
  throw new IoError(
    'TOO_LARGE',
    `${String(entries.length)} frames of ${String(cw)}x${String(ch)} do not fit in ${String(maxLongEdge)} px`,
  );
}

function drawText(
  dst: Dense,
  text: string,
  x: number,
  y: number,
  k: number,
  color: readonly [number, number, number, number],
): void {
  let cx = x;
  for (const ch of text) {
    glyph(ch).forEach((row, gy) => {
      for (let gx = 0; gx < FONT_W; gx++) {
        if (row[gx] === '#') fillRect(dst, cx + gx * k, y + gy * k, k, k, color);
      }
    });
    cx += (FONT_W + 1) * k;
  }
}

function drawChecker(dst: Dense, x: number, y: number, w: number, h: number): void {
  for (let yy = 0; yy < h; yy += CHECK_SIZE) {
    for (let xx = 0; xx < w; xx += CHECK_SIZE) {
      const c = ((xx + yy) / CHECK_SIZE) % 2 === 0 ? CHECK_A : CHECK_B;
      fillRect(dst, x + xx, y + yy, Math.min(CHECK_SIZE, w - xx), Math.min(CHECK_SIZE, h - yy), c);
    }
  }
}

/**
 * Renders a labelled contact sheet of frames (see {@link ContactSheetOptions}). Frames sit on a
 * grey checkerboard, scaled by an integer, with the label under each (3x5 font, upper case) and a
 * 2 px gutter. The result is at most `maxLongEdge` on its long side.
 *
 * Labels are `group/direction #n` with `n` the 0-based frame index within its animation, the same
 * numbering as the `FrameRef` index of the operation API.
 *
 * @throws IoError `BAD_INPUT`, `DUPLICATE_ANIMATION`, `TOO_LARGE`.
 */
export function contactSheet(view: DocumentView, options: ContactSheetOptions = {}): TiledImage {
  const plan = contactSheetPlan(view, options);
  const labels = options.labels ?? true;
  const exportOnly = options.exportOnly ?? true;
  const { w: cw, h: ch } = view.doc.meta.canvas;
  const out = blank(plan.width, plan.height);
  fillRect(out, 0, 0, plan.width, plan.height, BG);
  const k = plan.scale;
  const origin = view.doc.meta.origin;

  for (const tile of plan.tiles) {
    const fx = tile.x + Math.floor((plan.tileW - cw * k) / 2);
    const fy = tile.y + PAD;
    fillRect(out, tile.x, tile.y, plan.tileW, plan.tileH, [44, 44, 50, 255]);
    drawChecker(out, fx, fy, cw * k, ch * k);
    blitScaled(
      out,
      renderDense(view, tile.anim, tile.index, { skin: options.skin, exportOnly }),
      fx,
      fy,
      k,
      true,
    );
    if (options.overlay?.origin)
      fillRect(out, fx + origin.x * k, fy + origin.y * k, k, k, ORIGIN_COLOR);
    if (options.overlay?.markers) {
      const anim = view.doc.animations.find((a) => 'id' in tile.anim && a.id === tile.anim.id);
      const src =
        anim && 'mirrorOf' in anim ? view.doc.animations.find((a) => a.id === anim.mirrorOf) : anim;
      const frame = src && 'frames' in src ? src.frames[tile.index] : undefined;
      for (const p of Object.values(frame?.markers ?? {})) {
        fillRect(out, fx + p.x * k, fy + p.y * k, k, k, MARKER_COLOR);
      }
    }
    if (labels) {
      const lw = textWidth(tile.label) * plan.fontScale;
      drawText(
        out,
        tile.label,
        tile.x + Math.floor((plan.tileW - lw) / 2),
        tile.y + PAD + ch * k + PAD,
        plan.fontScale,
        LABEL_COLOR,
      );
    }
  }
  return TiledImage.fromRGBA(out);
}
