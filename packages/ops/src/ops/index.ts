/**
 * Every built-in op, and the default registry. To add an op, import it here and append it to
 * {@link ALL_OPS} (any order: the registry sorts by name). See `docs/ai/PLAYBOOKS.md`, "Add an op".
 * @packageDocumentation
 */
import type { AnyOp } from '../define.js';
import { createRegistry } from '../registry.js';
import { docOpen } from './doc-open.js';
import { docSummary } from './doc-summary.js';
import { rigSetPose } from './rig-set-pose.js';

export { docOpen } from './doc-open.js';
export { DocSummary, docSummary } from './doc-summary.js';
export { BoneKeyInput, PartKeyInput, rigSetPose } from './rig-set-pose.js';

/** The built-in ops. */
export const ALL_OPS: readonly AnyOp[] = [docOpen, docSummary, rigSetPose];

/** The registry of the built-in ops, shared by the MCP server, the CLI and the harness. */
export const registry = createRegistry(ALL_OPS);
