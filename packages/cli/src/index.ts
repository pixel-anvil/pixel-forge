/** Package identifier. */
export const cliPackage = '@pixel-forge/cli' as const;

export { runCli, createProgram } from './program.js';
export { runCheck, loadScript } from './check.js';
export type { CheckFlags, CheckReport, LintReport, StepReport, StepStatus } from './check.js';
export {
  Script,
  ScriptStep,
  StepExpect,
  RefError,
  parseRef,
  partialMismatches,
  resolveRefs,
} from './check-script.js';
export type { StepOutputs } from './check-script.js';
export { runMcp } from './mcp.js';
export type { McpFlags } from './mcp.js';
export { addOpCommand, addRegistryCommands, optionFor, runOpCommand } from './registry-commands.js';
export type { OpCommandPlan, WiringContext } from './registry-commands.js';
export { openHost, homeOption, rootOption, HOME_ENV } from './host.js';
export type { HostFlags } from './host.js';
export { resolveEnv, UsageError, writeJson } from './env.js';
export type { CliEnv, ShutdownSignal, SignalSource } from './env.js';
export { imageOf, withoutImageData, writeImage } from './images.js';
export type { OutputImage } from './images.js';
export { PATH_INPUT_KEYS, resolvePathInputs } from './paths.js';
export { VERSION } from './version.js';
