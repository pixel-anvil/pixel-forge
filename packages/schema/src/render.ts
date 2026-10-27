/**
 * The `.pxf` container files other than `document.json` (spec 7): `manifest.json` and the render
 * cache index `render/index.json`, which is all the Godot importer reads (FR-GD-02, FR-GD-05).
 * @packageDocumentation
 */
import { z } from 'zod';
import { BASE_SKIN_KEY, PXF_FORMAT, SCHEMA_VERSION } from './constants.js';
import { LoopMode } from './animation.js';
import { DirectionFallback } from './document.js';
import { FrameId } from './ids.js';
import { Delta, DurationMs, Hash, Name, Point, RENDER_IMAGE_PATH_REGEX } from './primitives.js';
import { record } from './record.js';

/** `manifest.json`. Timestamps are UTC ISO 8601; a no-op save keeps `modified` (NFR-03). */
export const Manifest = z.strictObject({
  format: z.literal(PXF_FORMAT),
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** Writer, e.g. `pixel-forge 0.1.0`. */
  app: z.string().min(1).max(128),
  created: z.iso.datetime(),
  modified: z.iso.datetime(),
});
/** `manifest.json`. */
export type Manifest = z.infer<typeof Manifest>;

/**
 * Path of a flattened frame PNG relative to `render/<skin>/`: `<group>/<direction>/<n>.png`.
 * Frames with equal hashes may share one file.
 */
export const RenderImagePath = z
  .string()
  .regex(RENDER_IMAGE_PATH_REGEX, 'expected <group>/<direction>/<n>.png with valid names');

/** One rendered frame. Markers are canvas positions; the consumer subtracts `origin`. */
export const RenderFrame = z.strictObject({
  id: FrameId,
  /** Render-input hash; the PNGs are rewritten only when it changes. */
  hash: Hash,
  durationMs: DurationMs,
  image: RenderImagePath,
  markers: record(Name, Point),
  events: z.array(Name),
  rootMotion: Delta,
});
/** One rendered frame. */
export type RenderFrame = z.infer<typeof RenderFrame>;

/** A rendered animation with its own frames and PNGs. */
export const RenderAuthoredAnimation = z.strictObject({
  loop: LoopMode,
  frames: z.array(RenderFrame).min(1),
});
/** A rendered animation with its own frames and PNGs. */
export type RenderAuthoredAnimation = z.infer<typeof RenderAuthoredAnimation>;

/**
 * A derived mirror: no frames and no PNGs. The consumer plays the frames of the same group's
 * `mirrorOf` direction with `flip_h`, mirroring markers as `x' = 2·origin.x − x` (FR-RIG-16).
 */
export const RenderMirrorAnimation = z.strictObject({
  loop: LoopMode,
  /** Direction key of the source animation in the same group. */
  mirrorOf: Name,
});
/** A derived mirror in the render cache. */
export type RenderMirrorAnimation = z.infer<typeof RenderMirrorAnimation>;

/** A rendered animation entry. */
export const RenderAnimation = z.union([RenderAuthoredAnimation, RenderMirrorAnimation]);
/** A rendered animation entry. */
export type RenderAnimation = z.infer<typeof RenderAnimation>;

/**
 * `render/index.json` (spec 7, FR-GD-02). `animations[group][direction]`; an undirected animation
 * uses the direction key `default`. PNGs live at `render/<skin>/<image>` for each key in `skins`,
 * which include `base` (the unskinned render). Only `export` layers are rendered.
 */
export const RenderIndex = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  origin: Point,
  pixelsPerUnit: z.number().gt(0),
  directionFallback: DirectionFallback,
  /** Rendered skin keys: `base` exactly once, plus skin names; all unique. */
  skins: z
    .array(Name)
    .refine((skins) => skins.includes(BASE_SKIN_KEY), `skins must include "${BASE_SKIN_KEY}"`)
    .refine((skins) => new Set(skins).size === skins.length, 'skins must be unique'),
  animations: record(Name, record(Name, RenderAnimation)),
});
/** `render/index.json`. */
export type RenderIndex = z.infer<typeof RenderIndex>;
