/**
 * `writePxf`: a document (store or snapshot) to the bytes of a `.pxf` file (spec 7, NFR-03, FR-DOC-01).
 * @packageDocumentation
 */
import { documentHash, imageHash } from '@pixel-forge/core';
import type { DocumentView, RigRenderer, StoredImage } from '@pixel-forge/core';
import { encodePng } from '@pixel-forge/png';
import { IndexedImage } from '@pixel-forge/raster';
import { Manifest, PXF_FORMAT, SCHEMA_VERSION } from '@pixel-forge/schema';
import type { ImageId } from '@pixel-forge/schema';
import type { Clock } from '../fs.js';
import { PXF_APP, pxfContentHash } from './file.js';
import type { PxfFile } from './file.js';
import { canonicalBytes } from './json.js';
import { buildRenderCache } from './render-cache.js';
import { buildZip } from './zip.js';
import type { ZipEntry } from './zip.js';

/** Options of {@link writePxf} and {@link buildPxf}. */
export interface WritePxfOptions {
  /** Source of `created` / `modified` (never `Date.now`). Read at most once per call. */
  readonly clock: Clock;
  /**
   * Write the render cache (`render/`). Default true; `false` for scratch files (the file is then
   * not playable by the Godot importer).
   */
  readonly renderCache?: boolean;
  /** Document skin names to render besides `base`. Default: all of the document's skins. */
  readonly skins?: readonly string[];
  /**
   * The file as it was opened or last written. It decides `created` (kept), `modified` (kept when
   * the document and images are unchanged, i.e. equal `documentHash`) and which render PNGs and
   * image PNGs are reused.
   */
  readonly previous?: PxfFile;
  /** The part renderer (T3.3); required for the render cache when part layers are drawn. */
  readonly rig?: RigRenderer;
  /** `manifest.json` `app`; default `pixel-forge <version>`. */
  readonly app?: string;
}

/** What {@link buildPxf} returns. */
export interface BuiltPxf {
  /** The `.pxf` bytes. */
  readonly bytes: Uint8Array;
  /** The same content in memory: pass it as `previous` of the next save. */
  readonly file: PxfFile;
  /** Whether the document or images differ from `previous` (always true without `previous`). */
  readonly changed: boolean;
  /** Frames rendered in this save (render cache only). */
  readonly renderedFrames: number;
  /** Frames whose PNGs were reused from `previous`. */
  readonly reusedFrames: number;
}

/** UTC ISO 8601 with `Z`, whole seconds (clarification 10; the ZIP stores 2 s anyway). */
function isoSeconds(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new RangeError('Clock returned an invalid date');
  return `${d.toISOString().slice(0, 19)}Z`;
}

function encodeImage(img: StoredImage): Uint8Array {
  if (img instanceof IndexedImage) {
    return encodePng({
      width: img.width,
      height: img.height,
      data: img.toIndices(),
      kind: 'gray8',
    });
  }
  return encodePng({ ...img.toRGBA(), kind: 'rgba' });
}

/** Same kind and same pixels (and so the same PNG bytes) as `prev`. */
function sameImage(prev: StoredImage | undefined, img: StoredImage): boolean {
  if (prev === undefined) return false;
  if (prev === img) return true;
  return (
    prev instanceof IndexedImage === img instanceof IndexedImage &&
    imageHash(prev) === imageHash(img)
  );
}

/**
 * Like {@link writePxf}, but also returns the in-memory {@link PxfFile} of what was written, so the
 * next save can pass it as `previous` without parsing the bytes again.
 *
 * Contents and order: `manifest.json`, `document.json`, `images/<id>.png` (sorted; every image the
 * view holds), `render/index.json` and `render/<skin>/<group>/<direction>/<n>.png` (when
 * `renderCache` is not false). JSON is canonical (see `canonicalPretty`); images are RGBA PNGs
 * (`TiledImage`) or 8-bit grayscale PNGs of the palette indices (`IndexedImage`), both from the
 * deterministic `png` encoder. ZIP details: see `buildZip`.
 *
 * `created` is set once (the clock on the first save, then the one in `previous`). `modified` is the
 * clock when the content changed against `previous` (or there is none), else `previous`'s value, so
 * a no-op save of an opened file is byte-identical to it.
 *
 * Pass a store, a snapshot or an open-transaction view that is not being edited while this runs; the
 * returned `file` shares the view's (immutable) document and images.
 *
 * @throws IoError `RIG_REQUIRED`, `BAD_INPUT` (see `buildRenderCache`); `CoreError` from rendering.
 */
export function buildPxf(view: DocumentView, options: WritePxfOptions): BuiltPxf {
  const { previous } = options;
  const changed = previous === undefined || pxfContentHash(previous) !== documentHash(view);
  const now = (): string => isoSeconds(options.clock.now());
  let created: string;
  let modified: string;
  if (previous === undefined) {
    created = modified = now();
  } else {
    created = previous.manifest.created;
    modified = changed ? now() : previous.manifest.modified;
  }
  const manifest = Manifest.parse({
    format: PXF_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    app: options.app ?? PXF_APP,
    created,
    modified,
  });

  const images = new Map<ImageId, StoredImage>();
  const imagePngs = new Map<ImageId, Uint8Array>();
  for (const id of view.imageIds()) {
    const img = view.image(id);
    if (img === undefined) continue;
    images.set(id, img);
    const old = previous?.imagePngs.get(id);
    imagePngs.set(
      id,
      old !== undefined && sameImage(previous?.images.get(id), img) ? old : encodeImage(img),
    );
  }

  const entries: ZipEntry[] = [
    { path: 'manifest.json', data: canonicalBytes(manifest) },
    { path: 'document.json', data: canonicalBytes(view.doc) },
  ];
  for (const [id, data] of imagePngs) entries.push({ path: `images/${id}.png`, data });

  let renderIndex: PxfFile['renderIndex'];
  let renderPngs = new Map<string, Uint8Array>();
  let renderedFrames = 0;
  let reusedFrames = 0;
  if (options.renderCache !== false) {
    const cache = buildRenderCache(view, {
      ...(options.skins === undefined ? {} : { skins: options.skins }),
      ...(options.rig === undefined ? {} : { rig: options.rig }),
      ...(previous === undefined ? {} : { previous }),
    });
    renderIndex = cache.index;
    renderPngs = cache.pngs;
    renderedFrames = cache.rendered;
    reusedFrames = cache.reused;
    entries.push({ path: 'render/index.json', data: canonicalBytes(cache.index) });
    for (const [path, data] of renderPngs) entries.push({ path: `render/${path}`, data });
  }

  const file: PxfFile = {
    manifest,
    doc: view.doc,
    images,
    imagePngs,
    ...(renderIndex === undefined ? {} : { renderIndex }),
    renderPngs,
    warnings: [],
  };
  return {
    bytes: buildZip(entries, modified),
    file,
    changed,
    renderedFrames,
    reusedFrames,
  };
}

/**
 * Serialises a document to `.pxf` bytes. See {@link buildPxf} for the contents, the determinism rules
 * and the `previous` / `modified` semantics. Pure: the same view, options and clock reading always
 * give the same bytes.
 */
export function writePxf(view: DocumentView, options: WritePxfOptions): Uint8Array {
  return buildPxf(view, options).bytes;
}
