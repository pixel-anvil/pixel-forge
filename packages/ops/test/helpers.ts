// Shared test helpers: a memory host seeded with the synthetic hero (fixtures/generated/hero.pxf).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MemoryFileSystem, fixedClock } from '@pixel-forge/io';
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
