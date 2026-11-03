/**
 * GIF import (FR-DOC-05, card E6.1): a GIF becomes one animation with one frame per GIF frame, on one
 * pixel layer. Pure byte-in, document-edits-out, like the spritesheet import.
 * @packageDocumentation
 */
import type { Transaction } from '@pixel-forge/core';
import { TiledImage, hashRGBA } from '@pixel-forge/raster';
import type { DocumentStore } from '@pixel-forge/core';
import { Name } from '@pixel-forge/schema';
import type { AnimationId, Cel, FrameId, LayerId, LoopMode, PixelLayer } from '@pixel-forge/schema';
import { IoError } from './errors.js';
import { decodeGif } from './gif.js';
import type { DecodedGif, GifOptions } from './gif.js';
import { cellOffset, createEmptyDocumentStore, DEFAULT_FRAME_MS } from './sheet-import.js';
import type { CreateFromSheetOptions } from './sheet-import.js';

/** Input of {@link importGifTx}. */
export interface GifImportInput {
  /** The GIF file contents. */
  gif: Uint8Array;
  /** Animation group, a schema `Name`. Default `gif`. */
  group?: string;
  /** Direction, a schema `DirectionName`; missing means undirected. */
  direction?: string;
  /** Layer name (reused when a top-level pixel layer of that name exists). Default `body`. */
  layerName?: string;
  /** Loop mode. Default: from the file (see {@link gifLoopMode}). */
  loop?: LoopMode;
  /** Duration in ms of a frame whose delay is 0. Default 100. */
  zeroDelayMs?: number;
  /** Decoder limits. */
  limits?: GifOptions['limits'];
}

/** What {@link importGifTx} created. */
export interface GifImportResult {
  animation: AnimationId;
  layer: LayerId;
  /** Frames created. */
  frames: number;
  /** Cels that own pixels (empty frames create none; a frame equal to an earlier one links to it). */
  imageCels: number;
  /** GIF canvas size. */
  size: { w: number; h: number };
  /** Non-fatal findings, for the caller to show. */
  warnings: string[];
}

/**
 * The loop mode of a GIF: no `NETSCAPE2.0` extension plays once (`once`); anything else loops. The schema
 * has no repeat count, so a finite count above 0 also becomes `loop` (the import says so in a warning).
 */
export function gifLoopMode(loopCount: number | undefined): LoopMode {
  return loopCount === undefined ? 'once' : 'loop';
}

/**
 * Imports a GIF inside an open transaction: one frame per GIF frame with its duration, in a new
 * animation. Each frame is the composed full canvas (disposal and sub-rectangles are resolved by
 * {@link decodeGif}), placed like a spritesheet cell of the GIF's size: its bottom-centre pixel lands on
 * the document origin. A fully transparent frame creates a frame without a cel; a frame identical to an
 * earlier one becomes a link to that cel.
 *
 * Everything is validated and decoded before the document is touched; on `IoError` the transaction is
 * unchanged.
 * @throws IoError `BAD_GIF`, `TOO_LARGE` (from the decoder), `BAD_INPUT` (names, zero delay),
 *   `DUPLICATE_ANIMATION`
 */
export function importGifTx(tx: Transaction, input: GifImportInput): GifImportResult {
  return applyGif(tx, decodeGifInput(input), input);
}

function decodeGifInput(input: GifImportInput): DecodedGif {
  return decodeGif(input.gif, {
    ...(input.limits === undefined ? {} : { limits: input.limits }),
    ...(input.zeroDelayMs === undefined ? {} : { zeroDelayMs: input.zeroDelayMs }),
  });
}

