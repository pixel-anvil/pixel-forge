/**
 * `@pixel-forge/io`: spritesheet import and export (T4.3) today; `.pxf` and `.aseprite` follow.
 * The sheet functions are pure byte-in/byte-out and need no `FileSystem` port.
 * @packageDocumentation
 */

/** Package identifier, used by the scaffold smoke test. */
export const ioPackage = '@pixel-forge/io' as const;

export { IoError } from './errors.js';
export type { IoErrorCode } from './errors.js';
export {
  DEFAULT_FRAME_MS,
  cc0SheetInputs,
  cellOffset,
  createDocumentFromSpritesheet,
  defaultOrigin,
  importSpritesheetTx,
} from './sheet-import.js';
export type {
  CreateFromSheetOptions,
  SheetAnimationSpec,
  SheetImportInput,
  SheetImportResult,
} from './sheet-import.js';
export { SHEET_APP, SHEET_VERSION, animationLabel, exportSpritesheet } from './sheet-export.js';
export type {
  AseFrame,
  AseFrameTag,
  AseRect,
  AseSheetJson,
  ExportSheetOptions,
  ExportedSheet,
} from './sheet-export.js';
export { DEFAULT_MAX_LONG_EDGE, contactSheet, contactSheetPlan } from './contact-sheet.js';
export type { ContactSheetOptions, ContactSheetPlan, ContactSheetTile } from './contact-sheet.js';
export * from './aseprite/index.js';

// `.pxf` read/write, migrations, render cache, atomic save, pack/unpack, FileSystem and Clock ports (T4.2).
export { MemoryFileSystem, dirnameOf, fixedClock, joinPath, steppedClock } from './fs.js';
export type { Clock, DirEntry, FileSystem, MemoryFileSystemOptions, MemoryFsOp } from './fs.js';
export { PIXEL_FORGE_VERSION, PXF_APP, pxfContentHash, pxfStore, pxfView } from './pxf/file.js';
export type { PxfFile } from './pxf/file.js';
export { readPxf } from './pxf/read.js';
export type { ReadPxfOptions } from './pxf/read.js';
export { buildPxf, writePxf } from './pxf/write.js';
export type { BuiltPxf, WritePxfOptions } from './pxf/write.js';
export { buildRenderCache, directionKey } from './pxf/render-cache.js';
export type { RenderCache, RenderCacheOptions } from './pxf/render-cache.js';
export { MIGRATIONS, fileVersion, migrate } from './pxf/migrations.js';
export type { JsonRecord, Migration, MigrationRegistry, PxfJson } from './pxf/migrations.js';
export { canonicalBytes, canonicalPretty } from './pxf/json.js';
export {
  JSON_DEFLATE_LEVEL,
  JSON_DEFLATE_MEM,
  MAX_ENTRY_BYTES,
  buildZip,
  dosDateTime,
  isSafeEntryPath,
  orderEntries,
  readZip,
} from './pxf/zip.js';
export type { ZipEntry } from './pxf/zip.js';
export { saveAtomic } from './pxf/atomic.js';
export type { SaveAtomicOptions } from './pxf/atomic.js';
export { GDIGNORE, pack, unpack } from './pxf/pack.js';
export type { UnpackOptions } from './pxf/pack.js';
