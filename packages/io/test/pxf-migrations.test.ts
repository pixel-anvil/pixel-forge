import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { SCHEMA_VERSION } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, pxfStore, readPxf, writePxf } from '../src/index.js';
import type { MigrationRegistry, PxfJson } from '../src/index.js';
import { ioCode } from './helpers.js';
import { frozenStore, opts } from './pxf-helpers.js';

/** A v1 file rewritten to claim `version`, with an optional document edit. */
function asVersion(version: number, edit?: (doc: Record<string, unknown>) => void): Uint8Array {
  const files = unzipSync(writePxf(frozenStore(), opts({ renderCache: true })));
  const manifest = JSON.parse(strFromU8(files['manifest.json'] ?? new Uint8Array())) as Record<
    string,
    unknown
  >;
  const doc = JSON.parse(strFromU8(files['document.json'] ?? new Uint8Array())) as {
    meta: Record<string, unknown>;
  };
  manifest.schemaVersion = version;
  doc.meta.schemaVersion = version;
  edit?.(doc);
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  files['document.json'] = strToU8(JSON.stringify(doc));
  return zipSync(files);
}

describe('migration registry', () => {
  it('v1 is the baseline: the shipped registry is empty and the current version passes through', () => {
    expect(Object.keys(MIGRATIONS)).toEqual([]);
    expect(SCHEMA_VERSION).toBe(1);
    const json: PxfJson = {
      manifest: { schemaVersion: 1 },
      document: { meta: { schemaVersion: 1 } },
    };
    const r = migrate(json);
    expect(r.migrated).toBe(false);
    expect(r.json).toBe(json);
  });

  it('upgrades a synthetic v0 file with a v0 -> v1 step (rename meta.title to meta.name)', () => {
    const bytes = asVersion(0, (doc) => {
      const meta = doc.meta as Record<string, unknown>;
      meta.title = meta.name;
      delete meta.name;
    });
    const registry: MigrationRegistry = {
      0: (json) => {
        const meta = json.document.meta as Record<string, unknown>;
        meta.name = meta.title;
        delete meta.title;
        return json;
      },
    };
    expect(ioCode(() => readPxf(bytes))).toBe('MIGRATION_MISSING');
    const file = readPxf(bytes, { migrations: registry });
    expect(file.doc.meta.name).toBe('hero');
    expect(file.doc.meta.schemaVersion).toBe(1);
    expect(file.manifest.schemaVersion).toBe(1);
    // The render cache is derived data and is dropped from a migrated file.
    expect(file.renderIndex).toBeUndefined();
    expect(file.renderPngs.size).toBe(0);
    expect(file.warnings.join()).toContain('migrated');
    // Saving upgrades the file in place; it is v1 afterwards and byte-stable.
    const saved = writePxf(pxfStore(file), opts({ renderCache: false, previous: file }));
    const again = readPxf(saved);
    expect(again.manifest.schemaVersion).toBe(1);
    expect(writePxf(pxfStore(again), opts({ renderCache: false, previous: again }))).toEqual(saved);
  });

  it('chains steps in order and does not mutate the caller input', () => {
    const calls: number[] = [];
    const registry: MigrationRegistry = {
      0: (j) => (calls.push(0), j),
      1: (j) => (calls.push(1), j),
    };
    const input: PxfJson = {
      manifest: { schemaVersion: 0 },
      document: { meta: { schemaVersion: 0 } },
    };
    const r = migrate(input, registry, 2);
    expect(calls).toEqual([0, 1]);
    expect(r.json.manifest.schemaVersion).toBe(2);
    expect((r.json.document.meta as Record<string, unknown>).schemaVersion).toBe(2);
    expect(input.manifest.schemaVersion).toBe(0);
  });

  it('rejects files from a newer version', () => {
    expect(ioCode(() => readPxf(asVersion(SCHEMA_VERSION + 1)))).toBe('UNSUPPORTED_VERSION');
    // Even if a (wrongly shaped) future step existed, a newer file is never "downgraded".
    expect(ioCode(() => readPxf(asVersion(5), { migrations: { 0: (j) => j } }))).toBe(
      'UNSUPPORTED_VERSION',
    );
  });

  it('reports failing or malformed steps', () => {
    const v0 = asVersion(0);
    expect(
      ioCode(() =>
        readPxf(v0, {
          migrations: {
            0: () => {
              throw new Error('boom');
            },
          },
        }),
      ),
    ).toBe('MIGRATION_FAILED');
    expect(
      ioCode(() =>
        readPxf(v0, { migrations: { 0: (() => 42) as unknown as MigrationRegistry[number] } }),
      ),
    ).toBe('MIGRATION_FAILED');
    expect(
      ioCode(() =>
        readPxf(v0, {
          migrations: {
            0: (() => ({ manifest: {}, document: 1 })) as unknown as MigrationRegistry[number],
          },
        }),
      ),
    ).toBe('MIGRATION_FAILED');
  });

  it('the frozen v1 document keeps opening after a (synthetic) v2 exists', () => {
    // Simulates the future: target 2 with a v1 -> v2 step that must accept the frozen fixture.
    const file = readPxf(writePxf(frozenStore(), opts({ renderCache: false })));
    const json: PxfJson = {
      manifest: JSON.parse(JSON.stringify(file.manifest)) as PxfJson['manifest'],
      document: JSON.parse(JSON.stringify(file.doc)) as PxfJson['document'],
    };
    const r = migrate(json, { 1: (j) => j }, 2);
    expect(r.migrated).toBe(true);
    expect((r.json.document.meta as Record<string, unknown>).schemaVersion).toBe(2);
  });
});
