/**
 * `@pixel-forge/core`: the document store (immutable JSON plus copy-on-write images), transactions,
 * patches, the linear undo/redo history with a memory cap, change events, `documentHash`, and the
 * rig render hook interface. Pure: no DOM, no Node built-ins, no clock, no randomness.
 * See the package README and `docs/ai/PLAYBOOKS.md` ("How mutations work").
 * @packageDocumentation
 */

/** Package identifier, used by the scaffold smoke test. */
export const corePackage = '@pixel-forge/core' as const;

export { CoreError } from './errors.js';
export type { CoreErrorCode } from './errors.js';
export { canonicalJson, getAt, isSealed, jsonEqual } from './json.js';
export type {
  DeepReadonly,
  JsonArray,
  JsonContainer,
  JsonObject,
  JsonPath,
  JsonPrimitive,
  JsonValue,
} from './json.js';
export { invertOp, invertOps } from './patch.js';
export type { AddOp, RemoveOp, ReplaceOp, StructuralOp } from './patch.js';
export { imageHash } from './images.js';
export type {
  CreateImagePatch,
  DeleteImagePatch,
  ImagePatch,
  ImageSource,
  StoredImage,
  TilesPatch,
} from './images.js';
export {
  DEFAULT_MEMORY_CAP,
  IMAGE_PATCH_OVERHEAD_BYTES,
  OP_OVERHEAD_BYTES,
  SNAPSHOT_OVERHEAD_BYTES,
  estimateJsonBytes,
  estimatePatchBytes,
  invertPatch,
} from './history.js';
export type { HistoryEntry, HistoryEntryInfo, HistoryInfo, Patch } from './history.js';
export type { ChangeEvent, ChangeKind, ChangeListener } from './events.js';
export type { DocumentSnapshot, DocumentView } from './view.js';
export { Transaction } from './transaction.js';
export { DocumentStore } from './store.js';
export type { StoreOptions } from './store.js';
export { documentCanonical, documentHash } from './hash.js';
export type { RenderedPart, RigFrameContext, RigRenderer } from './rig-hook.js';
