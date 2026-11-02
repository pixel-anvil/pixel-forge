/**
 * References of the op API (spec 6.3) and their resolution against a document. Inputs name
 * things the way an LLM or a user does (an animation by `{group, direction}`, a frame by index, a
 * bone or part by name); handlers resolve them to ids here, at the boundary, and never look
 * entities up by hand.
 *
 * Rules shared by every string reference (layer, bone, part, view, variant): an **id match wins**,
 * otherwise the **name** is matched; no match is `NOT_FOUND` with the available names, several
 * matches are `AMBIGUOUS` with the candidate ids.
 * @packageDocumentation
 */
import type { DeepReadonly } from '@pixel-forge/core';
import { AnimRef as SchemaAnimRef, DocId, FrameRef as SchemaFrameRef } from '@pixel-forge/schema';
import type {
  Animation,
  AuthoredAnimation,
  Bone,
  Document,
  Frame,
  Layer,
  Part,
  PartLayer,
  Rig,
  Variant,
  View,
} from '@pixel-forge/schema';
import { z } from 'zod';
import { OpError } from './errors.js';

/** A read-only document as ops see it (`ctx.view.doc`). */
export type ReadonlyDocument = DeepReadonly<Document>;

/** Most names listed in a `NOT_FOUND` error's `details.available`. */
export const MAX_AVAILABLE = 50;

/** The `doc` input field: the id `doc.open` / `doc.create` returned. */
export const DocRef = DocId.describe('Document id from doc_open or doc_create.');

/** An animation: `{group, direction?}` (a missing direction means the undirected one) or `{id}`. */
export const AnimRef = SchemaAnimRef.describe(
  'Animation: {"group": "run", "direction": "side"} ({"group": "idle"} for an undirected one) or {"id": "anm_..."}.',
);

/** An animation reference (parsed). */
export type AnimRef = z.output<typeof AnimRef>;

/** A frame of an animation: a 0-based index or a frame id. */
export const FrameRef = SchemaFrameRef.describe('Frame: 0-based index or frame id ("frm_...").');
/** A frame reference (parsed). */
export type FrameRef = z.output<typeof FrameRef>;

/** A layer by id or name (a name must be unique in the tree). */
export const LayerRef = z.string().min(1).describe('Layer id ("lay_...") or layer name.');

/** A bone by id or name. */
export const BoneRef = z
  .string()
  .min(1)
  .describe('Bone name (e.g. "upper_arm_r") or id ("bon_...").');

/** A part by part id, part-layer id or part-layer name (part-layer names are unique). */
export const PartRef = z
  .string()
  .min(1)
  .describe('Part: its part-layer name (e.g. "head"), part id ("prt_...") or layer id.');

/** A rig view by id or name. */
export const ViewRef = z.string().min(1).describe('Rig view name (e.g. "side") or id ("viw_...").');

/** A variant of a part by id or name. */
export const VariantRef = z
  .string()
  .min(1)
  .describe('Variant name (e.g. "default", "sleeve") or id ("var_...").');

const listed = (names: readonly string[]): string[] => names.slice(0, MAX_AVAILABLE);

/** `run/side`, or `idle` for an undirected animation. */
export function animationLabel(anim: {
  readonly group: string;
  readonly direction?: string;
}): string {
  return anim.direction === undefined ? anim.group : `${anim.group}/${anim.direction}`;
}

function notFound(
  kind: string,
  ref: unknown,
  available: readonly string[],
  message?: string,
): OpError {
  return new OpError(
    'NOT_FOUND',
    message ??
      `no ${kind} ${JSON.stringify(ref)}` +
        (available.length === 0 ? '' : `; available: ${listed(available).join(', ')}`),
    { kind, ref: ref as never, available: listed(available) },
  );
}

/**
 * Picks the single entity whose id is `ref`, else whose name is `ref`.
 * @throws OpError `NOT_FOUND` / `AMBIGUOUS`.
 */
function pick<T extends { readonly id: string }>(
  kind: string,
  ref: string,
  items: readonly T[],
  name: (item: T) => string,
): T {
  const byId = items.find((i) => i.id === ref);
  if (byId !== undefined) return byId;
  const matches = items.filter((i) => name(i) === ref);
  const only = matches[0];
  if (only !== undefined && matches.length === 1) return only;
  if (matches.length > 1) {
    throw new OpError(
      'AMBIGUOUS',
      `${String(matches.length)} ${kind}s are named "${ref}"; pass an id instead`,
      { kind, ref, candidates: matches.map((m) => m.id) },
    );
  }
  throw notFound(kind, ref, [...new Set(items.map(name))]);
}

/** A resolved animation: its index in `doc.animations` and the node. */
export interface ResolvedAnimation {
  readonly index: number;
  readonly animation: DeepReadonly<Animation>;
}

/**
 * Resolves an {@link AnimRef}.
 * @throws OpError `NOT_FOUND` (`kind: 'animation'`, `available`: `group/direction` labels).
 */
