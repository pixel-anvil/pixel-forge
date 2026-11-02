// A real `pf mcp`-like process for the stdio test. Arguments: <baseDir> <root>.
// Serves MCP on stdin/stdout, writes the trace to stderr, and leaves when stdin closes. The exit
// sweep of the lockfiles is turned off, so a released lock proves that closing disposed the host.
import { registry } from '@pixel-forge/ops';
import { createDocumentHost, serveStdio } from '../../dist/index.js';

const [baseDir, root] = process.argv.slice(2);
const host = createDocumentHost({ baseDir, roots: [root], releaseOnExit: false });
const handle = await serveStdio({
  host,
  registry,
  trace: (line) => process.stderr.write(`${line}\n`),
});
await handle.closed;
