/**
 * Typed errors of `@pixel-forge/core`.
 * @packageDocumentation
 */

/**
 * Machine-readable error codes. Additive: later cards may add codes, never rename them.
 *
 * - `TX_ACTIVE`: `begin`, `undo`, `redo` or `clearHistory` while a transaction is open (no nesting).
 * - `TX_CLOSED`: a call on a transaction that was committed, cancelled or aborted by an error.
 * - `TX_BUSY`: a re-entrant call during an `update` recipe (only `newId` and image calls are allowed
 *   there), during a `writeImage` callback (any transaction or store change; aborts the transaction),
 *   or from inside a change listener (any store change).
 * - `TX_ASYNC`: the callback of `transact` returned a promise; transactions are synchronous.
 * - `BAD_PATH`: a JSON path that does not resolve, points into a primitive, or has a bad segment.
 * - `BAD_VALUE`: a value that is not plain JSON (`undefined`, non-finite number, function, class
 *   instance, cycle, array hole, `__proto__` key), or a root that is not an object.
 * - `BAD_ARGUMENT`: any other invalid argument (empty label, negative memory cap, wrong image type).
 * - `IMAGE_EXISTS`, `IMAGE_MISSING`: image store lookups.
 * - `IMAGE_MUTATED`: a published image was mutated outside a transaction (its `version` moved).
 * - `ID_EXHAUSTED`: `meta.ids.next` reached 2^30.
 * - `PATCH_CONFLICT`: a patch does not match the state it is applied to (a bug or corrupt history).
 * - `NO_RIG_RENDERER`: reserved for `renderFrame` (T2.3), when a frame needs part layers and no
 *   `RigRenderer` was given.
 */
export type CoreErrorCode =
  | 'TX_ACTIVE'
  | 'TX_CLOSED'
  | 'TX_BUSY'
  | 'TX_ASYNC'
  | 'BAD_PATH'
  | 'BAD_VALUE'
  | 'BAD_ARGUMENT'
  | 'IMAGE_EXISTS'
  | 'IMAGE_MISSING'
  | 'IMAGE_MUTATED'
  | 'ID_EXHAUSTED'
  | 'PATCH_CONFLICT'
  | 'NO_RIG_RENDERER';

/** An error raised by the document store, a transaction or the patch machinery. */
export class CoreError extends Error {
  /** Machine-readable code. */
  readonly code: CoreErrorCode;
  /** Optional structured context (path, image id...). */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: CoreErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.details = details;
  }
}
