/**
 * `readPxf`: bytes of a `.pxf` file to a validated {@link PxfFile} (spec 7, NFR-03).
 * @packageDocumentation
 */
import { decodePngRaw } from '@pixel-forge/png';
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { Document, ImageId, Manifest, RenderIndex } from '@pixel-forge/schema';
import type { Document as DocumentT } from '@pixel-forge/schema';
import { referencedImages } from '@pixel-forge/core';
import type { StoredImage } from '@pixel-forge/core';
import { IoError } from '../errors.js';
import type { PxfFile } from './file.js';
import { parseJsonBytes } from './json.js';
import { MIGRATIONS, migrate } from './migrations.js';
import type { JsonRecord, MigrationRegistry } from './migrations.js';
import { readZip } from './zip.js';

/** Options of {@link readPxf}. */
export interface ReadPxfOptions {
  /** Migration steps to use instead of the shipped registry (tests, future versions). */
  readonly migrations?: MigrationRegistry;
  /** The version to upgrade to; default the build's `SCHEMA_VERSION`. For tests of the registry. */
  readonly targetVersion?: number;
}

const isRecord = (v: unknown): v is JsonRecord =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The part of a zod error that is used here (`io` does not depend on zod itself). */
interface IssueList {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}

type Parsed<T> = { success: true; data: T } | { success: false; error: IssueList };

function describeIssues(err: IssueList): string {
  const shown = err.issues.slice(0, 5).map((i) => {
    const p = i.path.map(String).join('.');
    return `${p === '' ? '(root)' : p}: ${i.message}`;
  });
  const more = err.issues.length - shown.length;
  return shown.join('; ') + (more > 0 ? `; and ${String(more)} more` : '');
}

function parseWith<T>(
  schema: { safeParse(v: unknown): Parsed<T> },
  json: unknown,
  what: string,
): T {
  const r = schema.safeParse(json);
  if (!r.success) {
    throw new IoError('INVALID_DOCUMENT', `${what} is invalid: ${describeIssues(r.error)}`, {
      cause: r.error,
    });
  }
  return r.data;
}

/**
 * The index an indexed image reads back with. A grayscale PNG stores no transparent index, so it is
 * derived from the document: the first entry with alpha 0 in the active palette, else 0.
 */
function transparentIndexOf(doc: DocumentT): number {
  const pal = doc.palettes.find((p) => p.id === doc.activePaletteId);
  const i = pal?.colors.findIndex((c) => c[3] === 0) ?? -1;
  return i < 0 ? 0 : i;
}

function decodeImage(id: string, bytes: Uint8Array, transparentIndex: number): StoredImage {
  try {
    const png = decodePngRaw(bytes);
    return png.kind === 'gray8'
      ? IndexedImage.fromIndices(png.width, png.height, png.data, transparentIndex)
      : TiledImage.fromRGBA(png);
  } catch (e) {
    throw new IoError('BAD_PXF', `images/${id}.png is not a readable PNG`, { cause: e });
  }
}

/**
 * Reads a `.pxf`: unzips (entry order is irrelevant on read, unknown entries are ignored), parses
 * and migrates the JSON forward to the current schema version, validates `manifest.json` and
 * `document.json` with the schema, and decodes every `images/<id>.png` (8-bit grayscale becomes an
 * `IndexedImage`, anything else a `TiledImage`). Everything {@link writePxf} writes reads back.
 *
 * The render cache is read when present: `render/index.json` is validated, but a cache that fails
 * validation is dropped with a warning instead of failing the open (it is derived data).
 * A migrated file has no render cache.
 *
 * @throws IoError `BAD_PXF` (not a ZIP, missing manifest/document, unsafe or malformed entry, missing
 *   image), `INVALID_DOCUMENT` (schema errors), `UNSUPPORTED_VERSION` (written by a newer build),
 *   `MIGRATION_MISSING` / `MIGRATION_FAILED`.
 */
export function readPxf(bytes: Uint8Array, options: ReadPxfOptions = {}): PxfFile {
  const entries = readZip(bytes);
  const need = (path: string): Uint8Array => {
    const b = entries.get(path);
    if (b === undefined) throw new IoError('BAD_PXF', `missing ${path}`);
    return b;
  };
  const rawManifest = parseJsonBytes(need('manifest.json'), 'manifest.json');
  const rawDocument = parseJsonBytes(need('document.json'), 'document.json');
  if (!isRecord(rawManifest) || !isRecord(rawDocument)) {
    throw new IoError('BAD_PXF', 'manifest.json and document.json must be JSON objects');
  }
  const { json, migrated } = migrate(
    { manifest: rawManifest, document: rawDocument },
    options.migrations ?? MIGRATIONS,
    options.targetVersion,
  );
  const manifest = parseWith(Manifest, json.manifest, 'manifest.json');
  const doc = parseWith(Document, json.document, 'document.json');

  const transparent = transparentIndexOf(doc);
  const images = new Map<ImageId, StoredImage>();
  const imagePngs = new Map<ImageId, Uint8Array>();
  const renderPngs = new Map<string, Uint8Array>();
  const warnings: string[] = [];
  let indexBytes: Uint8Array | undefined;
  for (const path of [...entries.keys()].sort()) {
    const data = need(path);
    if (path.startsWith('images/')) {
      const m = /^images\/([^/]+)\.png$/.exec(path);
      const id = ImageId.safeParse(m?.[1]);
      if (!id.success) throw new IoError('BAD_PXF', `unexpected entry '${path}'`);
      images.set(id.data, decodeImage(id.data, data, transparent));
      imagePngs.set(id.data, data);
    } else if (path === 'render/index.json') {
      indexBytes = data;
    } else if (path.startsWith('render/')) {
      renderPngs.set(path.slice('render/'.length), data);
    }
  }
  for (const id of [...referencedImages(doc)].sort()) {
    if (!images.has(id)) throw new IoError('BAD_PXF', `missing images/${id}.png`);
  }

  let renderIndex: RenderIndex | undefined;
  if (migrated) {
    if (indexBytes !== undefined) warnings.push('render cache dropped: the file was migrated');
  } else if (indexBytes !== undefined) {
    try {
      const r = RenderIndex.safeParse(parseJsonBytes(indexBytes, 'render/index.json'));
      if (r.success) renderIndex = r.data;
      else
        warnings.push(
          `render cache dropped: invalid render/index.json: ${describeIssues(r.error)}`,
        );
    } catch (e) {
      warnings.push(`render cache dropped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (renderIndex === undefined) renderPngs.clear();
  return {
    manifest,
    doc,
    images,
    imagePngs,
    ...(renderIndex === undefined ? {} : { renderIndex }),
    renderPngs,
    warnings,
  };
}
