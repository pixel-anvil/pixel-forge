import { Command, CommanderError, Option } from 'commander';
import { registry as builtinRegistry } from '@pixel-forge/ops';
import type { OpRegistry } from '@pixel-forge/ops';
import { runCheck } from './check.js';
import type { CheckFlags } from './check.js';
import { UsageError, resolveEnv } from './env.js';
import { runGodotInstall } from './godot-install.js';
import type { CliEnv } from './env.js';
import { homeOption, rootOption } from './host.js';
import { runMcp } from './mcp.js';
import type { McpFlags } from './mcp.js';
import { addRegistryCommands } from './registry-commands.js';
import type { WiringContext } from './registry-commands.js';
import { VERSION } from './version.js';

/**
 * Builds the `pf` command tree: `version`, `mcp`, `check` and one subcommand per registry op.
 * Actions store their exit code in `ctx.exitCode`.
 */
export function createProgram(ctx: WiringContext, registry: OpRegistry = builtinRegistry): Command {
  const { env } = ctx;
  const program = new Command('pf')
    .description('pixel-forge: edit .pxf pixel-art documents from a terminal or an AI client.')
    .version(VERSION)
    .exitOverride()
    .showHelpAfterError()
    .configureOutput({
      writeOut: (s) => env.stdout.write(s),
      writeErr: (s) => env.stderr.write(s),
    });

  program
    .command('version')
    .description('Print the pf version.')
    .action(() => {
      env.stdout.write(`${VERSION}\n`);
    });

  program
    .command('mcp')
    .description('Serve MCP over stdio (stdout is protocol only).')
    .addOption(rootOption())
    .addOption(homeOption())
    .addOption(
      new Option(
        '--trace [file]',
        'Trace every tool call as a JSON line: to the file, or to stderr when none is given.',
      ),
    )
    .addOption(
      new Option(
        '--tools <groups>',
        'Tool groups to list, comma-separated: core, rig, palette, convert, or all (default: all; env PF_TOOLS).',
      ),
    )
    .action(async (flags: McpFlags) => {
      ctx.exitCode = await runMcp(env, flags);
    });

  program
    .command('check')
    .description('Run a steps.json script headlessly; write report.json and PNGs to --out.')
    .requiredOption('--script <file>', 'The steps file (see the CLI README).')
    .requiredOption('--out <dir>', 'Folder for report.json and the PNGs.')
    .addOption(rootOption())
    .addOption(homeOption())
    .action(async (flags: CheckFlags) => {
      ctx.exitCode = await runCheck(env, flags);
    });

  program
    .command('godot')
    .description('Godot project helpers.')
    .command('install')
    .description('Copy the pixel-forge addon into <res-dir>/addons/pixel_forge.')
    .argument('<res-dir>', 'The Godot project folder (it holds project.godot).')
    .action((resDir: string) => {
      ctx.exitCode = runGodotInstall(env, resDir);
    });

  addRegistryCommands(program, ctx, registry);
  return program;
}

/**
 * Runs `pf` with `argv` (without the node and script words) and resolves with the exit code:
 * 0 ok, 1 an op, step or expectation failed, 2 usage error or invalid script.
 *
 * `partial` replaces the process streams, working directory, environment and signal source, so
 * tests run the whole CLI in process.
 */
export async function runCli(
  argv: readonly string[],
  partial: Partial<CliEnv> = {},
): Promise<number> {
  const env = resolveEnv(partial);
  const ctx: WiringContext = { env, exitCode: 0 };
  try {
    await createProgram(ctx).parseAsync(argv, { from: 'user' });
    return ctx.exitCode;
  } catch (e) {
    if (e instanceof CommanderError) {
      return e.code === 'commander.helpDisplayed' || e.code === 'commander.version' ? 0 : 2;
    }
    if (e instanceof UsageError) {
      env.stderr.write(`pf: ${e.message}\n`);
      return 2;
    }
    env.stderr.write(`pf: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
