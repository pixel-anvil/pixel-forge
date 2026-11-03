/**
 * `OpError`: the one error type of the operation API (spec 6.3), serialised the same way over
 * every transport (MCP, CLI, harness, `__pf`). {@link toOpError} maps the typed errors of the lower
 * packages (`CoreError`, `IoError`, `AseError`, `RigError`, `JointCheckError`, zod) onto it.
 * @packageDocumentation
 */
import { ConvertError } from '@pixel-forge/convert';
import type { ConvertErrorCode } from '@pixel-forge/convert';
import { CoreError } from '@pixel-forge/core';
import type { CoreErrorCode } from '@pixel-forge/core';
import { AseError, IoError } from '@pixel-forge/io';
import type { IoErrorCode } from '@pixel-forge/io';
import { PngError } from '@pixel-forge/png';
import { JointCheckError, RigError } from '@pixel-forge/rig';
import type { RigErrorCode } from '@pixel-forge/rig';
import { z } from 'zod';

/**
 * Machine-readable codes of {@link OpError}. Part of the op API contract: additive only (a later
 * card may add codes, never rename or remove one).
 *
 * - `BAD_INPUT`: the input fails the op's schema (`details.issues`: `{path, message}`), or is not
 *   a JSON object.
 * - `UNKNOWN_OP`: no op of that name (`details.available`: the op names).
 * - `NOT_FOUND`: a reference does not resolve (`details.kind`: `doc`, `animation`, `frame`, `layer`,
 *   `bone`, `part`, `view`, `variant`, `override`...; `details.ref`; `details.available`: what does
 *   exist, capped).
 * - `AMBIGUOUS`: a name matches several entities (`details.candidates`); pass an id instead.
 * - `CONFIRM_REQUIRED`: a `destructive` op called without `confirm: true` (FR-AI-14).
 * - `REFUSED`: valid input that the document state refuses (`details.reason`, e.g. `last-frame`,
 *   `mirror-animation`, `no-rig`, `has-parts`; the core reasons of KNOWN_ISSUES CORE-02).
 * - `INVALID_VALUE`: a value the document model rejects although it passed the op schema
 *   (`CoreError` `BAD_VALUE`, `RigError` `BAD_VALUE`/`BAD_QUANTUM`...); `details.reason` when known.
 * - `NOT_ALLOWED`: a path outside the host's workspace roots (spec 6.5).
 * - `DOC_LOCKED`: another process owns the document (`details.pid`); raised by the server's host (T5.4).
 * - `CONFLICT`: the request clashes with the host state (a document with the same id is open from
 *   another path) or with the history (`PATCH_CONFLICT`).
 * - `BAD_FILE`: a file that cannot be read as what it claims to be (not a `.pxf`, schema failure,
 *   newer schema version, broken `.aseprite`); `details.cause` keeps the original code.
 * - `IO_FAILED`: a file system call failed (missing file, permissions).
 * - `NOT_IMPLEMENTED`: a transport or feature that is not built yet (forwarding to `pf serve` until M2).
 * - `INTERNAL`: a bug: a handler threw an unexpected error, broke the op contract (async mutate
 *   handler, second transaction, output that fails its schema) or produced an invalid document.
 */
export const OP_ERROR_CODES = [
  'BAD_INPUT',
  'UNKNOWN_OP',
  'NOT_FOUND',
  'AMBIGUOUS',
  'CONFIRM_REQUIRED',
  'REFUSED',
  'INVALID_VALUE',
  'NOT_ALLOWED',
  'DOC_LOCKED',
  'CONFLICT',
  'BAD_FILE',
  'IO_FAILED',
  'NOT_IMPLEMENTED',
  'INTERNAL',
] as const;

/** A machine-readable {@link OpError} code (see {@link OP_ERROR_CODES}). */
export type OpErrorCode = (typeof OP_ERROR_CODES)[number];

/** Structured, JSON-safe context of an {@link OpError}. */
export type OpErrorDetails = Readonly<Record<string, unknown>>;

/** The wire form of an {@link OpError}: identical on every transport. */
export interface OpErrorJson {
  readonly code: OpErrorCode;
  readonly message: string;
  readonly details: OpErrorDetails;
}

/**
 * The typed error of every op (spec 6.3: `OpError {code, message, details}`). Throw it from a
 * handler for refusals the lower packages do not raise themselves; anything else a handler throws
 * is mapped by {@link toOpError}. `details` must be plain JSON.
 */
export class OpError extends Error {
  /** Machine-readable code; branch on it. */
  readonly code: OpErrorCode;
  /** Structured context (reason, ref, candidates...); always an object, possibly empty. */
  readonly details: OpErrorDetails;

