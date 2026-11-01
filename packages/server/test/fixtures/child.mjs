// A second process for the ownership tests. Arguments: <mode> <baseDir> <root> <docPath>.
// Protocol: prints {"ready":true}; waits for a "go" line on stdin; does its work and prints one JSON
// line ({"ok":true,"pid"} or {"ok":false,"code","details"}); exits when stdin closes, WITHOUT
// releasing anything itself (the exit sweep of the library must remove the lock).
import { createInterface } from 'node:readline';
import { registry } from '@pixel-forge/ops';
import { acquireLock, createDocumentHost } from '../../dist/index.js';

const [mode, baseDir, root, docPath] = process.argv.slice(2);
const host = createDocumentHost({ baseDir, roots: [root] });

async function work() {
  if (mode === 'lock') {
    await acquireLock({ baseDir, path: docPath });
  } else {
    await registry.execute('doc.open', { path: docPath }, { host });
  }
}

const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin });
print({ ready: true });
lines.on('line', (line) => {
  if (line !== 'go') return;
  work().then(
    () => print({ ok: true, pid: process.pid }),
    (e) => print({ ok: false, code: e.code, details: e.details, message: String(e.message) }),
  );
});
lines.on('close', () => {
  // keep the lock until the parent says so, then leave like a normal exit
  process.exit(0);
});
