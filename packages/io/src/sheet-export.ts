/**
 * Spritesheet export (FR-DOC-06): frames rendered with core `renderFrame`, laid out in a grid and
 * described by JSON in Aseprite's "hash" format. Pure: view in, bytes and an object out.
 * @packageDocumentation
 */
import { renderFrame, resolveAnimation } from '@pixel-forge/core';
import type { DocumentView, SkinRef } from '@pixel-forge/core';
import { encodePng } from '@pixel-forge/png';
import type { AnimRef } from '@pixel-forge/schema';
import { blank, blitScaled, checkScale } from './dense.js';
import type { Dense } from './dense.js';
import { IoError } from './errors.js';

/** Options of {@link exportSpritesheet}. */
export interface ExportSheetOptions {
  /** Animations to export, in sheet order. Default: every animation of the document, in document order. */
  animations?: readonly AnimRef[];
  /**
   * `rows`: one row per animation, frames left to right (the sheet is as wide as the longest
   * animation; unused cells stay transparent). `packed`: all frames in one reading-order sequence in a
   * near-square grid, `ceil(sqrt(n))` columns. Frames are never trimmed, rotated or de-duplicated
   * (`trimmed` and `rotated` are always `false`).
   */
  layout: 'rows' | 'packed';
  /** Integer scale 1..16. Default 1. */
  scale?: number;
  /** Skin for the render; default the base (unskinned) look. */
  skin?: SkinRef | 'base';
  /** Render only layers with `export: true`. Default true. */
  exportOnly?: boolean;
  /** The `meta.image` file name written to the JSON. Default `spritesheet.png`. */
  imageName?: string;
}

/** A rectangle in Aseprite JSON. */
export interface AseRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One entry of `frames` in Aseprite's hash format. */
export interface AseFrame {
  frame: AseRect;
  rotated: false;
  trimmed: false;
  spriteSourceSize: AseRect;
  sourceSize: { w: number; h: number };
  duration: number;
}

/** One entry of `meta.frameTags`. `from` and `to` are frame indices in the sheet (inclusive). */
export interface AseFrameTag {
  name: string;
  from: number;
  to: number;
  direction: 'forward' | 'pingpong';
}

/** The JSON of {@link exportSpritesheet}: Aseprite's `--format json-hash` shape. */
export interface AseSheetJson {
  frames: Record<string, AseFrame>;
  meta: {
    app: string;
    version: string;
    image: string;
    format: 'RGBA8888';
    size: { w: number; h: number };
    scale: string;
    frameTags: AseFrameTag[];
  };
}

/** Result of {@link exportSpritesheet}. */
export interface ExportedSheet {
  /** The sheet as a PNG. */
  png: Uint8Array;
  /** The description, Aseprite hash format. */
  json: AseSheetJson;
}

/** `meta.app` written by the exporter, as Aseprite writes its own site. */
export const SHEET_APP = 'pixel-forge';
/** `meta.version` written by the exporter. */
export const SHEET_VERSION = '1.0';

/**
 * The tag name of an animation: `group` for an undirected one, `group/direction` otherwise.
 * Frame keys are `<tag name> <n>` where `n` is the 0-based index inside the animation, e.g.
 * `run/side 3`. (Aseprite's own `--filename-format '{tag} {tagframe}'` produces the same keys when the
 * tags are named like that.)
 */
export function animationLabel(anim: { group: string; direction?: string | undefined }): string {
  return anim.direction === undefined ? anim.group : `${anim.group}/${anim.direction}`;
}

/** @internal */
export interface SheetAnim {
  label: string;
  loop: 'loop' | 'once' | 'pingpong';
  /** Durations in ms, one per frame. */
  durations: number[];
}

/**
 * Resolves animations to labels, loop mode and frame durations; mirror animations take them from
 * their source. An unknown reference throws `CoreError('BAD_ARGUMENT')`.
 * @internal
 */
export function sheetAnimations(
  view: DocumentView,
  refs: readonly AnimRef[] | undefined,
): { ref: AnimRef; anim: SheetAnim }[] {
  const doc = view.doc;
  const indices = refs
    ? refs.map((r) => resolveAnimation(doc, r))
    : doc.animations.map((_, i) => i);
  const seen = new Set<number>();
  return indices.map((i) => {
    const a = doc.animations[i];
    if (!a) throw new IoError('BAD_INPUT', 'unknown animation');
    if (seen.has(i)) {
      throw new IoError('DUPLICATE_ANIMATION', `animation ${animationLabel(a)} listed twice`);
    }
    seen.add(i);
    const src = 'mirrorOf' in a ? doc.animations.find((s) => s.id === a.mirrorOf) : a;
    if (!src || !('frames' in src)) {
      throw new IoError('BAD_INPUT', `animation ${animationLabel(a)} has no source frames`);
    }
    return {
      ref: { id: a.id },
      anim: {
        label: animationLabel(a),
        loop: src.loop,
        durations: src.frames.map((f) => f.durationMs),
      },
    };
  });
}

