/**
 * Animated GIF export (FR-DOC-06, card E6.2): one animation of a document, rendered like the game would
 * see it, encoded by {@link encodeGif}. Pure: view in, bytes out.
 * @packageDocumentation
 */
import type { DocumentView, RigRenderer, SkinRef } from '@pixel-forge/core';
import type { AnimRef } from '@pixel-forge/schema';
import { blank, blitScaled, checkScale } from './dense.js';
import { IoError } from './errors.js';
import { encodeGif } from './gif-encode.js';
import type { GifEncodeFrame } from './gif-encode.js';
import { renderDense, sheetAnimations } from './sheet-export.js';

/** Options of {@link exportGif}. */
export interface ExportGifOptions {
  /** The animation to export. Default: the only animation of the document (an error if there are several). */
  animation?: AnimRef;
  /** Integer scale 1..16. Default 1. */
  scale?: number;
  /** Skin for the render; default the base (unskinned) look. */
  skin?: SkinRef | 'base';
  /** Render only layers with `export: true`. Default true. */
  exportOnly?: boolean;
  /** The part renderer; required when a frame draws a part layer. */
  rig?: RigRenderer;
}

/** Result of {@link exportGif}. */
export interface ExportedGif {
  /** The GIF file. */
  gif: Uint8Array;
  /** The animation's tag name (`group` or `group/direction`). */
  animation: string;
  /** Frames written (a pingpong animation writes its way back too). */
  frames: number;
  /** Image size in px (scaled). */
  size: { w: number; h: number };
  /** Colours used, not counting transparency. */
  colors: number;
}

/**
 * Renders one animation to an animated GIF.
 *
 * - Frames and durations are the animation's (a mirror animation takes its source's), each frame drawn
 *   like a sheet export frame (export layers, rig, overrides, skin, scale).
 * - Loop: `loop` plays forever, `once` plays once. `pingpong` plays forward then back without repeating
 *   the end frames (`0 1 2 3 2 1`) and loops forever; with 1 or 2 frames that is the forward run.
 * - A GIF has one global palette of at most 256 colours including transparency, and no partial alpha:
 *   see {@link encodeGif} for the refusals (`PALETTE_TOO_LARGE`, `BAD_INPUT`).
 *
 * @throws IoError `BAD_INPUT` (scale, several animations and none chosen, partial alpha), `TOO_LARGE`,
 *   `PALETTE_TOO_LARGE`; `CoreError('BAD_ARGUMENT')` for an unknown animation
 */
export function exportGif(view: DocumentView, options: ExportGifOptions = {}): ExportedGif {
  const scale = options.scale ?? 1;
  checkScale(scale);
  const exportOnly = options.exportOnly ?? true;
  if (options.animation === undefined && view.doc.animations.length > 1) {
    throw new IoError('BAD_INPUT', 'a GIF holds one animation: name it (the document has several)');
  }
  const picked = sheetAnimations(view, options.animation ? [options.animation] : undefined)[0];
  if (picked === undefined) throw new IoError('BAD_INPUT', 'nothing to export: no animations');
  const { ref, anim } = picked;
  const { w: cw, h: ch } = view.doc.meta.canvas;

  const rendered: GifEncodeFrame[] = anim.durations.map((durationMs, n) => {
    const img = renderDense(view, ref, n, { skin: options.skin, exportOnly, rig: options.rig });
    const out = blank(cw * scale, ch * scale);
    blitScaled(out, img, 0, 0, scale, false);
    return { width: out.width, height: out.height, data: out.data, durationMs };
  });
  const order =
    anim.loop === 'pingpong' && rendered.length > 2
      ? [
          ...rendered.keys(),
          ...Array.from({ length: rendered.length - 2 }, (_, i) => rendered.length - 2 - i),
        ]
      : [...rendered.keys()];
  const frames = order.map((i) => {
    const f = rendered[i];
    if (f === undefined) throw new IoError('BAD_INPUT', 'frame index out of range');
    return f;
  });
  const encoded = encodeGif(frames, { loop: anim.loop === 'once' ? 'once' : 'loop' });
  return {
    gif: encoded.bytes,
    animation: anim.label,
    frames: frames.length,
    size: { w: cw * scale, h: ch * scale },
    colors: encoded.colors,
  };
}
