/**
 * Typed errors of the io functions (sheets, `.pxf`, file system).
 * @packageDocumentation
 */

/**
 * Machine-readable codes of {@link IoError}. Additive: later cards may add codes.
 *
 * - `BAD_INPUT`: a malformed argument (cell size, scale, animation spec, sheet JSON).
 * - `CELL_OUT_OF_RANGE`: a `[row, col]` cell lies outside the sheet image.
 * - `SIZE_MISMATCH`: the outline sheet does not have the size of the main sheet.
 * - `DUPLICATE_ANIMATION`: an animation `(group, direction)` appears twice, or already exists.
 * - `TOO_LARGE`: the result cannot be made to fit the requested size limit or the image size limit.
 * - `BAD_PXF`: the bytes (or folder) are not a readable `.pxf`: not a ZIP, a missing or unsafe entry,
 *   bad JSON, an undecodable image, or a document that disagrees with its manifest (T4.2).
 * - `INVALID_DOCUMENT`: `document.json` or `manifest.json` fails the schema; `cause` is the zod error.
 * - `UNSUPPORTED_VERSION`: the file was written by a newer schema version than this build knows.
 * - `MIGRATION_MISSING`: the file is older than the current version and the registry has no step for it.
 * - `MIGRATION_FAILED`: a migration step threw or returned something that is not a document bundle.
 * - `RIG_REQUIRED`: the render cache needs the part renderer (the document has exported part layers)
 *   and no `rig` option was given.
 * - `FS_FAILED`: a `FileSystem` call failed; `cause` is the original error.
 * - `EXISTS`: `unpack` was asked to write into a folder that already exists.
 */
export type IoErrorCode =
  | 'BAD_INPUT'
  | 'CELL_OUT_OF_RANGE'
  | 'SIZE_MISMATCH'
  | 'DUPLICATE_ANIMATION'
  | 'TOO_LARGE'
  | 'BAD_PXF'
  | 'INVALID_DOCUMENT'
  | 'UNSUPPORTED_VERSION'
  | 'MIGRATION_MISSING'
  | 'MIGRATION_FAILED'
  | 'RIG_REQUIRED'
  | 'FS_FAILED'
  | 'EXISTS';

/** The error type thrown by `@pixel-forge/io`. Branch on `code`. */
export class IoError extends Error {
  readonly code: IoErrorCode;

  constructor(code: IoErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'IoError';
    this.code = code;
  }
}