  constructor(
    code: OpErrorCode,
    message: string,
    details: OpErrorDetails = {},
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OpError';
    this.code = code;
    this.details = details;
  }

  /** The wire form `{code, message, details}`. */
  toJSON(): OpErrorJson {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** Core `details.reason` values that mean "the thing you named does not exist". */
const NOT_FOUND_KINDS: Readonly<Record<string, string>> = {
  'unknown-animation': 'animation',
  'unknown-frame': 'frame',
  'unknown-bone': 'bone',
  'unknown-view': 'view',
  'unknown-part': 'part',
  'unknown-variant': 'variant',
  'unknown-override': 'override',
};

const CORE_CODES: Readonly<Record<CoreErrorCode, OpErrorCode>> = {
  TX_ACTIVE: 'INTERNAL',
  TX_CLOSED: 'INTERNAL',
  TX_BUSY: 'INTERNAL',
  TX_ASYNC: 'INTERNAL',
  BAD_PATH: 'INTERNAL',
  BAD_VALUE: 'INVALID_VALUE',
  BAD_ARGUMENT: 'REFUSED',
  IMAGE_EXISTS: 'INTERNAL',
  IMAGE_MISSING: 'BAD_FILE',
  IMAGE_MUTATED: 'INTERNAL',
  ID_EXHAUSTED: 'REFUSED',
  PATCH_CONFLICT: 'CONFLICT',
  NO_RIG_RENDERER: 'INTERNAL',
};

const IO_CODES: Readonly<Record<IoErrorCode, OpErrorCode>> = {
  BAD_INPUT: 'BAD_INPUT',
  CELL_OUT_OF_RANGE: 'BAD_INPUT',
  SIZE_MISMATCH: 'REFUSED',
  DUPLICATE_ANIMATION: 'REFUSED',
  TOO_LARGE: 'REFUSED',
  BAD_PXF: 'BAD_FILE',
  INVALID_DOCUMENT: 'BAD_FILE',
  UNSUPPORTED_VERSION: 'BAD_FILE',
  MIGRATION_MISSING: 'BAD_FILE',
  MIGRATION_FAILED: 'BAD_FILE',
  RIG_REQUIRED: 'INTERNAL',
  FS_FAILED: 'IO_FAILED',
  SYMLINK: 'NOT_ALLOWED',
  EXISTS: 'CONFLICT',
  BAD_PALETTE_FILE: 'BAD_FILE',
  PALETTE_TOO_LARGE: 'REFUSED',
  UNSUPPORTED_IMAGE: 'REFUSED',
  BAD_GIF: 'BAD_FILE',
};

const CONVERT_CODES: Readonly<Record<ConvertErrorCode, OpErrorCode>> = {
  BAD_IMAGE: 'BAD_INPUT',
  BAD_RECT: 'BAD_INPUT',
  BAD_OPTION: 'BAD_INPUT',
  BAD_PALETTE: 'BAD_INPUT',
  BAD_RECIPE: 'BAD_INPUT',
  NO_GRID: 'REFUSED',
  BAD_AXES: 'BAD_INPUT',
  TOO_MANY_VARIANTS: 'REFUSED',
};

const RIG_CODES: Readonly<Record<RigErrorCode, OpErrorCode>> = {
  UNKNOWN_BONE: 'NOT_FOUND',
  DUPLICATE_BONE: 'BAD_FILE',
  CYCLE: 'REFUSED',
  UNKNOWN_FRAME: 'NOT_FOUND',
  UNKNOWN_VIEW: 'NOT_FOUND',
  BAD_QUANTUM: 'INVALID_VALUE',
  UNKNOWN_VARIANT: 'NOT_FOUND',
  IMAGE_MISSING: 'BAD_FILE',
  BAD_ARGUMENT: 'REFUSED',
  BAD_VALUE: 'INVALID_VALUE',
};

/** The `details.kind` of the RigError codes that mean "the thing you named does not exist". */
const RIG_NOT_FOUND_KINDS: Readonly<Partial<Record<RigErrorCode, string>>> = {
  UNKNOWN_BONE: 'bone',
  UNKNOWN_FRAME: 'frame',
  UNKNOWN_VIEW: 'view',
  UNKNOWN_VARIANT: 'variant',
};

/** Keeps only JSON-safe values (strings, finite numbers, booleans, null, arrays and plain objects). */
function jsonSafe(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (depth > 6) return undefined;
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, depth + 1) ?? null);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const safe = jsonSafe(v, depth + 1);
      if (safe !== undefined) out[k] = safe;
    }
    return out;
  }
  return undefined;
}

const objectDetails = (value: unknown): Record<string, unknown> => {
  const safe = jsonSafe(value);
  return typeof safe === 'object' && safe !== null && !Array.isArray(safe)
    ? (safe as Record<string, unknown>)
    : {};
};

