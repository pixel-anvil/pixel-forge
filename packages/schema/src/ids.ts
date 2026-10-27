/**
 * Branded ids and the deterministic id generator (I4).
 *
 * Format: `<prefix>_<body>`, for example `lay_7k2m9q`. The prefix names the kind ({@link ID_PREFIXES}).
 * The generator writes a 6-character body: a 30-bit value in Crockford base32 (lower case, no
 * `i l o u`). The value is a fixed bijective scramble of `(seed, counter)`, so a document's ids are
 * unique while its counter stays below 2^30, look unrelated to frame indices, and are identical on
 * every platform. Parsers accept any body of 1-24 characters `[0-9a-z]`, so hand-written ids stay
 * valid; every id is also a valid `NAME_REGEX` name, safe in paths such as `images/<id>.png`.
 * @packageDocumentation
 */
import { z } from 'zod';

/** Id prefix per kind. Part of the file contract. */
export const ID_PREFIXES = {
  doc: 'doc',
  layer: 'lay',
  frame: 'frm',
  animation: 'anm',
  bone: 'bon',
  part: 'prt',
  variant: 'var',
  view: 'viw',
  image: 'img',
  override: 'ovr',
  palette: 'pal',
  skin: 'skn',
} as const;

/** A kind of id, e.g. `'layer'`. */
export type IdKind = keyof typeof ID_PREFIXES;

