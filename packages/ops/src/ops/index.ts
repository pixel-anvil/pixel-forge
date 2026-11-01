/**
 * Every built-in op, and the default registry. To add an op, import it here and append it to
 * {@link ALL_OPS} (any order: the registry sorts by name). See `docs/ai/PLAYBOOKS.md`, "Add an op".
 * @packageDocumentation
 */
import type { AnyOp } from '../define.js';
import { createRegistry } from '../registry.js';
import { animCreate } from './anim-create.js';
import { animUpdate } from './anim-update.js';
import { celLink } from './cel-link.js';
import { docCreate } from './doc-create.js';
import { docSave } from './doc-save.js';
import { docSetColorMode } from './doc-set-color-mode.js';
import { frameSetMeta } from './frame-set-meta.js';
import { ioExport } from './io-export.js';
import { ioImport } from './io-import.js';
import { layerUpdate } from './layer-update.js';
import { overrideList } from './override-list.js';
import { overrideResolve } from './override-resolve.js';
import { partPaintOverlap } from './part-paint-overlap.js';
import { partSplit } from './part-split.js';
import { rigBake } from './rig-bake.js';
import { rigBindParts } from './rig-bind-parts.js';
import { rigEditBones } from './rig-edit-bones.js';
import { rigMirrorAnimation } from './rig-mirror-animation.js';
import { rigSetPivot } from './rig-set-pivot.js';
import { docOpen } from './doc-open.js';
import { docRedo } from './doc-redo.js';
import { docSummary } from './doc-summary.js';
import { docUndo } from './doc-undo.js';
import { frameAdd } from './frame-add.js';
import { frameDelete } from './frame-delete.js';
import { frameDuplicate } from './frame-duplicate.js';
import { lintRun } from './lint-run.js';
import { rigApplyTemplate } from './rig-apply-template.js';
import { rigJointCheck } from './rig-joint-check.js';
import { rigSetPose } from './rig-set-pose.js';

export { animCreate } from './anim-create.js';
export { animUpdate } from './anim-update.js';
export { celLink } from './cel-link.js';
export { docCreate } from './doc-create.js';
export { docSave } from './doc-save.js';
export { docSetColorMode } from './doc-set-color-mode.js';
export { frameSetMeta } from './frame-set-meta.js';
export { ioExport } from './io-export.js';
export { CellSpec, MAX_CELLS, expandCells, ioImport } from './io-import.js';
export { layerUpdate } from './layer-update.js';
export { overrideList } from './override-list.js';
export { overrideResolve } from './override-resolve.js';
export { partPaintOverlap } from './part-paint-overlap.js';
export { SplitSelectionInput, partSplit } from './part-split.js';
export { rigBake } from './rig-bake.js';
export { rigBindParts } from './rig-bind-parts.js';
export { BoneEdit, rigEditBones } from './rig-edit-bones.js';
export { rigMirrorAnimation } from './rig-mirror-animation.js';
export { rigSetPivot } from './rig-set-pivot.js';
export { docOpen } from './doc-open.js';
export { docRedo } from './doc-redo.js';
export { DocSummary, docSummary } from './doc-summary.js';
export { docUndo } from './doc-undo.js';
export { frameAdd } from './frame-add.js';
export { frameDelete } from './frame-delete.js';
export { frameDuplicate } from './frame-duplicate.js';
export { lintRun } from './lint-run.js';
export { rigApplyTemplate } from './rig-apply-template.js';
export { rigJointCheck } from './rig-joint-check.js';
export { BoneKeyInput, PartKeyInput, rigSetPose } from './rig-set-pose.js';

/** The built-in ops. */
export const ALL_OPS: readonly AnyOp[] = [
  animCreate,
  animUpdate,
  celLink,
  docCreate,
  docSave,
  docSetColorMode,
  frameSetMeta,
  ioExport,
  ioImport,
  layerUpdate,
  overrideList,
  overrideResolve,
  partPaintOverlap,
  partSplit,
  rigBake,
  rigBindParts,
  rigEditBones,
  rigMirrorAnimation,
  rigSetPivot,
  docOpen,
  docRedo,
  docSummary,
  docUndo,
  frameAdd,
  frameDelete,
  frameDuplicate,
  lintRun,
  rigApplyTemplate,
  rigJointCheck,
  rigSetPose,
];

/** The registry of the built-in ops, shared by the MCP server, the CLI and the harness. */
export const registry = createRegistry(ALL_OPS);
