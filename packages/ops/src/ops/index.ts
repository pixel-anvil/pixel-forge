/**
 * Every built-in op, and the default registry. To add an op, import it here and append it to
 * {@link ALL_OPS} (any order: the registry sorts by name). See `docs/ai/PLAYBOOKS.md`, "Add an op".
 * @packageDocumentation
 */
import type { AnyOp } from '../define.js';
import { createRegistry } from '../registry.js';
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