function applyGif(tx: Transaction, gif: DecodedGif, input: GifImportInput): GifImportResult {
  const group = input.group ?? 'gif';
  const layerName = input.layerName ?? 'body';
  if (!Name.safeParse(group).success) {
    throw new IoError('BAD_INPUT', `group "${group}" is not a valid name`);
  }
  if (!Name.safeParse(layerName).success) {
    throw new IoError('BAD_INPUT', `layer name "${layerName}" is not a valid name`);
  }
  if (tx.doc.animations.some((a) => a.group === group && a.direction === input.direction)) {
    throw new IoError(
      'DUPLICATE_ANIMATION',
      `animation ${group}${input.direction ? '/' + input.direction : ''} already exists`,
    );
  }
  const warnings: string[] = [];
  if (gif.loopCount !== undefined && gif.loopCount > 0) {
    warnings.push(
      `the GIF repeats ${String(gif.loopCount)} times; imported as loop mode "loop" (no repeat count in the document)`,
    );
  }
  if (gif.zeroDelayFrames > 0) {
    warnings.push(
      `${String(gif.zeroDelayFrames)} frame(s) had delay 0; they got ${String(input.zeroDelayMs ?? DEFAULT_FRAME_MS)} ms`,
    );
  }
  const { canvas } = tx.doc.meta;
  if (canvas.w !== gif.width || canvas.h !== gif.height) {
    warnings.push(
      `the GIF is ${String(gif.width)}x${String(gif.height)} and the canvas is ${String(canvas.w)}x${String(canvas.h)}; frames are placed with their bottom-centre on the origin and may be clipped`,
    );
  }

  const offset = cellOffset([gif.width, gif.height], tx.doc.meta.origin);
  const existing = tx.doc.layers.find((l) => l.kind === 'pixel' && l.name === layerName);
  const layerId = existing?.id ?? tx.newId('layer');
  const animationId = tx.newId('animation');
  const cels = new Map<FrameId, Cel>();
  const seen = new Map<string, FrameId>(); // image hash -> frame that owns the cel
  const frameIds: { id: FrameId; durationMs: number }[] = [];
  let imageCels = 0;
  for (const f of gif.frames) {
    const id = tx.newId('frame');
    frameIds.push({ id, durationMs: f.durationMs });
    if (!f.image.data.some((v, i) => i % 4 === 3 && v !== 0)) continue; // fully transparent
    const key = hashRGBA(f.image);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      cels.set(id, { linkTo: earlier });
      continue;
    }
    seen.set(key, id);
    imageCels += 1;
    cels.set(id, {
      imageId: tx.createImage(TiledImage.fromRGBA(f.image)),
      offset: { ...offset },
      opacity: 255,
    });
  }

  tx.update((d) => {
    let layer = d.layers.find((l) => l.kind === 'pixel' && l.name === layerName) as
      PixelLayer | undefined;
    if (!layer) {
      d.layers.push({
        kind: 'pixel',
        id: layerId,
        name: layerName,
        visible: true,
        opacity: 255,
        export: true,
        cels: {},
      });
      layer = d.layers[d.layers.length - 1] as PixelLayer;
    }
    for (const [fid, cel] of cels) layer.cels[fid] = cel;
    d.animations.push({
      id: animationId,
      group,
      ...(input.direction !== undefined ? { direction: input.direction } : {}),
      loop: input.loop ?? gifLoopMode(gif.loopCount),
      frames: frameIds.map((f) => ({
        id: f.id,
        durationMs: f.durationMs,
        markers: {},
        events: [],
        rootMotion: { dx: 0, dy: 0 },
        boneKeys: {},
        partKeys: {},
      })),
      overrides: [],
    });
  });

  return {
    animation: animationId,
    layer: layerId,
    frames: frameIds.length,
    imageCels,
    size: { w: gif.width, h: gif.height },
    warnings,
  };
}

/**
 * Builds a fresh valid RGBA document whose canvas is the GIF's size and imports the GIF into it (one
 * undoable transaction "Import GIF"). Returns the store and the import summary.
 * @throws IoError as {@link importGifTx}
 */
export function createDocumentFromGif(
  input: GifImportInput,
  options: CreateFromSheetOptions = {},
): { store: DocumentStore; result: GifImportResult } {
  const gif = decodeGifInput(input);
  const store = createEmptyDocumentStore([gif.width, gif.height], options);
  const tx = store.begin('Import GIF');
  try {
    const result = applyGif(tx, gif, input);
    tx.commit();
    return { store, result };
  } catch (e) {
    tx.cancel();
    throw e;
  }
}
