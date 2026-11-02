/**
 * The top-level document, as stored in `document.json` (spec 3, 7).
 * @packageDocumentation
 */
import { z } from 'zod';
import { COLOR_MODES, SCHEMA_VERSION } from './constants.js';
import { Animation } from './animation.js';
import { DocId, IdState, PaletteId } from './ids.js';
import { Layer } from './layers.js';
import { Palette, Skin } from './palette.js';
import { DirectionName, DisplayName, Name, Point, Size } from './primitives.js';
import { Rig } from './rig.js';
import { record } from './record.js';

/** Document colour mode: free RGBA, or palette indices (spec 3, FR-PAL-06). */
export const ColorMode = z.enum(COLOR_MODES);
/** Document colour mode. */
export type ColorMode = z.infer<typeof ColorMode>;

/** Document metadata (spec 3 `meta`). */
export const Meta = z.strictObject({
  id: DocId,
  name: DisplayName,
  schemaVersion: z.literal(SCHEMA_VERSION),
  canvas: Size,
  /** Anchor pixel shared with the engine (e.g. the feet row); mirroring flips about `origin.x`. */
  origin: Point,
  /** Pixels per engine unit (metres in Godot), > 0. */
  pixelsPerUnit: z.number().gt(0),
  colorMode: ColorMode,
  /** Palette lock: the render under every skin may contain only palette colours (I2). */
  paletteLocked: z.boolean(),
  /** Id generator state (I4). */
  ids: IdState,
});
/** Document metadata. */
export type Meta = z.infer<typeof Meta>;

/** Declares a marker name used by frames (FR-ANIM-07). */
export const MarkerDef = z.strictObject({
  name: Name,
  description: z.string().max(256).exactOptional(),
});
/** Declares a marker name used by frames. */
export type MarkerDef = z.infer<typeof MarkerDef>;

/** Declares an event name used by frames (FR-ANIM-07). */
export const EventDef = z.strictObject({
  name: Name,
  description: z.string().max(256).exactOptional(),
});
/** Declares an event name used by frames. */
export type EventDef = z.infer<typeof EventDef>;

/**
 * Directions to try, in order, when a direction is requested, e.g. `{ up: ["up", "side"] }`
 * (ADR-011). Unordered by key.
 */
export const DirectionFallback = record(DirectionName, z.array(DirectionName).min(1));
/** Directions to try, in order, per requested direction. */
export type DirectionFallback = z.infer<typeof DirectionFallback>;

/**
 * A pixel-forge document without pixel data: images are referenced by {@link ImageId} and stored as
 * `images/<id>.png`. Arrays are ordered; records are unordered maps keyed by id or name.
 */
export const Document = z.strictObject({
  meta: Meta,
  /** Palettes in display order. */
  palettes: z.array(Palette),
  /** Palette used for indexed pixels, the palette lock and skin remaps. */
  activePaletteId: PaletteId.exactOptional(),
  /** Skins in display order; the unskinned render is the implicit skin `base`. */
  skins: z.array(Skin),
  /** Layer tree roots, bottom to top (index 0 is drawn first). Layers are shared by all animations. */
  layers: z.array(Layer),
  rig: Rig.exactOptional(),
  /** Animations in display order. */
  animations: z.array(Animation),
  directionFallback: DirectionFallback,
  markerDefs: z.array(MarkerDef),
  eventDefs: z.array(EventDef),
});
/** A pixel-forge document without pixel data. */
export type Document = z.infer<typeof Document>;
