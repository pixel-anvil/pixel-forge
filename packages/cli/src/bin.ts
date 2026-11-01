#!/usr/bin/env node
// Entry of the `pf` bundle (tsup). Kept to three lines: everything testable is in `runCli`.
import { runCli } from './program.js';

process.exitCode = await runCli(process.argv.slice(2));
