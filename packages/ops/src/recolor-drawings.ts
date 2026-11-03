/**
 * Walks the drawings of a document and rewrites the ones a colour change touches (`palette.remap`).
 * The pure mapping lives in `@pixel-forge/color` (`palette-map.ts`); this file only finds drawings,
 * stores the new images and points the cels at them.
 * @packageDocumentation
 */
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import type { StoredImage, Transaction } from '@pixel-forge/core';
import type { Document, FrameId, ImageId, LayerId } from '@pixel-forge/schema';
import { animationLabel, partNamer, walkLayers } from './refs.js';
import type { ReadonlyDocument } from './refs.js';

/**
 * Which drawings an edit may touch. With neither field, every drawing: cels, rig part variants and
 * override `set` images. With a field, only the **cels** that match (a cel that links to another
 * frame's cel follows its source, so it is never matched itself).
 */
export interface DrawingScope {
  /** Only the cels of this pixel layer. */
  readonly layerId?: LayerId;
  /** Only the cels of these frames. */
  readonly frameIds?: ReadonlySet<FrameId>;
}

/** One drawing in scope. */
export interface DrawingTarget {
  readonly imageId: ImageId;
  /** Where it is used, for messages: `layer @ frame`, `part variant`, `animation override`. */
  readonly where: string;
}

const isWhole = (scope: DrawingScope): boolean =>
  scope.layerId === undefined && scope.frameIds === undefined;

const celSelected = (scope: DrawingScope, layerId: LayerId, frameId: FrameId): boolean =>
  (scope.layerId === undefined || scope.layerId === layerId) &&
  (scope.frameIds === undefined || scope.frameIds.has(frameId));

/** Every drawing in scope, in document order. A drawing used twice appears twice. */
export function drawingTargets(doc: ReadonlyDocument, scope: DrawingScope): DrawingTarget[] {
  const out: DrawingTarget[] = [];
  for (const { layer, path } of walkLayers(doc)) {
    if (layer.kind !== 'pixel' && layer.kind !== 'reference') continue;
    for (const [frameId, cel] of Object.entries(layer.cels)) {
      if ('imageId' in cel && celSelected(scope, layer.id, frameId as FrameId)) {
        out.push({ imageId: cel.imageId, where: `${path} @ ${frameId}` });
      }
    }
  }
  if (isWhole(scope)) {
    const nameOf = partNamer(doc);
    for (const part of doc.rig?.parts ?? []) {
      for (const v of part.variants) {
        out.push({ imageId: v.imageId, where: `${nameOf(part)} variant ${v.name}` });
      }
    }
    for (const a of doc.animations) {
      for (const o of a.overrides) {
        if (o.set !== undefined) {
          out.push({ imageId: o.set, where: `${animationLabel(a)} override` });
        }
      }
    }
  }
  return out;
}

/** What a {@link RecolorFn} says about one image. */
export interface Recolored {
  /** Pixels that changed (or would change). */
  readonly changed: number;
  /** The new image; leave out to only count (the image is not replaced). */
  readonly image?: StoredImage;
}

/** Computes the new version of one stored image; must not mutate it. */
export type RecolorFn = (image: StoredImage) => Recolored;

/** Result of {@link recolorDrawings}. */
export interface RecolorResult {
  /** One entry per distinct drawing that changed, in image id order. */
  drawings: { where: string; changed: number }[];
  /** Pixels changed in all drawings. */
  readonly changed: number;
  /** Drawings in scope (changed or not). */
  readonly scanned: number;
}

/**
 * Applies `fn` to every distinct drawing in scope. A drawing that changes is stored as a new image
 * and the in-scope cels, variants and overrides that used it point at the new one; the old image is
 * deleted when nothing uses it any more (a drawing shared with an out-of-scope cel stays for that cel).
 * Writes nothing when nothing changes.
 */
export function recolorDrawings(
  tx: Transaction,
  scope: DrawingScope,
  fn: RecolorFn,
): RecolorResult {
  const targets = drawingTargets(tx.doc, scope);
  const byImage = new Map<ImageId, string[]>();
  for (const t of targets) byImage.set(t.imageId, [...(byImage.get(t.imageId) ?? []), t.where]);
  const fresh = new Map<ImageId, ImageId>();
  const drawings: { where: string; changed: number }[] = [];
  let changed = 0;
  for (const id of [...byImage.keys()].sort()) {
    const img = tx.image(id);
    if (img === undefined) continue;
    const r = fn(img);
    if (r.changed === 0) continue;
    if (r.image !== undefined) fresh.set(id, tx.createImage(r.image));
    const where = byImage.get(id) ?? [];
    drawings.push({
      where:
        where.length > 3
          ? `${where.slice(0, 3).join(', ')} +${String(where.length - 3)}`
          : where.join(', '),
      changed: r.changed,
    });
    changed += r.changed;
  }
  if (fresh.size > 0) {
    tx.update((d) => {
      repoint(d, scope, fresh);
    });
    const still = new Set(drawingTargets(tx.doc, {}).map((t) => t.imageId));
    for (const old of fresh.keys()) if (!still.has(old)) tx.deleteImage(old);
  }
  return { drawings, changed, scanned: byImage.size };
}

/** Points the in-scope users of a replaced drawing at its new image (inside `tx.update`). */
function repoint(d: Document, scope: DrawingScope, fresh: ReadonlyMap<ImageId, ImageId>): void {
  const swap = (id: ImageId): ImageId => fresh.get(id) ?? id;
  const visit = (layers: Document['layers']): void => {
    for (const l of layers) {
      if (l.kind === 'group') visit(l.children);
      else if (l.kind === 'pixel' || l.kind === 'reference') {
        for (const [frameId, c] of Object.entries(l.cels)) {
          if ('imageId' in c && celSelected(scope, l.id, frameId as FrameId)) {
            c.imageId = swap(c.imageId);
          }
        }
      }
    }
  };
  visit(d.layers);
  if (!isWhole(scope)) return;
  for (const p of d.rig?.parts ?? []) for (const v of p.variants) v.imageId = swap(v.imageId);
  for (const a of d.animations) {
    for (const o of a.overrides) if (o.set !== undefined) o.set = swap(o.set);
  }
}

/** Builds the {@link RecolorFn} of an index table: indexed images only. */
export function indexRecolor(
  apply: (indices: Uint8Array, transparent: number) => number,
): RecolorFn {
  return (img) => {
    if (!(img instanceof IndexedImage)) return { changed: 0 };
    const idx = img.toIndices();
    const changed = apply(idx, img.transparentIndex);
    if (changed === 0) return { changed };
    return {
      changed,
      image: IndexedImage.fromIndices(img.width, img.height, idx, img.transparentIndex),
    };
  };
}

/** Builds the {@link RecolorFn} of a colour table: RGBA images only. */
export function colorRecolor(apply: (rgba: Uint8Array) => number): RecolorFn {
  return (img) => {
    if (!(img instanceof TiledImage)) return { changed: 0 };
    const { width, height, data } = img.toRGBA();
    const changed = apply(data);
    if (changed === 0) return { changed };
    return { changed, image: TiledImage.fromRGBA({ width, height, data }) };
  };
}