export function resolveAnimation(doc: ReadonlyDocument, ref: AnimRef): ResolvedAnimation {
  const index =
    'id' in ref
      ? doc.animations.findIndex((a) => a.id === ref.id)
      : doc.animations.findIndex((a) => a.group === ref.group && a.direction === ref.direction);
  const animation = doc.animations[index];
  if (animation === undefined) {
    throw notFound('animation', ref, doc.animations.map(animationLabel), undefined);
  }
  return { index, animation };
}

/** A resolved authored (non-mirror) animation. */
export interface ResolvedAuthored {
  readonly index: number;
  readonly animation: DeepReadonly<AuthoredAnimation>;
}

/**
 * Resolves an {@link AnimRef} that must own frames.
 * @throws OpError `NOT_FOUND`, or `REFUSED` (`reason: 'mirror-animation'`, `mirrorOf`: the source's
 *   label) for a mirror: edit its source instead.
 */
export function resolveAuthoredAnimation(doc: ReadonlyDocument, ref: AnimRef): ResolvedAuthored {
  const { index, animation } = resolveAnimation(doc, ref);
  if ('mirrorOf' in animation) {
    const source = doc.animations.find((a) => a.id === animation.mirrorOf);
    const mirrorOf = source === undefined ? animation.mirrorOf : animationLabel(source);
    throw new OpError(
      'REFUSED',
      `${animationLabel(animation)} is a mirror of ${mirrorOf} and has no frames of its own; edit ${mirrorOf}`,
      { reason: 'mirror-animation', animation: animation.id, mirrorOf },
    );
  }
  return { index, animation };
}

/** A resolved frame: its index in the animation and the node. */
export interface ResolvedFrame {
  readonly index: number;
  readonly frame: DeepReadonly<Frame>;
}

/**
 * Resolves a {@link FrameRef} in an authored animation.
 * @throws OpError `NOT_FOUND` (`kind: 'frame'`, `details.count`: the number of frames).
 */
export function resolveFrame(
  animation: DeepReadonly<AuthoredAnimation>,
  ref: FrameRef,
): ResolvedFrame {
  const index = typeof ref === 'number' ? ref : animation.frames.findIndex((f) => f.id === ref);
  const frame = animation.frames[index];
  if (frame === undefined) {
    const count = animation.frames.length;
    throw new OpError(
      'NOT_FOUND',
      `no frame ${JSON.stringify(ref)} in ${animationLabel(animation)}: it has ${String(count)} frame${count === 1 ? '' : 's'} (indices 0..${String(count - 1)})`,
      { kind: 'frame', ref, count },
    );
  }
  return { index, frame };
}

/** A layer and its position: the chain of names from the root (`body/arm`). */
export interface ResolvedLayer {
  readonly layer: DeepReadonly<Layer>;
  /** Names from the root to the layer, joined by `/`. */
  readonly path: string;
}

/** Every layer of the tree, depth first, bottom to top, with its name path. */
export function walkLayers(doc: ReadonlyDocument): ResolvedLayer[] {
  const out: ResolvedLayer[] = [];
  const visit = (layers: readonly DeepReadonly<Layer>[], prefix: string): void => {
    for (const layer of layers) {
      const path = prefix === '' ? layer.name : `${prefix}/${layer.name}`;
      out.push({ layer, path });
      if (layer.kind === 'group') visit(layer.children, path);
    }
  };
  visit(doc.layers, '');
  return out;
}

/**
 * Resolves a {@link LayerRef}: an id, else a name (or a `group/name` path) matching exactly one layer.
 * @throws OpError `NOT_FOUND` / `AMBIGUOUS` (`candidates`: layer ids).
 */
export function resolveLayer(doc: ReadonlyDocument, ref: string): ResolvedLayer {
  const all = walkLayers(doc);
  const byId = all.find((l) => l.layer.id === ref);
  if (byId !== undefined) return byId;
  const matches = all.filter((l) => l.layer.name === ref || l.path === ref);
  const only = matches[0];
  if (only !== undefined && matches.length === 1) return only;
  if (matches.length > 1) {
    throw new OpError(
      'AMBIGUOUS',
      `${String(matches.length)} layers are named "${ref}" (${matches.map((m) => m.path).join(', ')}); pass an id or a path`,
      { kind: 'layer', ref, candidates: matches.map((m) => m.layer.id) },
    );
  }
  throw notFound(
    'layer',
    ref,
    all.map((l) => l.path),
  );
}

/**
 * The document's rig.
 * @throws OpError `REFUSED` (`reason: 'no-rig'`) when the document has none.
 */
export function requireRig(doc: ReadonlyDocument): DeepReadonly<Rig> {
  if (doc.rig === undefined) {
    throw new OpError(
      'REFUSED',
      'the document has no rig; apply a skeleton template first (rig_apply_template)',
      { reason: 'no-rig' },
    );
  }
  return doc.rig;
}

