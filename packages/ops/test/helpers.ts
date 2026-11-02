// Shared test helpers: a memory host seeded with the synthetic hero (fixtures/generated/hero.pxf).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MemoryFileSystem,
  createDocumentFromSpritesheet,
  fixedClock,
  importSpritesheetTx,
} from '@pixel-forge/io';
import type { DocumentStore } from '@pixel-forge/core';
import { humanoidSide } from '@pixel-forge/rig';
import { applySkeletonTemplate } from '@pixel-forge/core';
import type { DocId } from '@pixel-forge/schema';
import { createMemoryHost, registry } from '../src/index.js';
import type { HostedDocument, OpHost, OpRegistry, RunOptions } from '../src/index.js';

/** The committed hero fixture. */
export const HERO_BYTES = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/generated/hero.pxf', import.meta.url))),
);
/** The hero's document id. */
export const HERO_ID = 'doc_g1ed5q' as DocId;
/** Where tests put the hero. */
export const HERO_PATH = '/work/hero.pxf';

/** A memory host with `/work/hero.pxf`, workspace root `/work`. */
export function heroHost(): { host: OpHost; fs: MemoryFileSystem } {
  const fs = new MemoryFileSystem();
  fs.seed(HERO_PATH, HERO_BYTES);
  return {
    host: createMemoryHost({ fs, clock: fixedClock('2026-11-01T00:00:00Z'), roots: ['/work'] }),
    fs,
  };
}

/** A host with the hero already open through `doc.open`. */
export async function openHero(reg: OpRegistry = registry): Promise<{
  host: OpHost;
  fs: MemoryFileSystem;
  hero: HostedDocument;
  run: RunOptions;
}> {
  const { host, fs } = heroHost();
  const run: RunOptions = { host };
  await reg.execute('doc.open', { path: HERO_PATH }, run);
  const hero = host.list()[0];
  if (hero === undefined) throw new Error('hero not open');
  return { host, fs, hero, run };
}

/** `v`, or a test failure when it is `undefined`. */
export function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected a value');
  return v;
}

/** The OpError-shaped JSON a promise rejects with (fails if it resolves). */
export async function rejection(p: Promise<unknown>): Promise<{
  code: string;
  message: string;
  details: Record<string, unknown>;
}> {
  try {
    await p;
  } catch (e) {
    const err = e as { code: string; message: string; details: Record<string, unknown> };
    return { code: err.code, message: err.message, details: err.details };
  }
  throw new Error('expected a rejection');
}

/** Reads a committed fixture (`fixtures/<rel>`). */
export function fixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../../fixtures/${rel}`, import.meta.url))),
  );
}

/** The labels of a document's undo history, oldest first. */
export function stepLabels(hosted: HostedDocument): string[] {
  return hosted.store.historyInfo().entries.map((e) => e.label);
}

/**
 * A host with a flat (not rigged) document that has the hero's id: the CC0 swordsman run cells as
 * animation `run` (4 frames) and `run_copy` (the same first cell as a separate image), layer `body`.
 * `/work` also holds `run.png` and `idle.png` for `io.import`.
 */
export async function flatHost(rig = false): Promise<{
  host: OpHost;
  fs: MemoryFileSystem;
  hosted: HostedDocument;
  run: RunOptions;
  store: DocumentStore;
}> {
  const fs = new MemoryFileSystem();
  fs.seed('/work/run.png', fixtureBytes('cc0/hero_swordsman/run.png'));
  fs.seed('/work/idle.png', fixtureBytes('cc0/hero_swordsman/idle.png'));
  const host = createMemoryHost({
    fs,
    clock: fixedClock('2026-11-01T00:00:00Z'),
    roots: ['/work'],
  });
  const png = fixtureBytes('cc0/hero_swordsman/run.png');
  const { store } = createDocumentFromSpritesheet(
    {
      png,
      cell: [64, 64],
      animations: [
        {
          group: 'run',
          frames: [
            [0, 0],
            [0, 1],
            [0, 2],
            [1, 0],
          ],
        },
      ],
    },
    { name: 'flat', idSeed: 9 },
  );
  store.transact('copy', (tx) =>
    importSpritesheetTx(tx, {
      png,
      cell: [64, 64],
      animations: [{ group: 'run_copy', frames: [[0, 0]] }],
    }),
  );
  if (rig) {
    store.transact('rig', (tx) => {
      applySkeletonTemplate(tx, humanoidSide({ origin: tx.doc.meta.origin, height: 60 }));
    });
  }
  store.clearHistory();
  const hosted = await host.adopt({ store });
  return { host, fs, hosted, run: { host }, store };
}

/** The `{path, message}` issues of a `BAD_INPUT` rejection. */
export function issues(r: {
  details: Record<string, unknown>;
}): { path: string; message: string }[] {
  return (r.details.issues ?? []) as { path: string; message: string }[];
}
