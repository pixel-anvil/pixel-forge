// Helpers for the MCP server tests: a client wired to the server over an in-memory transport, on a
// real DocumentHost in a temporary workspace (never the real home).
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registry } from '@pixel-forge/ops';
import type { HostedDocument, OpRegistry } from '@pixel-forge/ops';
import { createDocumentHost, createMcpServer } from '../src/index.js';
import type { DocumentHost, McpServerHandle, McpServerOptions } from '../src/index.js';
import { later, workspace } from './helpers.js';

const CC0 = fileURLToPath(new URL('../../../fixtures/cc0/hero_swordsman/', import.meta.url));

/** The hero's document id (`fixtures/generated/hero.pxf`). */
export const HERO_ID = 'doc_g1ed5q';

/** A parsed tool call. */
export interface Called {
  readonly isError: boolean;
  /** The first text block, parsed as JSON. */
  readonly json: Record<string, unknown>;
  /** The raw text of that block. */
  readonly text: string;
  /** The image blocks. */
  readonly images: { type: 'image'; data: string; mimeType: string }[];
  /** Every content block. */
  readonly content: readonly { type: string }[];
}

/** A connected client and everything the tests need to look behind it. */
export interface McpFixture {
  readonly client: Client;
  readonly handle: McpServerHandle;
  readonly host: DocumentHost;
  readonly base: string;
  readonly root: string;
  readonly hero: string;
  readonly traces: string[];
  /** Calls a tool and parses the result. */
  call(tool: string, args?: Record<string, unknown>): Promise<Called>;
  /** The open document with this id. */
  doc(id: string): HostedDocument;
  /** The labels of a document's undo side, oldest first. */
  labels(id: string): string[];
}

/** Options of {@link mcpFixture}. */
export interface FixtureOptions {
  readonly registry?: OpRegistry;
  readonly serverOptions?: Partial<McpServerOptions>;
  /** `false`: start the server without a trace sink. */
  readonly trace?: boolean;
  /** Runs after the workspace exists and before the server starts (e.g. to write `server.json`). */
  readonly prepare?: (dirs: { base: string; root: string }) => Promise<void> | void;
}

/** Builds a workspace, a server and a connected client. */
export async function mcpFixture(options: FixtureOptions = {}): Promise<McpFixture> {
  const { base, root, hero } = workspace();
  copyFileSync(join(CC0, 'run.png'), join(root, 'run.png'));
  copyFileSync(join(CC0, 'idle.png'), join(root, 'idle.png'));
  mkdirSync(join(root, 'out'));
  await options.prepare?.({ base, root });
  const host = createDocumentHost({ baseDir: base, roots: [root], releaseOnExit: false });
  const traces: string[] = [];
  const handle = await createMcpServer({
    host,
    registry: options.registry ?? registry,
    ...(options.trace === false ? {} : { trace: (line: string) => traces.push(line) }),
    ...options.serverOptions,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await handle.server.connect(serverSide);
  await client.connect(clientSide);
  later(async () => {
    await client.close();
    await handle.close();
  });
  const doc = (id: string): HostedDocument => {
    const found = host.list().find((d) => d.id === id);
    if (found === undefined) throw new Error(`document ${id} is not open`);
    return found;
  };
  return {
    client,
    handle,
    host,
    base,
    root,
    hero,
    traces,
    async call(tool, args = {}) {
      const r = await client.callTool({ name: tool, arguments: args });
      const content = r.content as { type: string; text?: string }[];
      const first = content.find((c) => c.type === 'text');
      return {
        isError: r.isError === true,
        json: JSON.parse(first?.text ?? 'null') as Record<string, unknown>,
        text: first?.text ?? '',
        images: content.filter((c) => c.type === 'image') as Called['images'],
        content,
      };
    },
    doc,
    labels(id) {
      const info = doc(id).store.historyInfo();
      return info.entries.slice(0, info.applied).map((e) => e.label);
    },
  };
}
