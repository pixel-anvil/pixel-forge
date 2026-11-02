/**
 * The `.pxf` migration registry (ADR-005, NFR-03): forward-only upgrades of raw JSON, run before
 * schema validation. v1 is the baseline, so the shipped registry is empty; a breaking schema change
 * (new `SCHEMA_VERSION`) adds one step per version here, plus an ADR.
 * @packageDocumentation
 */
import { SCHEMA_VERSION } from '@pixel-forge/schema';
import { IoError } from '../errors.js';

/** A plain JSON object. */
export type JsonRecord = Record<string, unknown>;

/**
 * The raw JSON of a file that migrations work on: `manifest.json` and `document.json`. The render
 * cache is derived data and is dropped when a file is migrated (the next save rebuilds it).
 */
export interface PxfJson {
  manifest: JsonRecord;
  document: JsonRecord;
}

/**
 * One migration step: takes the JSON of version `v` and returns the JSON of version `v + 1`. It
 * receives its own deep copy, so it may mutate and return it. The runner sets
 * `manifest.schemaVersion` and `document.meta.schemaVersion` to `v + 1` afterwards, so a step only
 * changes the shape.
 */
export type Migration = (json: PxfJson) => PxfJson;

/** Migrations by the version they upgrade *from*: `{ 0: fromV0, 1: fromV1 }`. */
export type MigrationRegistry = Readonly<Record<number, Migration>>;

/** The migrations shipped with this build. Empty: schema v1 is the baseline (frozen fixture). */
export const MIGRATIONS: MigrationRegistry = Object.freeze({});

const isRecord = (v: unknown): v is JsonRecord =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `schemaVersion` of a raw `manifest.json`, which must equal the document's `meta.schemaVersion`. */
export function fileVersion(json: PxfJson): number {
  const m = json.manifest.schemaVersion;
  if (typeof m !== 'number' || !Number.isInteger(m) || m < 0) {
    throw new IoError('BAD_PXF', 'manifest.json has no integer schemaVersion');
  }
  const meta = json.document.meta;
  const d = isRecord(meta) ? meta.schemaVersion : undefined;
  if (d !== m) {
    throw new IoError(
      'BAD_PXF',
      `manifest.json schemaVersion ${String(m)} differs from document.json meta.schemaVersion ${String(d)}`,
    );
  }
  return m;
}

/**
 * Upgrades `json` from its own version to `target` (default {@link SCHEMA_VERSION}), one step at a
 * time. Returns the input itself when it is already at `target`.
 * @throws IoError `UNSUPPORTED_VERSION` (file newer than `target`), `MIGRATION_MISSING` (no step for
 *   a version on the way), `MIGRATION_FAILED` (a step threw or returned a non-bundle).
 */
export function migrate(
  json: PxfJson,
  registry: MigrationRegistry = MIGRATIONS,
  target: number = SCHEMA_VERSION,
): { json: PxfJson; migrated: boolean } {
  let v = fileVersion(json);
  if (v > target) {
    throw new IoError(
      'UNSUPPORTED_VERSION',
      `file schema version ${String(v)} is newer than this build supports (${String(target)}); upgrade pixel-forge`,
    );
  }
  if (v === target) return { json, migrated: false };
  let cur: PxfJson = JSON.parse(JSON.stringify(json)) as PxfJson;
  while (v < target) {
    const step = Object.hasOwn(registry, v) ? registry[v] : undefined;
    if (step === undefined) {
      throw new IoError('MIGRATION_MISSING', `no migration from schema version ${String(v)}`);
    }
    let next: PxfJson;
    try {
      next = step(cur);
    } catch (e) {
      throw new IoError('MIGRATION_FAILED', `migration from version ${String(v)} failed`, {
        cause: e,
      });
    }
    if (!isRecord(next) || !isRecord(next.manifest) || !isRecord(next.document)) {
      throw new IoError(
        'MIGRATION_FAILED',
        `migration from version ${String(v)} did not return { manifest, document }`,
      );
    }
    v += 1;
    next.manifest.schemaVersion = v;
    const meta = next.document.meta;
    if (isRecord(meta)) meta.schemaVersion = v;
    cur = next;
  }
  return { json: cur, migrated: true };
}
