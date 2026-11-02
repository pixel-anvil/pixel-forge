/**
 * Frame-list operations (spec 3.2): insert, duplicate, delete and reorder frames of an authored
 * animation. Each operation takes the open {@link Transaction} (`docs/ai/PLAYBOOKS.md`, "How mutations
 * work"), validates its inputs before changing anything, and never begins or commits.
 * @packageDocumentation
 */
import type {
  AnimRef,
  AuthoredAnimation,
  Document,
  Frame,
  FrameId,
  FrameRef,
  ImageId,
  Layer,
  Override,
  PixelLayer,
  ReferenceLayer,
} from '@pixel-forge/schema';
import { CoreError } from './errors.js';
import type { DeepReadonly } from './json.js';
import type { Transaction } from './transaction.js';

/**
 * Why a frame operation was refused. Carried in `CoreError.details.reason` of a `BAD_ARGUMENT`
 * error (the error code union stays unchanged).
 *
 * - `unknown-animation`: the {@link AnimRef} matches no animation.
 * - `unknown-frame`: the {@link FrameRef} is not a frame of that animation (bad index or id).
 * - `mirror-animation`: the animation is a mirror and has no frames of its own.
 * - `last-frame`: deleting the only frame (an animation keeps at least one).
 * - `bad-order`: `reorderFrames` got something other than a permutation of the frame ids.
 * - `bad-duration`: `durationMs` is not an integer >= 1.
 */
export type FrameOpReason =
  | 'unknown-animation'
  | 'unknown-frame'
  | 'mirror-animation'
  | 'last-frame'
  | 'bad-order'
  | 'bad-duration';

function refuse(reason: FrameOpReason, message: string): CoreError {
  return new CoreError('BAD_ARGUMENT', message, { reason });
}

/** Options of {@link insertFrame}. */
export interface InsertFrameOptions {
  /** Insert before or after the reference frame. */
  readonly position: 'before' | 'after';
  /** Duration of the new frame; default: the reference frame's duration. Integer >= 1. */
  readonly durationMs?: number;
}

type ReadonlyDoc = DeepReadonly<Document>;
type ReadonlyAuthored = DeepReadonly<AuthoredAnimation>;

/**
 * Index in `doc.animations` of the animation `ref` names (`{id}` or `{group, direction?}`).
 * @throws CoreError `BAD_ARGUMENT` (`reason: 'unknown-animation'`).
 */
export function resolveAnimation(doc: ReadonlyDoc, ref: AnimRef): number {
  const i =
    'id' in ref
      ? doc.animations.findIndex((a) => a.id === ref.id)
      : doc.animations.findIndex((a) => a.group === ref.group && a.direction === ref.direction);
  if (i < 0) throw refuse('unknown-animation', `no animation matches ${JSON.stringify(ref)}`);
  return i;
}

function resolveAuthored(
  doc: ReadonlyDoc,
  ref: AnimRef,
): { index: number; anim: ReadonlyAuthored } {
  const index = resolveAnimation(doc, ref);
  const anim = nth(doc.animations, index);
  if ('mirrorOf' in anim) {
    throw refuse('mirror-animation', `animation ${anim.id} is a mirror and has no frames`);
  }
  return { index, anim };
}

/**
 * Index within `anim.frames` of the frame `ref` names (a 0-based index or a {@link FrameId}).
 * @throws CoreError `BAD_ARGUMENT` (`reason: 'unknown-frame'`).
 */
export function resolveFrame(
  anim: { readonly frames: readonly { readonly id: FrameId }[] },
  ref: FrameRef,
): number {
  const i =
    typeof ref === 'number'
      ? Number.isInteger(ref) && ref >= 0 && ref < anim.frames.length
        ? ref
        : -1
      : anim.frames.findIndex((f) => f.id === ref);
  if (i < 0) throw refuse('unknown-frame', `no frame ${String(ref)} in this animation`);
  return i;
}

function nth<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`index ${String(i)} out of range`);
  return v;
}

