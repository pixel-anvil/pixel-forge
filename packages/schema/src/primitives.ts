/**
 * Small value schemas reused by the domain model. Coordinates: origin top-left, y down, integer
 * pixels; angles in degrees, clockwise on screen, 0° pointing along +x.
 * @packageDocumentation
 */
import { z } from 'zod';
import {
  BASE_SKIN_KEY,
  MAX_CANVAS_SIZE,
  MAX_PALETTE_COLORS,
  NAME_CHARS,
  NAME_MAX_LENGTH,
  OPACITY_MAX,
  RESERVED_PROPERTY_NAMES,
  UNDIRECTED_KEY,
} from './constants.js';

/** A safe integer (I5: pivots, offsets and origin are integers). */
export const Int = z.int();

/** An integer pixel position `{x, y}`. */
export const Point = z.strictObject({ x: Int, y: Int });
/** An integer pixel position `{x, y}`. */
export type Point = z.infer<typeof Point>;

/** An integer pixel displacement `{dx, dy}` (root motion, FR-ANIM-08). */
export const Delta = z.strictObject({ dx: Int, dy: Int });
/** An integer pixel displacement `{dx, dy}` (root motion, FR-ANIM-08). */
export type Delta = z.infer<typeof Delta>;

/** A canvas size `{w, h}` in pixels, each `1..65535`. */
export const Size = z.strictObject({
  w: z.int().min(1).max(MAX_CANVAS_SIZE),
  h: z.int().min(1).max(MAX_CANVAS_SIZE),
});
/** A canvas size `{w, h}` in pixels. */
export type Size = z.infer<typeof Size>;

/** A finite angle in degrees, clockwise (I5). Not limited to one turn. */
export const Angle = z.number();

/** An integer opacity `0..255`; 255 is opaque. */
export const Opacity = z.int().min(0).max(OPACITY_MAX);

/** A positive integer duration in milliseconds (FR-ANIM-03). */
export const DurationMs = z.int().min(1);

// The name grammar, built once from NAME_CHARS and NAME_MAX_LENGTH (constants.ts). `nameSource(end,
// reserved)` is a regex source matching one name, rejecting `reserved` names that are followed by
// `end` (a regex fragment: `$` at the end of a pattern, `/` inside a path).
const NAME_BODY = `[${NAME_CHARS}]{1,${String(NAME_MAX_LENGTH)}}`;
const nameSource = (end: string, reserved: readonly string[]): string =>
  `(?!(?:${reserved.join('|')})${end})${NAME_BODY}`;
const nameRegex = (reserved: readonly string[]): RegExp =>
  new RegExp(`^${nameSource('$', reserved)}$`);
const nameRule = `1-${String(NAME_MAX_LENGTH)} characters from [${NAME_CHARS}]`;
const notPrototype = 'not a JavaScript property name such as "__proto__" or "constructor"';

/**
 * Machine names: animation groups, directions, layers, bones, views, variants, skins, markers, events,
 * ramps and tags (I7). Safe in file paths and Godot names, and never a name that collides with
 * `Object.prototype` ({@link RESERVED_PROPERTY_NAMES}), so every name is a safe record key.
 */
export const NAME_REGEX = nameRegex(RESERVED_PROPERTY_NAMES);

/** Direction names: {@link NAME_REGEX} minus the reserved {@link UNDIRECTED_KEY}. */
export const DIRECTION_REGEX = nameRegex([...RESERVED_PROPERTY_NAMES, UNDIRECTED_KEY]);

/** Skin names: {@link NAME_REGEX} minus the reserved {@link BASE_SKIN_KEY}. */
export const SKIN_NAME_REGEX = nameRegex([...RESERVED_PROPERTY_NAMES, BASE_SKIN_KEY]);

/** A machine name matching {@link NAME_REGEX} (I7). */
export const Name = z.string().regex(NAME_REGEX, `expected a name of ${nameRule}, ${notPrototype}`);

/** A direction name: a {@link Name} other than the reserved `default`. */
export const DirectionName = z
  .string()
  .regex(
    DIRECTION_REGEX,
    `expected a direction name of ${nameRule}, not "${UNDIRECTED_KEY}", ${notPrototype}`,
  );

/** A skin name: a {@link Name} other than the reserved `base`. */
export const SkinName = z
  .string()
  .regex(
    SKIN_NAME_REGEX,
    `expected a skin name of ${nameRule}, not "${BASE_SKIN_KEY}", ${notPrototype}`,
  );

/**
 * Regex of a flattened frame path `<group>/<direction>/<n>.png` (see `RenderImagePath`): two
 * {@link Name} segments and a canonical frame number.
 */
export const RENDER_IMAGE_PATH_REGEX = new RegExp(
  `^${nameSource('/', RESERVED_PROPERTY_NAMES)}/${nameSource('/', RESERVED_PROPERTY_NAMES)}/(0|[1-9][0-9]*)\\.png$`,
);

/** A free-text display name (palettes, documents): 1-128 characters. */
export const DisplayName = z.string().min(1).max(128);

/** One 8-bit channel, `0..255`. */
export const Channel8 = z.int().min(0).max(255);

/** A colour `[r, g, b, a]`, 8 bits per channel, straight (not premultiplied) alpha. */
export const RGBA8 = z.tuple([Channel8, Channel8, Channel8, Channel8]);
/** A colour `[r, g, b, a]`, 8 bits per channel, straight (not premultiplied) alpha. */
export type RGBA8 = z.infer<typeof RGBA8>;

/** An index into a palette, `0..255` (I2 checks it against the palette length). */
export const PaletteIndex = z
  .int()
  .min(0)
  .max(MAX_PALETTE_COLORS - 1);

/** Length in hex digits of a SHA-256 digest. */
const SHA256_HEX_LENGTH = 64;

/**
 * A lower-case hex SHA-256 digest of exactly 64 digits (frame hashes, override `baseHash`; spec 3.4
 * clarification 10).
 */
export const Hash = z
  .string()
  .regex(
    new RegExp(`^[0-9a-f]{${String(SHA256_HEX_LENGTH)}}$`),
    `expected a lower-case hex SHA-256 digest of ${String(SHA256_HEX_LENGTH)} digits`,
  );
