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