/**
 * Resolves a {@link BoneRef}.
 * @throws OpError `REFUSED` (`no-rig`), `NOT_FOUND`, `AMBIGUOUS`.
 */
export function resolveBone(doc: ReadonlyDocument, ref: string): DeepReadonly<Bone> {
  return pick('bone', ref, requireRig(doc).bones, (b) => b.name);
}

/** The name of a part: the name of its part layer (unique document-wide, I7). */
export function partName(doc: ReadonlyDocument, part: DeepReadonly<Part>): string {
  const found = walkLayers(doc).find((l) => l.layer.id === part.layerId);
  return found?.layer.name ?? part.id;
}

/**
 * {@link partName} for many parts: one walk of the layers, then O(1) per part. Returns the name of
 * a part (its part layer's name, else its id).
 */
export function partNamer(doc: ReadonlyDocument): (part: DeepReadonly<Part>) => string {
  const names = new Map<string, string>();
  for (const { layer } of walkLayers(doc)) names.set(layer.id, layer.name);
  return (part) => names.get(part.layerId) ?? part.id;
}

/** A resolved part with its part layer. */
export interface ResolvedPart {
  readonly part: DeepReadonly<Part>;
  /** The part layer, or `undefined` when the document is broken (I1). */
  readonly layer: DeepReadonly<PartLayer> | undefined;
  /** The part's name ({@link partName}). */
  readonly name: string;
}

/**
 * Resolves a {@link PartRef}: a part id, a part-layer id, else a part-layer name.
 * @throws OpError `REFUSED` (`no-rig`), `NOT_FOUND`, `AMBIGUOUS`.
 */
export function resolvePart(doc: ReadonlyDocument, ref: string): ResolvedPart {
  return partResolver(doc)(ref);
}

/**
 * {@link resolvePart} for many refs: the layers are walked once, then each ref costs O(parts).
 * @throws OpError `REFUSED` (`no-rig`) when the document has no rig (at creation).
 */
export function partResolver(doc: ReadonlyDocument): (ref: string) => ResolvedPart {
  const rig = requireRig(doc);
  const layers = new Map<string, DeepReadonly<PartLayer>>();
  for (const { layer } of walkLayers(doc)) if (layer.kind === 'part') layers.set(layer.id, layer);
  const entries = rig.parts.map((part) => {
    const layer = layers.get(part.layerId);
    return { id: part.id, layerId: part.layerId, part, layer, name: layer?.name ?? part.id };
  });
  return (ref) => {
    const byLayer = entries.find((e) => e.layerId === ref);
    const entry = byLayer ?? pick('part', ref, entries, (e) => e.name);
    return { part: entry.part, layer: entry.layer, name: entry.name };
  };
}

/**
 * Resolves a {@link ViewRef}.
 * @throws OpError `REFUSED` (`no-rig`), `NOT_FOUND`, `AMBIGUOUS`.
 */
export function resolveView(doc: ReadonlyDocument, ref: string): DeepReadonly<View> {
  return pick('view', ref, requireRig(doc).views, (v) => v.name);
}

/**
 * The rig view an animation is drawn in (`views[0]` for an undirected animation, else the first
 * view drawing its direction; ADR-011).
 * @throws OpError `REFUSED` (`no-rig`), `NOT_FOUND` (`kind: 'view'`) when no view draws it.
 */
export function viewForAnimation(
  doc: ReadonlyDocument,
  animation: { readonly direction?: string },
): DeepReadonly<View> {
  const rig = requireRig(doc);
  const { direction } = animation;
  const view =
    direction === undefined
      ? rig.views[0]
      : rig.views.find((v) => v.directions.includes(direction));
  if (view === undefined) {
    throw notFound(
      'view',
      direction ?? null,
      rig.views.map((v) => `${v.name} (${v.directions.join(', ')})`),
      direction === undefined
        ? 'the rig has no views'
        : `no rig view draws direction "${direction}"`,
    );
  }
  return view;
}

/**
 * Resolves a {@link VariantRef} of a part: a variant id, else a name. Variant names repeat across
 * views (`default` in each), so with `viewId` the name is looked up **only** among the variants of
 * that view (a name that exists only in another view is `NOT_FOUND`, `available` listing this
 * view's variants). Without `viewId` every variant of the part is a candidate.
 * @throws OpError `NOT_FOUND` / `AMBIGUOUS`.
 */
export function resolveVariant(
  part: DeepReadonly<Part>,
  ref: string,
  viewId?: string,
): DeepReadonly<Variant> {
  const byId = part.variants.find((v) => v.id === ref);
  if (byId !== undefined) return byId;
  const candidates =
    viewId === undefined ? part.variants : part.variants.filter((v) => v.viewId === viewId);
  return pick('variant', ref, candidates, (v) => v.name);
}