/** One issue of a {@link OpErrorCode} `BAD_INPUT` error: a dotted path and a message. */
export interface InputIssue {
  /** Dotted path into the input (`bones.arm_r.angle`), `''` for the input itself. */
  readonly path: string;
  readonly message: string;
}

/** The `BAD_INPUT` error for a failed zod parse of an op input. */
export function inputError(error: z.ZodError, op?: string): OpError {
  const issues: InputIssue[] = error.issues.map((i) => ({
    path: i.path.map(String).join('.'),
    message: i.message,
  }));
  const first = issues[0];
  const where = first === undefined || first.path === '' ? '' : ` at "${first.path}"`;
  const more = issues.length > 1 ? ` (+${String(issues.length - 1)} more)` : '';
  return new OpError(
    'BAD_INPUT',
    `invalid input${op === undefined ? '' : ` for ${op}`}${where}: ${first?.message ?? 'rejected'}${more}`,
    { issues },
    { cause: error },
  );
}

/**
 * Maps anything a handler (or a lower package) threw to an {@link OpError}:
 *
 * - an `OpError` is returned as is;
 * - `CoreError` `BAD_ARGUMENT` with a `details.reason` of `unknown-*` becomes `NOT_FOUND` (with
 *   `details.kind`), other reasons `REFUSED`; every other core code per its meaning (KNOWN_ISSUES
 *   CORE-02: the core reasons stay strings, the op layer gives them codes);
 * - `PngError` (a PNG that does not decode) is `BAD_FILE`;
 * - `IoError`, `AseError` (`BAD_FILE`), `RigError` (its `reason` kept; `UNKNOWN_BONE`, `UNKNOWN_FRAME`,
 *   `UNKNOWN_VIEW` and `UNKNOWN_VARIANT` are `NOT_FOUND` with `details.kind`, like the core path), `JointCheckError`
 *   (`INVALID_VALUE`) and `ZodError` (`BAD_INPUT`) by code;
 * - anything else is `INTERNAL`.
 *
 * `details.cause` records the original error class and code (`{error: 'CoreError', code}`), and
 * the original `details` are merged in when they are plain JSON.
 */
export function toOpError(error: unknown): OpError {
  if (error instanceof OpError) return error;
  if (error instanceof CoreError) {
    const details = objectDetails(error.details);
    const reason = typeof details.reason === 'string' ? details.reason : undefined;
    const kind = reason === undefined ? undefined : NOT_FOUND_KINDS[reason];
    const code: OpErrorCode = kind !== undefined ? 'NOT_FOUND' : CORE_CODES[error.code];
    return new OpError(
      code,
      error.message,
      {
        ...details,
        ...(kind === undefined ? {} : { kind }),
        cause: { error: 'CoreError', code: error.code },
      },
      { cause: error },
    );
  }
  if (error instanceof IoError) {
    return new OpError(
      IO_CODES[error.code],
      error.message,
      { cause: { error: 'IoError', code: error.code } },
      { cause: error },
    );
  }
  if (error instanceof ConvertError) {
    return new OpError(
      CONVERT_CODES[error.code],
      error.message,
      { cause: { error: 'ConvertError', code: error.code } },
      { cause: error },
    );
  }
  if (error instanceof AseError) {
    return new OpError(
      'BAD_FILE',
      error.message,
      { cause: { error: 'AseError', code: error.code } },
      { cause: error },
    );
  }
  if (error instanceof RigError) {
    // RigError carries only a message (no ref or candidate list), so just `kind` is known here,
    // matching the CoreError path; ref resolvers in refs.ts raise the full NOT_FOUND themselves.
    const kind = RIG_NOT_FOUND_KINDS[error.code];
    return new OpError(
      RIG_CODES[error.code],
      error.message,
      {
        ...(error.reason === undefined ? {} : { reason: error.reason }),
        ...(kind === undefined ? {} : { kind }),
        cause: { error: 'RigError', code: error.code },
      },
      { cause: error },
    );
  }
  if (error instanceof JointCheckError) {
    return new OpError(
      'INVALID_VALUE',
      error.message,
      { cause: { error: 'JointCheckError', code: error.code } },
      { cause: error },
    );
  }
  if (error instanceof z.ZodError) return inputError(error);
  // A PNG that cannot be decoded is a bad file, not a bug.
  if (error instanceof PngError) {
    return new OpError(
      'BAD_FILE',
      error.message,
      { cause: { error: 'PngError', code: error.code } },
      { cause: error },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new OpError(
    'INTERNAL',
    `internal error: ${message}`,
    { cause: { error: error instanceof Error ? error.name : typeof error } },
    { cause: error },
  );
}