function mustGet<K, V>(m: ReadonlyMap<K, V>, k: K): V {
  const v = m.get(k);
  if (v === undefined) throw new Error('missing map entry');
  return v;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

type CelLayer = PixelLayer | ReferenceLayer;

/** Pixel and reference layers of a (draft) layer tree, depth first. */
function celLayers(layers: Layer[], out: CelLayer[] = []): CelLayer[] {
  for (const l of layers) {
    if (l.kind === 'group') celLayers(l.children, out);
    else if (l.kind === 'pixel' || l.kind === 'reference') out.push(l);
  }
  return out;
}

/** Pixel and reference layers of a read-only layer tree, depth first. */
function celLayersRo(
  layers: readonly DeepReadonly<Layer>[],
  out: DeepReadonly<CelLayer>[] = [],
): DeepReadonly<CelLayer>[] {
  for (const l of layers) {
    if (l.kind === 'group') celLayersRo(l.children, out);
    else if (l.kind === 'pixel' || l.kind === 'reference') out.push(l);
  }
  return out;
}

/**
 * Inserts a new empty frame before or after frame `at` of the authored animation `anim` and returns
 * its new id. Spec 3.2: bone keys are not copied (interpolation fills them in); no cels, no overrides.
 * Markers, events and part keys are empty and root motion is zero.
 * @throws CoreError `BAD_ARGUMENT` for an unknown animation or frame, a mirror, or a bad duration.
 */
export function insertFrame(
  tx: Transaction,
  anim: AnimRef,
  at: FrameRef,
  options: InsertFrameOptions,
): FrameId {
  const { index, anim: a } = resolveAuthored(tx.doc, anim);
  const fi = resolveFrame(a, at);
  const ref = nth(a.frames, fi);
  const durationMs = options.durationMs ?? ref.durationMs;
  if (!Number.isInteger(durationMs) || durationMs < 1) {
    throw refuse('bad-duration', 'durationMs must be an integer >= 1');
  }
  const id = tx.newId('frame');
  const frame: Frame = {
    id,
    durationMs,
    markers: {},
    events: [],
    rootMotion: { dx: 0, dy: 0 },
    boneKeys: {},
    partKeys: {},
  };
  tx.update((d) => {
    const an = d.animations[index];
    if (an && 'frames' in an)
      an.frames.splice(options.position === 'before' ? fi : fi + 1, 0, frame);
  });
  return id;
}

/**
 * Duplicates frame `frame` of the authored animation `anim`; the copy is inserted right after the
 * source and gets a new id. Spec 3.2:
 * - cels are **linked** to the source: an image cel becomes `{linkTo: source}`, a link stays a link to
 *   the same target (links resolve in one hop, I3);
 * - bone keys, part keys, markers, events, root motion and duration are copied;
 * - overrides of the frame (in any animation, including a mirror's extra overrides keyed by this
 *   frame) are copied with new override ids and the new frame id. Their `set`/`erase` images are
 *   cloned into new images, so editing one override never changes the other.
 * @throws CoreError `BAD_ARGUMENT` for an unknown animation or frame, or a mirror.
 */
export function duplicateFrame(tx: Transaction, anim: AnimRef, frame: FrameRef): FrameId {
  const { index, anim: a } = resolveAuthored(tx.doc, anim);
  const fi = resolveFrame(a, frame);
  const src = nth(a.frames, fi);
  const newFrameId = tx.newId('frame');

  // Overrides on the source frame, in document order, each with fresh ids and image clones.
  const copies: { animIndex: number; override: Override }[] = [];
  tx.doc.animations.forEach((an, animIndex) => {
    for (const o of an.overrides) {
      if (o.frameId !== src.id) continue;
      const copy = clone(o) as Override;
      copy.id = tx.newId('override');
      copy.frameId = newFrameId;
      if (o.set !== undefined) copy.set = cloneImage(tx, o.set);
      if (o.erase !== undefined) copy.erase = cloneImage(tx, o.erase);
      copies.push({ animIndex, override: copy });
    }
  });

  const newFrame = clone(src) as Frame;
  newFrame.id = newFrameId;
  tx.update((d) => {
    const an = d.animations[index];
    if (an && 'frames' in an) an.frames.splice(fi + 1, 0, newFrame);
    for (const layer of celLayers(d.layers)) {
      const cel = layer.cels[src.id];
      if (cel === undefined) continue;
      layer.cels[newFrameId] = 'linkTo' in cel ? { linkTo: cel.linkTo } : { linkTo: src.id };
    }
    for (const { animIndex, override } of copies) d.animations[animIndex]?.overrides.push(override);
  });
  return newFrameId;
}

function cloneImage(tx: Transaction, id: ImageId): ImageId {
  const img = tx.image(id);
  if (img === undefined) {
    throw new CoreError('IMAGE_MISSING', `override image ${id} is not stored`, { imageId: id });
  }
  return tx.createImage(img);
}

/**
 * Deletes frame `frame` of the authored animation `anim`. Spec 3.2: links pointing at the frame's
 * cels are **materialised** first. For each layer, the first linking cel (document order: layer
 * tree, then the cels record order) receives a clone of the image (same offset and opacity) and the
 * other links of that layer are repointed to it; then the frame, its bone/part keys, cels and
 * overrides (in any animation, mirror extras included) are removed. Images that nothing references
 * any more (the deleted cels' and overrides' images) are deleted from the store.
 * @throws CoreError `BAD_ARGUMENT` for an unknown animation or frame, a mirror, or when `frame` is
 * the animation's only frame (`reason: 'last-frame'`).
 */
export function deleteFrame(tx: Transaction, anim: AnimRef, frame: FrameRef): void {
  const { index, anim: a } = resolveAuthored(tx.doc, anim);
  const fi = resolveFrame(a, frame);
  if (a.frames.length <= 1) {
    throw refuse('last-frame', `cannot delete the only frame of animation ${a.id}`);
  }
  const target = nth(a.frames, fi).id;

  // Plan materialisation per layer (read-only), then create the image clones.
  interface Plan {
    layerId: string;
    owner: FrameId;
    imageId: ImageId;
    offset: { x: number; y: number };
    opacity: number;
    others: FrameId[];
  }
  const plans: Plan[] = [];
  const retarget: { layerId: string; to: FrameId; from: FrameId[] }[] = [];
  for (const layer of celLayersRo(tx.doc.layers)) {
    const own = layer.cels[target];
    const linkers = Object.entries(layer.cels)
      .filter(([, c]) => 'linkTo' in c && c.linkTo === target)
      .map(([k]) => k as FrameId);
    if (linkers.length === 0) continue;
    if (own === undefined) continue; // dangling links: validate() reports them
    if ('linkTo' in own) {
      retarget.push({ layerId: layer.id, to: own.linkTo, from: linkers });
      continue;
    }
    const [owner, ...others] = linkers as [FrameId, ...FrameId[]];
    plans.push({
      layerId: layer.id,
      owner,
      imageId: own.imageId,
      offset: { ...own.offset },
      opacity: own.opacity,
      others,
    });
  }
  const created = plans.map((p) => {
    const img = tx.image(p.imageId);
    if (img === undefined) {
      throw new CoreError('IMAGE_MISSING', `cel image ${p.imageId} is not stored`, {
        imageId: p.imageId,
      });
    }
    return tx.createImage(img);
  });

  // Images that may become unreferenced.
  const candidates = new Set<ImageId>();
  for (const layer of celLayersRo(tx.doc.layers)) {
    const c = layer.cels[target];
    if (c !== undefined && 'imageId' in c) candidates.add(c.imageId);
  }
  for (const an of tx.doc.animations) {
    for (const o of an.overrides) {
      if (o.frameId !== target) continue;
      if (o.set !== undefined) candidates.add(o.set);
      if (o.erase !== undefined) candidates.add(o.erase);
    }
  }

  tx.update((d) => {
    const an = d.animations[index];
    if (an && 'frames' in an) an.frames.splice(fi, 1); // keys travel with the frame object
    const byId = new Map(celLayers(d.layers).map((l) => [l.id as string, l]));
    plans.forEach((p, i) => {
      const layer = byId.get(p.layerId);
      const newImage = created[i];
      if (!layer || newImage === undefined) return;
      layer.cels[p.owner] = { imageId: newImage, offset: p.offset, opacity: p.opacity };
      for (const other of p.others) layer.cels[other] = { linkTo: p.owner };
    });
    for (const r of retarget) {
      const layer = byId.get(r.layerId);
      if (layer) for (const f of r.from) layer.cels[f] = { linkTo: r.to };
    }
    for (const layer of byId.values()) Reflect.deleteProperty(layer.cels, target);
    for (const anim2 of d.animations) {
      anim2.overrides = anim2.overrides.filter((o) => o.frameId !== target);
    }
  });

  // Delete images the removal orphaned.
  const still = referencedImages(tx.doc);
  for (const id of candidates) if (!still.has(id) && tx.image(id) !== undefined) tx.deleteImage(id);
}

/** Every image id referenced by cels, variants and overrides. */
export function referencedImages(doc: ReadonlyDoc): Set<ImageId> {
  const out = new Set<ImageId>();
  for (const layer of celLayersRo(doc.layers)) {
    for (const c of Object.values(layer.cels)) if ('imageId' in c) out.add(c.imageId);
  }
  for (const p of doc.rig?.parts ?? []) for (const v of p.variants) out.add(v.imageId);
  for (const an of doc.animations) {
    for (const o of an.overrides) {
      if (o.set !== undefined) out.add(o.set);
      if (o.erase !== undefined) out.add(o.erase);
    }
  }
  return out;
}

/**
 * Reorders the frames of the authored animation `anim` to `newOrder`, which must be a permutation of
 * its frame ids. Frames move as whole objects, and cels, overrides and links are keyed by frame id,
 * so everything keyed by a frame comes along (spec 3.2).
 * @throws CoreError `BAD_ARGUMENT` (`reason: 'bad-order'`) when `newOrder` is not a permutation.
 */
export function reorderFrames(tx: Transaction, anim: AnimRef, newOrder: readonly FrameId[]): void {
  const { index, anim: a } = resolveAuthored(tx.doc, anim);
  const have = new Set<string>(a.frames.map((f) => f.id));
  const want = new Set<string>(newOrder);
  if (
    newOrder.length !== a.frames.length ||
    want.size !== newOrder.length ||
    [...want].some((id) => !have.has(id))
  ) {
    throw refuse('bad-order', 'newOrder must be a permutation of the animation frame ids');
  }
  const byId = new Map(a.frames.map((f) => [f.id as string, clone(f) as Frame]));
  const frames = newOrder.map((id) => mustGet(byId, id));
  tx.update((d) => {
    const an = d.animations[index];
    if (an && 'frames' in an) an.frames = frames;
  });
}
