/**
 * Part layer names (FR-DOC-04): `part:<bone>[.<part>][@<variant>][#<view>]`.
 *
 * Decision: document layer names follow the schema `Name` grammar (`^[a-z0-9_-]{1,48}$`, I7), which
 * forbids `:`, `@` and `#`. So the `part:` syntax exists **only in source layer names** (an Aseprite
 * layer). The importer (T4.5) parses the raw name with {@link parsePartLayerName}, and the document
 * layer gets the plain name {@link partLayerName} (`<bone>`, or `<bone>_<part>` for a further part on
 * the same bone; the part layer is addressed by its name, `PartName`); the variant and view become `Variant.name` / `Variant.viewId`.
 * The raw name is not stored in the document: re-import matches by parsed (bone, part, variant, view).
 * @packageDocumentation
 */
import { NAME_REGEX } from '@pixel-forge/schema';

/** A parsed `part:` layer name. */
export interface PartLayerName {
  readonly bone: string;
  /** Optional part name: several parts may share one bone (arm plus sleeve). */
  readonly part?: string;
  readonly variant?: string;
  readonly view?: string;
}

/** Name of a variant that has no `@<variant>` suffix. */
export const DEFAULT_VARIANT_NAME = 'default';

/** Prefix of a part layer in a source file. */
export const PART_PREFIX = 'part:';

const SHAPE = /^part:([^.@#]*)(?:\.([^.@#]*))?(?:@([^@#]*))?(?:#([^@#]*))?$/;

/**
 * Parses `part:<bone>[.<part>][@<variant>][#<view>]` (order fixed; each segment a schema `Name`;
 * whitespace is not trimmed and case is significant). Returns `null` for anything else: a plain
 * layer name, an empty or invalid segment, a repeated or misordered suffix.
 */
export function parsePartLayerName(name: string): PartLayerName | null {
  const m = SHAPE.exec(name);
  if (m === null) return null;
  const [, bone, part, variant, view] = m;
  if (bone === undefined || !NAME_REGEX.test(bone)) return null;
  if (part !== undefined && !NAME_REGEX.test(part)) return null;
  if (variant !== undefined && !NAME_REGEX.test(variant)) return null;
  if (view !== undefined && !NAME_REGEX.test(view)) return null;
  return {
    bone,
    ...(part === undefined ? {} : { part }),
    ...(variant === undefined ? {} : { variant }),
    ...(view === undefined ? {} : { view }),
  };
}

/**
 * The document layer name of the part layer for `parsed`: `<bone>` without a part, else
 * `<bone>_<part>`. May exceed the 48-character name limit or collide; the caller checks.
 */
export function partLayerName(parsed: PartLayerName): string {
  return parsed.part === undefined ? parsed.bone : `${parsed.bone}_${parsed.part}`;
}
