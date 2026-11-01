/**
 * `@pixel-forge/ops`: the operation API (spec 6.3, ADR-003). `defineOp`, the registry that runs
 * each op as one transaction (one undo step), `OpContext`, `OpError`, safety classes, reference
 * resolution, the document host interface, the generators (MCP tool JSON, CLI metadata,
 * `OPERATIONS.md`) and the built-in ops. No Node built-ins: files go through the host's ports.
 * See the package README and `docs/ai/PLAYBOOKS.md` ("Add an op").
 * @packageDocumentation
 */

/** Package identifier, used by the scaffold smoke test. */
export const opsPackage = '@pixel-forge/ops' as const;

export {
  CLI_WORD_REGEX,
  MAX_SUMMARY,
  MCP_NAME_REGEX,
  OP_NAME_REGEX,
  SAFETY_CLASSES,
  defaultCliCommand,
  defaultMcpName,
  defineOp,
} from './define.js';
export type {
  AnyOp,
  OpDefinition,
  OpExample,
  OpHandler,
  OpInputSchema,
  OpSpec,
  Safety,
} from './define.js';
export { OP_ERROR_CODES, OpError, inputError, toOpError } from './errors.js';
export type { InputIssue, OpErrorCode, OpErrorDetails, OpErrorJson } from './errors.js';
export { silentLogger } from './context.js';
export type { OpContext, OpLogger, RenderedFrame } from './context.js';
export { createMemoryHost, normalizePath } from './host.js';
export type { AdoptInit, HostedDocument, MemoryHostOptions, OpHost } from './host.js';
export {
  AnimRef,
  BoneRef,
  DocRef,
  FrameRef,
  LayerRef,
  MAX_AVAILABLE,
  PartRef,
  VariantRef,
  ViewRef,
  animationLabel,
  partName,
  partNamer,
  partResolver,
  requireRig,
  resolveAnimation,
  resolveAuthoredAnimation,
  resolveBone,
  resolveFrame,
  resolveLayer,
  resolvePart,
  resolveVariant,
  resolveView,
  viewForAnimation,
  walkLayers,
} from './refs.js';
export type {
  ReadonlyDocument,
  ResolvedAnimation,
  ResolvedAuthored,
  ResolvedFrame,
  ResolvedLayer,
  ResolvedPart,
} from './refs.js';
export { DEFAULT_LABEL_PREFIX, OpRegistry, createRegistry } from './registry.js';
export type { DocState, OpCallResult, OpFailure, OpSuccess, RunOptions } from './registry.js';
export {
  CONFIRM_SCHEMA,
  CONVENTIONS,
  GENERATED_PATHS,
  cliMetadata,
  exampleInput,
  generatedFiles,
  mcpTools,
  opInputSchema,
  operationsMarkdown,
  toJsonSchema,
  toolDescription,
  typeLabel,
} from './generate.js';
export type {
  CliCommand,
  CliMetadata,
  CliOption,
  CliOptionKind,
  GeneratedFile,
  JsonSchema,
  McpToolDefinition,
} from './generate.js';
export {
  ALL_OPS,
  BoneKeyInput,
  DocSummary,
  PartKeyInput,
  docOpen,
  docRedo,
  docSummary,
  docUndo,
  frameAdd,
  frameDelete,
  frameDuplicate,
  lintRun,
  registry,
  rigApplyTemplate,
  rigJointCheck,
  rigSetPose,
} from './ops/index.js';