const idSchema = (kind: IdKind) => {
  const prefix = ID_PREFIXES[kind];
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_[0-9a-z]{1,24}$`),
      `expected a ${kind} id like "${prefix}_7k2m9q"`,
    );
};

/** Id of a document (`doc_…`). */
export const DocId = idSchema('doc').brand<'DocId'>();
/** Id of a document (`doc_…`). */
export type DocId = z.infer<typeof DocId>;

/** Id of a layer of any kind (`lay_…`). */
export const LayerId = idSchema('layer').brand<'LayerId'>();
/** Id of a layer of any kind (`lay_…`). */
export type LayerId = z.infer<typeof LayerId>;

/** Stable id of a frame (`frm_…`); unique across all animations of a document (spec 3.1). */
export const FrameId = idSchema('frame').brand<'FrameId'>();
/** Stable id of a frame (`frm_…`); unique across all animations of a document (spec 3.1). */
export type FrameId = z.infer<typeof FrameId>;

/** Id of an animation (`anm_…`). */
export const AnimationId = idSchema('animation').brand<'AnimationId'>();
/** Id of an animation (`anm_…`). */
export type AnimationId = z.infer<typeof AnimationId>;

/** Id of a rig bone (`bon_…`). */
export const BoneId = idSchema('bone').brand<'BoneId'>();
/** Id of a rig bone (`bon_…`). */
export type BoneId = z.infer<typeof BoneId>;

/** Id of a rig part (`prt_…`). */
export const PartId = idSchema('part').brand<'PartId'>();
/** Id of a rig part (`prt_…`). */
export type PartId = z.infer<typeof PartId>;

/** Id of a part variant (`var_…`). */
export const VariantId = idSchema('variant').brand<'VariantId'>();
/** Id of a part variant (`var_…`). */
export type VariantId = z.infer<typeof VariantId>;

/** Id of a rig view (`viw_…`). */
export const ViewId = idSchema('view').brand<'ViewId'>();
/** Id of a rig view (`viw_…`). */
export type ViewId = z.infer<typeof ViewId>;

/** Id of a stored image, `images/<id>.png` in the `.pxf` (`img_…`). */
export const ImageId = idSchema('image').brand<'ImageId'>();
/** Id of a stored image, `images/<id>.png` in the `.pxf` (`img_…`). */
export type ImageId = z.infer<typeof ImageId>;

/** Id of an override (`ovr_…`). */
export const OverrideId = idSchema('override').brand<'OverrideId'>();
/** Id of an override (`ovr_…`). */
export type OverrideId = z.infer<typeof OverrideId>;

/** Id of a palette (`pal_…`). */
export const PaletteId = idSchema('palette').brand<'PaletteId'>();
/** Id of a palette (`pal_…`). */
export type PaletteId = z.infer<typeof PaletteId>;

/** Id of a skin (`skn_…`). */
export const SkinId = idSchema('skin').brand<'SkinId'>();
/** Id of a skin (`skn_…`). */
export type SkinId = z.infer<typeof SkinId>;

/** Branded id type per kind, e.g. `IdTypes['layer']` is {@link LayerId}. */
export interface IdTypes {
  doc: DocId;
  layer: LayerId;
  frame: FrameId;
  animation: AnimationId;
  bone: BoneId;
  part: PartId;
  variant: VariantId;
  view: ViewId;
  image: ImageId;
  override: OverrideId;
  palette: PaletteId;
  skin: SkinId;
}

/** Branded id type of kind `K`. */
export type IdOf<K extends IdKind> = IdTypes[K];

/** Any branded id. */
export type AnyId = IdTypes[IdKind];

/** Id schema per kind, for generic reference checks (I1). */
export const ID_SCHEMAS = {
  doc: DocId,
  layer: LayerId,
  frame: FrameId,
  animation: AnimationId,
  bone: BoneId,
  part: PartId,
  variant: VariantId,
  view: ViewId,
  image: ImageId,
  override: OverrideId,
  palette: PaletteId,
  skin: SkinId,
} as const;

/** Exclusive upper bound of id seeds and counters (2^30): one 6-character base32 body. */
export const ID_SPACE = 0x40000000;

/**
 * Persisted generator state, stored in `meta.ids`. Because the counter is document state, undo
 * restores it and redo regenerates the same ids.
 */
export const IdState = z.strictObject({
  /** Document seed, an integer in `[0, 2^30)`. */
  seed: z
    .int()
    .min(0)
    .max(ID_SPACE - 1),
  /** Counter of the next id, an integer in `[0, 2^30]` (2^30 = exhausted). */
  next: z.int().min(0).max(ID_SPACE),
});
/** Persisted generator state, stored in `meta.ids`. */
export type IdState = z.infer<typeof IdState>;

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const MASK = ID_SPACE - 1;

const checkRange = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0 || value >= ID_SPACE) {
    throw new RangeError(`id ${name} must be an integer in [0, 2^30), got ${String(value)}`);
  }
};

/**
 * Scramble `counter` under `seed`: a bijection on `[0, 2^30)` for each seed, built from xor, addition
 * and odd multiplication modulo 2^30 and xor-shifts. Integer-only, so identical on every platform.
 */
const scramble = (seed: number, counter: number): number => {
  let x = (counter + 0x1b873593) & MASK; // offset: (0, 0) must not encode as 000000
  x ^= seed;
  x = Math.imul(x, 0x2c1b3c6d) & MASK;
  x ^= x >>> 15;
  x = (x + seed) & MASK;
  x = Math.imul(x, 0x297a2d39) & MASK;
  x ^= x >>> 13;
  return x;
};

/** Encode a 30-bit value as 6 Crockford base32 characters. */
const encode30 = (value: number): string => {
  let out = '';
  for (let shift = 25; shift >= 0; shift -= 5) {
    out += CROCKFORD.charAt((value >>> shift) & 31);
  }
  return out;
};

/**
 * Make the id of kind `kind` for `counter` under `seed`. Pure and deterministic.
 * @throws RangeError when `seed` or `counter` is not an integer in `[0, 2^30)`.
 * @example makeId('frame', 42, 0) // 'frm_…' (always the same string)
 */
export function makeId<K extends IdKind>(kind: K, seed: number, counter: number): IdOf<K> {
  checkRange('seed', seed);
  checkRange('counter', counter);
  return `${ID_PREFIXES[kind]}_${encode30(scramble(seed, counter))}` as IdOf<K>;
}

/** A stateful id generator over an {@link IdState}. */
export interface IdGenerator {
  /** Return the next id of `kind` and advance the counter. */
  next<K extends IdKind>(kind: K): IdOf<K>;
  /** A copy of the current state, to store in `meta.ids`. */
  state(): IdState;
}

/**
 * Create a generator that continues from `state` (for builders, importers and tests; the document
 * store advances `meta.ids` itself with {@link makeId}). The same state always yields the same ids.
 * @throws RangeError when the state is out of range, or when the counter is exhausted.
 */
export function createIdGenerator(state: IdState): IdGenerator {
  const { seed } = state;
  let next = state.next;
  checkRange('seed', seed);
  if (!Number.isInteger(next) || next < 0 || next > ID_SPACE) {
    throw new RangeError(`id counter must be an integer in [0, 2^30], got ${String(next)}`);
  }
  return {
    next<K extends IdKind>(kind: K): IdOf<K> {
      const id = makeId(kind, seed, next);
      next += 1;
      return id;
    },
    state: () => ({ seed, next }),
  };
}