/** Renders one frame to a dense buffer. @internal */
export function renderDense(
  view: DocumentView,
  ref: AnimRef,
  index: number,
  opts: { skin?: SkinRef | 'base' | undefined; exportOnly: boolean },
): Dense {
  const img = renderFrame(view, ref, index, {
    ...(opts.skin !== undefined ? { skin: opts.skin } : {}),
    exportOnly: opts.exportOnly,
  });
  const { width, height, data } = img.toRGBA();
  return { width, height, data };
}

/**
 * Renders animations into one spritesheet PNG plus Aseprite hash-format JSON.
 *
 * - Frame key: `<tag> <n>` with `tag = group` or `group/direction`, `n` = 0-based index in the animation
 *   ({@link animationLabel}).
 * - `meta.frameTags`: one tag per animation named like the key prefix, `from`/`to` = sheet frame
 *   indices (sheet order, so they are global, as in Aseprite); `direction` is `pingpong` for a
 *   `pingpong` animation and `forward` otherwise (Aseprite has no "once": `once` exports `forward`).
 * - `meta.scale` is always `"1"`, exactly what Aseprite writes for `--scale N` (checked against the
 *   oracle); frame rects, `sourceSize` and `size` are already scaled. `meta.app` is {@link SHEET_APP}, `version` {@link SHEET_VERSION}.
 * - `duration` is the frame duration in ms.
 *
 * @throws IoError `BAD_INPUT` (scale, unknown animation), `DUPLICATE_ANIMATION`, `TOO_LARGE`.
 */
export function exportSpritesheet(view: DocumentView, options: ExportSheetOptions): ExportedSheet {
  const scale = options.scale ?? 1;
  checkScale(scale);
  const layout: string = options.layout;
  if (layout !== 'rows' && layout !== 'packed') {
    throw new IoError('BAD_INPUT', `unknown layout ${layout}`);
  }
  const exportOnly = options.exportOnly ?? true;
  const anims = sheetAnimations(view, options.animations);
  if (anims.length === 0) throw new IoError('BAD_INPUT', 'nothing to export: no animations');
  const { w: cw, h: ch } = view.doc.meta.canvas;
  const fw = cw * scale;
  const fh = ch * scale;

  // Position of every frame in the sheet, in sheet order.
  const total = anims.reduce((n, a) => n + a.anim.durations.length, 0);
  const columns =
    options.layout === 'rows'
      ? Math.max(...anims.map((a) => a.anim.durations.length))
      : Math.ceil(Math.sqrt(total));
  const rowsCount = options.layout === 'rows' ? anims.length : Math.ceil(total / columns);
  const sheet = blank(columns * fw, rowsCount * fh);

  const frames: Record<string, AseFrame> = {};
  const frameTags: AseFrameTag[] = [];
  let seq = 0;
  anims.forEach(({ ref, anim }, ai) => {
    frameTags.push({
      name: anim.label,
      from: seq,
      to: seq + anim.durations.length - 1,
      direction: anim.loop === 'pingpong' ? 'pingpong' : 'forward',
    });
    anim.durations.forEach((duration, n) => {
      const col = options.layout === 'rows' ? n : seq % columns;
      const row = options.layout === 'rows' ? ai : Math.floor(seq / columns);
      const rect = { x: col * fw, y: row * fh, w: fw, h: fh };
      const img = renderDense(view, ref, n, { skin: options.skin, exportOnly });
      blitScaled(sheet, img, rect.x, rect.y, scale, false);
      frames[`${anim.label} ${String(n)}`] = {
        frame: rect,
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: fw, h: fh },
        sourceSize: { w: fw, h: fh },
        duration,
      };
      seq += 1;
    });
  });

  return {
    png: encodePng({ width: sheet.width, height: sheet.height, data: sheet.data, kind: 'rgba' }),
    json: {
      frames,
      meta: {
        app: SHEET_APP,
        version: SHEET_VERSION,
        image: options.imageName ?? 'spritesheet.png',
        format: 'RGBA8888',
        size: { w: sheet.width, h: sheet.height },
        scale: '1',
        frameTags,
      },
    },
  };
}
