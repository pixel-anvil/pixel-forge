/**
 * Constants shared by every package. Values here are part of the file contract (spec 3, 7) or are
 * documented defaults (FR-RIG-05/12/14). Changing a contract value needs an ADR and a migration.
 * @packageDocumentation
 */

/** Version of `document.json`, `render/index.json` and `manifest.json` written by this schema (spec 7). */
export const SCHEMA_VERSION = 1;

/** Value of `manifest.json` `format` (spec 7). */
export const PXF_FORMAT = 'pxf';

/** Edge length in pixels of one sparse tile (NFR-01, ADR-007). */
export const TILE_SIZE = 16;

/** Default angle quantum in degrees: evaluated bone angles snap to multiples of it (FR-RIG-12). */
export const ANGLE_QUANTUM_DEFAULT = 1;

/** Default largest residual rotation in degrees before lint warns (FR-RIG-14; spike T0.4 keeps 22.5). */
export const MAX_RESIDUAL_DEG_DEFAULT = 22.5;

/** Default hysteresis in degrees for variant auto-select (FR-RIG-14). */
export const HYSTERESIS_DEG_DEFAULT = 5;

/** Default half-range in degrees of the joint coverage sweep (FR-RIG-05). */
export const JOINT_SWEEP_DEG_DEFAULT = 30;

/** Default step in degrees of the joint coverage sweep (FR-RIG-05). */
export const JOINT_STEP_DEG_DEFAULT = 5;

/** Longest allowed machine name (I7). */
export const NAME_MAX_LENGTH = 48;

/**
 * Character class (the inside of `[...]`) of machine names. The single source of the name grammar:
 * `NAME_REGEX`, `DIRECTION_REGEX`, `SKIN_NAME_REGEX`, `RenderImagePath` and their error messages are
 * all built from it and {@link NAME_MAX_LENGTH} in `primitives.ts`.
 */
export const NAME_CHARS = 'a-z0-9_-';

/**
 * Names that collide with members of `Object.prototype` (or `Function.prototype`). No name or record
 * key may be one: a record keyed by `__proto__` would silently lose the entry when parsed, breaking
 * "parsing is identity". Mixed-case entries cannot match {@link NAME_CHARS} anyway; they are listed
 * so the set stays complete if the grammar ever widens.
 */
export const RESERVED_PROPERTY_NAMES = [
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
] as const;

/**
 * Direction key used in `render/index.json` and render paths for an animation without a `direction`.
 * Reserved: no document direction may use this name.
 */
export const UNDIRECTED_KEY = 'default';

/**
 * Skin key of the unskinned render in `render/index.json` and render paths (`render/base/...`).
 * Reserved: no document skin may use this name.
 */
export const BASE_SKIN_KEY = 'base';

/**
 * Deepest nesting of the layer tree: a root layer is level 1, its children level 2, and so on.
 * Deeper documents fail validation, so recursive code and validation never see unbounded depth.
 */
export const MAX_LAYER_DEPTH = 32;

/**
 * Conventional direction names. Not enforced: any name matching `DIRECTION_REGEX` is a
 * direction. `side` is a single side view; `left`/`right` and the diagonals suit 4- and 8-way
 * characters (FR-GD-03 `auto_direction`).
 */
export const STANDARD_DIRECTIONS = [
  'side',
  'front',
  'back',
  'up',
  'down',
  'left',
  'right',
  'up_left',
  'up_right',
  'down_left',
  'down_right',
] as const;

/** Largest opacity value; opacities are integers `0..255` (255 = opaque). */
export const OPACITY_MAX = 255;

/** Most colours a palette may hold; indexed images store one byte per pixel (spec 7). */
export const MAX_PALETTE_COLORS = 256;

/** Largest canvas edge in pixels (the `.aseprite` and PNG-friendly 16-bit limit). */
export const MAX_CANVAS_SIZE = 65535;

/** Document colour modes (spec 3 meta.colorMode). */
export const COLOR_MODES = ['rgba', 'indexed'] as const;

/** Layer kinds of the layer tree (spec 3). */
export const LAYER_KINDS = ['group', 'pixel', 'part', 'reference'] as const;

/** Animation loop modes (spec 3.1). */
export const LOOP_MODES = ['loop', 'once', 'pingpong'] as const;

/** Bone-key interpolation modes (FR-RIG-12). `ease-in-out` is cubic. */
export const INTERPOLATIONS = ['step', 'linear', 'ease-in-out'] as const;

/** Interpolation used when a bone key has no `interp`. */
export const INTERPOLATION_DEFAULT = 'linear';

/** Per-part rotation algorithms (FR-RIG-21). */
export const ROTATION_ALGORITHMS = ['rotsprite', 'nearest', 'none'] as const;

/** Rotation algorithm used when a part has no `rotation` (FR-RIG-21). */
export const ROTATION_ALGORITHM_DEFAULT = 'rotsprite';

/** Part-key variant value that asks for variant auto-select (FR-RIG-14). */
export const AUTO_VARIANT = 'auto';
