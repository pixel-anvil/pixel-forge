/**
 * Rig editing transactions (T3.2, FR-RIG-01…04, FR-RIG-06): bones, views, rest poses, skeleton
 * templates, pivots, and binding pixel layers to parts. Like the frame operations, each function
 * takes the open {@link Transaction}, checks its inputs against the working document before it
 * changes anything, and never begins or commits (`docs/ai/PLAYBOOKS.md`, "How mutations work").
 * The pure geometry (templates, overlap, rest maths) lives in `rig`; this file only edits JSON.
 * @packageDocumentation
 */
import { IndexedImage } from '@pixel-forge/raster';
import {
  DEFAULT_VARIANT_NAME,
  bindByOverlap,
  parsePartLayerName,
  partLayerName,
  snapSkeleton,
} from '@pixel-forge/rig';
import type { OverlapOptions, PartLayerName, PartShape, SkeletonTemplate } from '@pixel-forge/rig';
import { DIRECTION_REGEX, NAME_REGEX } from '@pixel-forge/schema';
import type {
  BoneId,
  Document,
  ImageId,
  Layer,
  LayerId,
  PartId,
  RestTransform,
  VariantId,
  ViewId,
} from '@pixel-forge/schema';
import { CoreError } from './errors.js';
import type { DeepReadonly } from './json.js';
import type { Transaction } from './transaction.js';

/**
 * Why a rig edit was refused: carried in `CoreError.details.reason` of a `BAD_ARGUMENT` error.
 * `unknown-bone | unknown-view | unknown-part | unknown-variant`: the id names nothing;
 * `bad-name`: not a schema `Name` (I7) / direction name; `name-taken`: a bone or view of that name
 * exists; `direction-taken`: another view already draws that direction; `cycle`: reparenting a bone
 * under itself or a descendant; `has-parts`: the bone (or a descendant being deleted) has parts;
 * `has-children`: delete without `cascade`; `has-variants`: the view still holds variants;
 * `bad-value`: a non-integer or non-finite number; `bone-mismatch`: a template bone of that name
 * exists with another parent.
 */
export type RigEditReason =
  | 'unknown-bone'
  | 'unknown-view'
  | 'unknown-part'
  | 'unknown-variant'
  | 'bad-name'
  | 'name-taken'
  | 'direction-taken'
  | 'cycle'
  | 'has-parts'
  | 'has-children'
  | 'has-variants'
  | 'bad-value'
  | 'bone-mismatch';

function refuse(reason: RigEditReason, message: string): CoreError {
  return new CoreError('BAD_ARGUMENT', message, { reason });
}

type Doc = DeepReadonly<Document>;
type RigRo = NonNullable<Doc['rig']>;
type MutRig = NonNullable<Document['rig']>;

const EMPTY_RIG: RigRo = { bones: [], parts: [], views: [] };

/** Unwraps a value the caller has just checked. */
function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('unreachable');
  return v;
}

const rigOf = (doc: Doc): RigRo => doc.rig ?? EMPTY_RIG;

function mutRig(d: Document): MutRig {
  d.rig ??= { bones: [], parts: [], views: [] };
  return d.rig;
}

const checkName = (name: string, what: string): void => {
  if (!NAME_REGEX.test(name)) {
    throw refuse(
      'bad-name',
      `${what} name ${JSON.stringify(name)} does not match the name grammar`,
    );
  }
};
const checkInt = (n: number, what: string): void => {
  if (!Number.isSafeInteger(n))
    throw refuse('bad-value', `${what} must be an integer, got ${String(n)}`);
};

function mustBone(rig: RigRo, id: BoneId) {
  const b = rig.bones.find((x) => x.id === id);
  if (b === undefined) throw refuse('unknown-bone', `no bone ${id}`);
  return b;
}
function mustView(rig: RigRo, id: ViewId) {
  const v = rig.views.find((x) => x.id === id);
  if (v === undefined) throw refuse('unknown-view', `no view ${id}`);
  return v;
}

/** Ids of `bone` and all its descendants. */
function subtree(rig: RigRo, bone: BoneId): Set<BoneId> {
  const out = new Set<BoneId>([bone]);
  for (let grew = true; grew;) {
    grew = false;
    for (const b of rig.bones) {
      if (b.parentId !== undefined && out.has(b.parentId) && !out.has(b.id)) {
        out.add(b.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Sum of rest angles from the bone up to its root: the world direction at rest, in degrees. */
function worldRest(
  rig: RigRo,
  rest: Readonly<Partial<Record<BoneId, Readonly<RestTransform>>>>,
  bone: BoneId,
): number {
  let sum = 0;
  for (let b = rig.bones.find((x) => x.id === bone); b !== undefined;) {
    sum += rest[b.id]?.angle ?? 0;
    const parent: BoneId | undefined = b.parentId;
    b = parent === undefined ? undefined : rig.bones.find((x) => x.id === parent);
  }
  return sum;
}

const clean = (n: number): number => Number(n.toFixed(9));

// ---- bones ----------------------------------------------------------------------------------------

/** Rest pose given to a new bone in one view (see {@link RestTransform}). */
export interface BoneRest extends RestTransform {
  readonly viewId: ViewId;
}

/**
 * Adds a bone. `name` must be a unique schema name; `parentId` (missing: a root) must exist;
 * `length` is an integer >= 0. With `rest` the bone also appears in that view (a root's `x, y` is its
 * canvas pivot, a child's the canvas offset from the parent pivot, ADR-012); without it the bone is
 * unused in every view until {@link setRestPose}.
 * @returns the new bone's id.
 */
export function addBone(
  tx: Transaction,
  bone: { readonly name: string; readonly parentId?: BoneId; readonly length: number },
  rest?: BoneRest,
): BoneId {
  const rig = rigOf(tx.doc);
  checkName(bone.name, 'bone');
  checkInt(bone.length, 'length');
  if (bone.length < 0) throw refuse('bad-value', 'length must be >= 0');
  if (rig.bones.some((b) => b.name === bone.name)) {
    throw refuse('name-taken', `a bone named ${bone.name} exists`);
  }
  if (bone.parentId !== undefined) mustBone(rig, bone.parentId);
  if (rest !== undefined) {
    mustView(rig, rest.viewId);
    checkRest(rest);
  }
  const id = tx.newId('bone');
  tx.update((d) => {
    const r = mutRig(d);
    r.bones.push({
      id,
      name: bone.name,
      ...(bone.parentId === undefined ? {} : { parentId: bone.parentId }),
      length: bone.length,
    });
    if (rest !== undefined) {
      const view = r.views.find((v) => v.id === rest.viewId);
      if (view !== undefined) view.rest[id] = { x: rest.x, y: rest.y, angle: rest.angle };
    }
  });
  return id;
}

function checkRest(rest: { x: number; y: number; angle: number }): void {
  checkInt(rest.x, 'rest x');
  checkInt(rest.y, 'rest y');
  if (!Number.isFinite(rest.angle)) throw refuse('bad-value', 'rest angle must be finite');
}

/** Options of {@link deleteBone}. */
export interface DeleteBoneOptions {
  /** Also delete every descendant. Default false: a bone with children is refused (`has-children`). */
  readonly cascade?: boolean;
}

/**
 * Deletes a bone. **Policy**: never destroys art. A bone that has parts is refused (`has-parts`; also
 * when a descendant being deleted has parts): unbind or delete the part first. A bone with children is
 * refused (`has-children`) unless `cascade`, which deletes the whole subtree. The bones' rest entries
 * in every view and their bone keys in every authored frame go with them (they would dangle, I1).
 */
export function deleteBone(tx: Transaction, bone: BoneId, opts: DeleteBoneOptions = {}): void {
  const rig = rigOf(tx.doc);
  mustBone(rig, bone);
  const doomed = opts.cascade === true ? subtree(rig, bone) : new Set<BoneId>([bone]);
  if (opts.cascade !== true && rig.bones.some((b) => b.parentId === bone)) {
    throw refuse('has-children', `bone ${bone} has children; pass cascade to delete them too`);
  }
  const bound = rig.parts.find((p) => doomed.has(p.boneId));
  if (bound !== undefined) {
    throw refuse(
      'has-parts',
      `bone ${bound.boneId} has part ${bound.id}; delete or rebind it first`,
    );
  }
  tx.update((d) => {
    const r = mutRig(d);
    r.bones = r.bones.filter((b) => !doomed.has(b.id));
    for (const v of r.views) for (const id of doomed) Reflect.deleteProperty(v.rest, id);
    for (const anim of d.animations) {
      if (!('frames' in anim)) continue;
      for (const f of anim.frames) for (const id of doomed) Reflect.deleteProperty(f.boneKeys, id);
    }
  });
}

/**
 * Moves a bone under `newParent` (missing: makes it a root). Refused with `cycle` when `newParent` is
 * the bone or one of its descendants. **The art stays put**: in every view where the bone has a rest
 * entry its rest offset and angle are recomputed so that its canvas pivot and world direction at rest
 * are unchanged (ADR-012: offsets are relative to the parent). Descendants are unaffected.
 */
export function reparentBone(tx: Transaction, bone: BoneId, newParent?: BoneId): void {
  const rig = rigOf(tx.doc);
  mustBone(rig, bone);
  if (newParent !== undefined) {
    mustBone(rig, newParent);
    if (subtree(rig, bone).has(newParent)) {
      throw refuse('cycle', `${newParent} is ${bone} or one of its descendants`);
    }
  }
  const next: Record<ViewId, RestTransform | undefined> = {};
  const after = {
    bones: rig.bones.map((b) =>
      b.id !== bone
        ? { id: b.id, ...(b.parentId === undefined ? {} : { parentId: b.parentId }) }
        : { id: b.id, ...(newParent === undefined ? {} : { parentId: newParent }) },
    ),
  };
  for (const v of rig.views) {
    const r = v.rest[bone];
    if (r === undefined) continue;
    const world = clean(worldRest(rig, v.rest, bone));
    const pivots = snapSkeleton(rig, v, new Map()).bones;
    const p = pivots.get(bone)?.pivot ?? { x: r.x, y: r.y };
    if (newParent === undefined) {
      next[v.id] = { x: p.x, y: p.y, angle: world };
    } else {
      const q = pivots.get(newParent)?.pivot ?? { x: 0, y: 0 };
      next[v.id] = {
        x: p.x - q.x,
        y: p.y - q.y,
        angle: clean(world - worldRest(after as unknown as RigRo, v.rest, newParent)),
      };
    }
  }
  tx.update((d) => {
    const r = mutRig(d);
    const b = r.bones.find((x) => x.id === bone);
    if (b === undefined) return;
    if (newParent === undefined) delete b.parentId;
    else b.parentId = newParent;
    for (const v of r.views) {
      const nr = next[v.id];
      if (nr !== undefined) v.rest[bone] = nr;
    }
  });
}

/** Renames a bone; the new name must be a valid schema name not used by another bone. */
export function renameBone(tx: Transaction, bone: BoneId, name: string): void {
  const rig = rigOf(tx.doc);
  const b = mustBone(rig, bone);
  checkName(name, 'bone');
  if (rig.bones.some((x) => x.name === name && x.id !== bone)) {
    throw refuse('name-taken', `a bone named ${name} exists`);
  }
  if (b.name === name) return;
  tx.update((d) => {
    const t = mutRig(d).bones.find((x) => x.id === bone);
    if (t !== undefined) t.name = name;
  });
}

/** Sets a bone's length (integer >= 0, pixels from pivot to tip). */
export function setBoneLength(tx: Transaction, bone: BoneId, length: number): void {
  mustBone(rigOf(tx.doc), bone);
  checkInt(length, 'length');
  if (length < 0) throw refuse('bad-value', 'length must be >= 0');
  tx.update((d) => {
    const t = mutRig(d).bones.find((x) => x.id === bone);
    if (t !== undefined) t.length = length;
  });
}

/**
 * Sets (or adds) a bone's rest transform in one view: integer `x, y` (a root: canvas pivot; a child:
 * canvas offset from the parent's pivot at rest, ADR-012) and a finite `angle` (parent-relative bone
 * direction, degrees clockwise, 0 along +x, 90 down). Children keep their own offsets, so moving a
 * bone moves its subtree with it.
 */
export function setRestPose(
  tx: Transaction,
  view: ViewId,
  bone: BoneId,
  rest: RestTransform,
): void {
  const rig = rigOf(tx.doc);
  mustView(rig, view);
  mustBone(rig, bone);
  checkRest(rest);
  tx.update((d) => {
    const v = mutRig(d).views.find((x) => x.id === view);
    if (v !== undefined) v.rest[bone] = { x: rest.x, y: rest.y, angle: rest.angle };
  });
}

// ---- views ----------------------------------------------------------------------------------------

/**
 * Adds an empty view (no rest entries). `name` is a unique schema name (matched by `#<view>` in
 * source layer names); `directions` are distinct direction names (a schema name other than
 * `default`), none of which another view already draws (`direction-taken`).
 * @returns the new view's id.
 */
export function addView(tx: Transaction, name: string, directions: readonly string[]): ViewId {
  const rig = rigOf(tx.doc);
  checkName(name, 'view');
  if (rig.views.some((v) => v.name === name))
    throw refuse('name-taken', `a view named ${name} exists`);
  if (directions.length === 0) throw refuse('bad-value', 'a view draws at least one direction');
  const seen = new Set<string>();
  for (const dir of directions) {
    if (!DIRECTION_REGEX.test(dir))
      throw refuse('bad-name', `bad direction name ${JSON.stringify(dir)}`);
    if (seen.has(dir)) throw refuse('bad-value', `direction ${dir} is listed twice`);
    seen.add(dir);
    if (rig.views.some((v) => v.directions.includes(dir))) {
      throw refuse('direction-taken', `a view already draws direction ${dir}`);
    }
  }
  const id = tx.newId('view');
  tx.update((d) => {
    mutRig(d).views.push({
      id,
      name,
      directions: [...directions],
      rest: {},
      partVisibility: {},
      defaultZ: {},
    });
  });
  return id;
}

/**
 * Deletes a view with its rest poses, part visibility and default z. Refused (`has-variants`) while
 * any variant is drawn for it: delete those variants (or their parts) first, so no art is lost.
 */
export function deleteView(tx: Transaction, view: ViewId): void {
  const rig = rigOf(tx.doc);
  mustView(rig, view);
  if (rig.parts.some((p) => p.variants.some((v) => v.viewId === view))) {
    throw refuse('has-variants', `view ${view} still has variants`);
  }
  tx.update((d) => {
    const r = mutRig(d);
    r.views = r.views.filter((v) => v.id !== view);
  });
}

/** Renames a view; unique, schema-name grammar. */
export function renameView(tx: Transaction, view: ViewId, name: string): void {
  const rig = rigOf(tx.doc);
  const v = mustView(rig, view);
  checkName(name, 'view');
  if (rig.views.some((x) => x.name === name && x.id !== view)) {
    throw refuse('name-taken', `a view named ${name} exists`);
  }
  if (v.name === name) return;
  tx.update((d) => {
    const t = mutRig(d).views.find((x) => x.id === view);
    if (t !== undefined) t.name = name;
  });
}

// ---- pivots and z ---------------------------------------------------------------------------------

/**
 * Sets a variant's pivot: integer image coordinates of the pivot pixel (pixel-centre convention).
 * **Decision**: the pivot may lie outside the variant image (a floating hand whose wrist pixel is not
 * painted is normal; the render aligns the pivot pixel to the bone whatever the image bounds), so only
 * integrality and a sanity range of +-2^20 are enforced.
 */
export function setPivot(
  tx: Transaction,
  part: PartId,
  variant: VariantId,
  pivot: { readonly x: number; readonly y: number },
): void {
  const p = rigOf(tx.doc).parts.find((x) => x.id === part);
  if (p === undefined) throw refuse('unknown-part', `no part ${part}`);
  if (!p.variants.some((v) => v.id === variant)) {
    throw refuse('unknown-variant', `part ${part} has no variant ${variant}`);
  }
  checkInt(pivot.x, 'pivot x');
  checkInt(pivot.y, 'pivot y');
  if (Math.abs(pivot.x) > 1 << 20 || Math.abs(pivot.y) > 1 << 20) {
    throw refuse('bad-value', 'pivot is out of range');
  }
  tx.update((d) => {
    const v = mutRig(d)
      .parts.find((x) => x.id === part)
      ?.variants.find((x) => x.id === variant);
    if (v !== undefined) v.pivot = { x: pivot.x, y: pivot.y };
  });
}

/** Sets a part's default z in one view (FR-RIG-06): integer, higher draws on top. */
export function setPartZ(tx: Transaction, view: ViewId, part: PartId, z: number): void {
  const rig = rigOf(tx.doc);
  mustView(rig, view);
  if (!rig.parts.some((p) => p.id === part)) throw refuse('unknown-part', `no part ${part}`);
  checkInt(z, 'z');
  tx.update((d) => {
    const v = mutRig(d).views.find((x) => x.id === view);
    if (v !== undefined) v.defaultZ[part] = z;
  });
}

// ---- templates ------------------------------------------------------------------------------------

/** Options of {@link applySkeletonTemplate}. */
export interface ApplyTemplateOptions {
  /** Apply into this existing view. Missing: a new view is created from the template. */
  readonly viewId?: ViewId;
  /** Name of the new view (default: the template's). Ignored with `viewId`. */
  readonly viewName?: string;
}

/** Result of {@link applySkeletonTemplate}. */
export interface AppliedTemplate {
  readonly viewId: ViewId;
  /** Bone id per template bone name (existing bones are reused). */
  readonly bones: Readonly<Record<string, BoneId>>;
  /** Names of the bones that were created. */
  readonly created: readonly string[];
}

/**
 * Applies a skeleton template (`humanoidSide()` etc.; pass `origin` = the document origin and the
 * character height when generating it). Bones are matched **by name**: a bone that exists is reused
 * (its length is kept; a different parent is refused, `bone-mismatch`), a missing one is created.
 * Every template bone gets its rest transform in the view, so applying the front template after the
 * side one gives a rig with two views over one skeleton. With no `viewId` a new view named after the
 * template (`side`, `front`, `back`) is created.
 */
export function applySkeletonTemplate(
  tx: Transaction,
  template: SkeletonTemplate,
  opts: ApplyTemplateOptions = {},
): AppliedTemplate {
  const rig = rigOf(tx.doc);
  if (opts.viewId !== undefined) mustView(rig, opts.viewId);
  const viewName = opts.viewName ?? template.view.name;
  if (opts.viewId === undefined) {
    checkName(viewName, 'view');
    if (rig.views.some((v) => v.name === viewName)) {
      throw refuse('name-taken', `a view named ${viewName} exists`);
    }
    for (const dir of template.view.directions) {
      if (rig.views.some((v) => v.directions.includes(dir))) {
        throw refuse('direction-taken', `a view already draws direction ${dir}`);
      }
    }
  }
  // Resolve (and check) every bone before changing anything.
  const idOf: Record<string, BoneId> = {};
  const created: string[] = [];
  for (const tb of template.bones) {
    const existing = rig.bones.find((b) => b.name === tb.name);
    if (existing === undefined) continue;
    const want =
      tb.parent === undefined ? undefined : rig.bones.find((b) => b.name === tb.parent)?.id;
    if (existing.parentId !== want) {
      throw refuse('bone-mismatch', `bone ${tb.name} exists with another parent`);
    }
    idOf[tb.name] = existing.id;
  }
  const viewId = opts.viewId ?? tx.newId('view');
  for (const tb of template.bones) {
    if (idOf[tb.name] === undefined) {
      idOf[tb.name] = tx.newId('bone');
      created.push(tb.name);
    }
  }
  tx.update((d) => {
    const r = mutRig(d);
    let view = r.views.find((v) => v.id === viewId);
    if (view === undefined) {
      view = {
        id: viewId,
        name: viewName,
        directions: [...template.view.directions],
        rest: {},
        partVisibility: {},
        defaultZ: {},
      };
      r.views.push(view);
    }
    for (const tb of template.bones) {
      const id = must(idOf[tb.name]);
      if (created.includes(tb.name)) {
        const parentId = tb.parent === undefined ? undefined : idOf[tb.parent];
        r.bones.push({
          id,
          name: tb.name,
          ...(parentId === undefined ? {} : { parentId }),
          length: tb.length,
        });
      }
      view.rest[id] = { x: tb.rest.x, y: tb.rest.y, angle: tb.rest.angle };
    }
  });
  return { viewId, bones: idOf, created };
}

// ---- binding ----------------------------------------------------------------------------------------

/** Options of {@link bindParts}. */
export interface BindPartsOptions {
  /** Bind by layer name (default true): `part:<bone>[.<part>][@variant][#view]` or a plain bone name. */
  readonly byName?: boolean;
  /** Bind the still-unnamed pixel layers by overlap with the bone segments (default true). */
  readonly byOverlap?: boolean;
  /** Only consider these layers (default: every pixel layer). */
  readonly layers?: readonly LayerId[];
  /**
   * Source names to parse instead of the layer names, for layers imported from a file whose names
   * cannot be stored (the document grammar forbids `:`, `@`, `#`): `{[layerId]: 'part:hand_r@open#side'}`.
   */
  readonly rawNames?: Readonly<Record<string, string>>;
  /** View for layers without a `#view` suffix and for overlap. Default: the first view. */
  readonly viewId?: ViewId;
  /**
   * Default z for new parts, written to the view's `defaultZ`. Keyed by the part layer name (`upper_arm_r_sleeve`)
   * first, then by bone name (`upper_arm_r`, e.g. `template.z`).
   */
  readonly zByBone?: Readonly<Record<string, number>>;
  /** Overlap thresholds, see `rig`'s `DEFAULT_OVERLAP`. */
  readonly overlap?: OverlapOptions;
}

/** A pixel layer that became (part of) a part. */
export interface BoundPart {
  readonly layerId: LayerId;
  readonly partId: PartId;
  readonly variantId: VariantId;
  readonly boneId: BoneId;
  readonly viewId: ViewId;
  readonly how: 'name' | 'overlap';
  /** True when the layer was folded into an existing part and removed; false when it became the part layer. */
  readonly merged: boolean;
}

/** Result of {@link bindParts}. */
export interface BindPartsResult {
  readonly bound: readonly BoundPart[];
  /** Layers whose overlap has no clear winner (nothing was changed for them). */
  readonly ambiguous: readonly { layerId: LayerId; candidates: BoneId[] }[];
  /** Layers left untouched, with the reason. */
  readonly skipped: readonly { layerId: LayerId; reason: BindSkipReason }[];
}

/**
 * Why a layer was not bound: `no-view` (the rig has no view); `unknown-bone` (a `part:` name names no
 * bone); `unknown-view` (the `#view` names no view); `bone-not-in-view` (the bone has no rest entry
 * there, so no pivot); `empty` (no cel); `animated` (cels hold more than one drawing: a variant is
 * one image); `image-missing`; `duplicate-variant` (that bone/view/variant name is already taken);
 * `name-taken` (another part layer already has the name `<bone>[_<part>]`); `name-too-long` (`<bone>_<part>` is not a valid name, > 48 characters); `bone-has-part` (overlap never adds to a bone that already has a part); `no-overlap` (no opaque pixel within reach
 * of any bone).
 */
export type BindSkipReason =
  | 'no-view'
  | 'unknown-bone'
  | 'unknown-view'
  | 'bone-not-in-view'
  | 'empty'
  | 'animated'
  | 'image-missing'
  | 'duplicate-variant'
  | 'name-taken'
  | 'name-too-long'
  | 'bone-has-part'
  | 'no-overlap';

interface Source {
  readonly layerId: LayerId;
  readonly imageId: ImageId;
  readonly offset: { readonly x: number; readonly y: number };
}

type LayerRo = DeepReadonly<Layer>;
type PixelRo = DeepReadonly<Extract<Layer, { kind: 'pixel' }>>;

function pixelLayers(layers: readonly LayerRo[], out: PixelRo[] = []): PixelRo[] {
  for (const l of layers) {
    if (l.kind === 'group') pixelLayers(l.children, out);
    else if (l.kind === 'pixel') out.push(l);
  }
  return out;
}

/** The one drawing of a pixel layer: its image and offset, or why there is none. */
function sourceOf(layer: PixelRo): Source | BindSkipReason {
  let found: Source | undefined;
  for (const cel of Object.values(layer.cels)) {
    const resolved = 'linkTo' in cel ? layer.cels[cel.linkTo] : cel;
    if (resolved === undefined || 'linkTo' in resolved) continue;
    const s: Source = { layerId: layer.id, imageId: resolved.imageId, offset: resolved.offset };
    if (
      found !== undefined &&
      (found.imageId !== s.imageId ||
        found.offset.x !== s.offset.x ||
        found.offset.y !== s.offset.y)
    ) {
      return 'animated';
    }
    found = s;
  }
  return found ?? 'empty';
}

/**
 * Converts pixel layers into parts (FR-RIG-03, FR-DOC-04). For each candidate layer:
 *
 * 1. **By name** (`byName`): the (raw or layer) name is parsed with `parsePartLayerName`
 *    (`part:<bone>[.<part>][@variant][#view]`); a plain name equal to a bone name also binds that bone.
 *    The variant is `@variant` or `default`; the view is `#view` or `opts.viewId` / the first view.
 * 2. **By overlap** (`byOverlap`): layers not matched by name are bound to the bone their opaque
 *    pixels overlap, only when `rig`'s `bindByOverlap` finds a clear winner; otherwise the
 *    candidates are returned in `ambiguous` and the layer is left alone. Overlap uses the bone
 *    segments of the default view and the variant name `default`.
 *
 * A layer's single drawing (image and offset, links resolved) moves into a new {@link Variant}; its
 * pivot is the bone's rest pivot in that view minus the cel offset, so the part renders where it was
 * drawn. Layers are grouped by (bone, part): the first layer of a group becomes the part layer in
 * place (kind `part`, cels dropped, named `<bone>` or `<bone>_<part>`); further layers of the same
 * group (other variants / views) are folded in as variants and removed. A different `part` of the
 * same bone is a separate part (its own z). An existing part of that (bone, part) gets the new
 * variant too. A layer bound by overlap only ever creates the main part `<bone>`: if the bone already
 * has any part it is skipped (`bone-has-part`), never folded in. Two layers with the same (bone, part,
 * variant, view) skip the later one (`duplicate-variant`). Layers that cannot be bound are returned in
 * `skipped` / `ambiguous`, never guessed. One undo reverts everything; running it again changes nothing.
 */
export function bindParts(tx: Transaction, opts: BindPartsOptions = {}): BindPartsResult {
  const doc = tx.doc;
  const rig = rigOf(doc);
  const byName = opts.byName ?? true;
  const byOverlap = opts.byOverlap ?? true;
  const bound: BoundPart[] = [];
  const ambiguous: { layerId: LayerId; candidates: BoneId[] }[] = [];
  const skipped: { layerId: LayerId; reason: BindSkipReason }[] = [];
  const skip = (layerId: LayerId, reason: BindSkipReason): void => {
    skipped.push({ layerId, reason });
  };

  const partLayerNames = new Set<string>();
  const partLayerNameById = new Map<string, string>();
  const collectPartNames = (ls: readonly LayerRo[]): void => {
    for (const l of ls) {
      if (l.kind === 'part') {
        partLayerNames.add(l.name);
        partLayerNameById.set(l.id, l.name);
      } else if (l.kind === 'group') collectPartNames(l.children);
    }
  };
  collectPartNames(doc.layers);
  const boneNameOf = (id: BoneId): string => rig.bones.find((b) => b.id === id)?.name ?? '';

  const only = opts.layers === undefined ? undefined : new Set(opts.layers);
  const layers = pixelLayers(doc.layers).filter((l) => only === undefined || only.has(l.id));
  const defaultView = opts.viewId !== undefined ? mustView(rig, opts.viewId) : rig.views[0];

  // Plan: which layer feeds which (bone, view, variant).
  interface Planned {
    layer: PixelRo;
    source: Source;
    boneId: BoneId;
    viewId: ViewId;
    variant: string;
    /** Part name within the bone (`part:<bone>.<part>`); missing: the bone's main part. */
    part?: string;
    how: 'name' | 'overlap';
  }
  const planned: Planned[] = [];
  const unnamed: PixelRo[] = [];

  const consider = (
    layer: PixelRo,
    boneId: BoneId,
    viewId: ViewId,
    variant: string,
    how: 'name' | 'overlap',
    partName?: string,
  ): void => {
    const view = rig.views.find((v) => v.id === viewId);
    if (view?.rest[boneId] === undefined) {
      skip(layer.id, 'bone-not-in-view');
      return;
    }
    const source = sourceOf(layer);
    if (typeof source === 'string') {
      skip(layer.id, source);
      return;
    }
    if (tx.image(source.imageId) === undefined) {
      skip(layer.id, 'image-missing');
      return;
    }
    const boneNm = boneNameOf(boneId);
    const layerNm = partLayerName(
      partName === undefined ? { bone: boneNm } : { bone: boneNm, part: partName },
    );
    if (!NAME_REGEX.test(layerNm)) {
      skip(layer.id, 'name-too-long');
      return;
    }
    if (how === 'overlap') {
      // Overlap only decides the bone: the main part, and only when the bone has no part yet.
      if (rig.parts.some((p) => p.boneId === boneId) || planned.some((p) => p.boneId === boneId)) {
        skip(layer.id, 'bone-has-part');
        return;
      }
    }
    const part = rig.parts.find(
      (p) => p.boneId === boneId && partLayerNameById.get(p.layerId) === layerNm,
    );
    if (
      (part?.variants.some((v) => v.name === variant && v.viewId === viewId) ?? false) ||
      planned.some(
        (p) =>
          p.boneId === boneId &&
          p.part === partName &&
          p.viewId === viewId &&
          p.variant === variant,
      )
    ) {
      skip(layer.id, 'duplicate-variant');
      return;
    }
    planned.push({
      layer,
      source,
      boneId,
      viewId,
      variant,
      how,
      ...(partName === undefined ? {} : { part: partName }),
    });
  };

  for (const layer of layers) {
    let parsed: PartLayerName | null = null;
    let named = false;
    if (byName) {
      const raw = opts.rawNames?.[layer.id] ?? layer.name;
      parsed = parsePartLayerName(raw);
      if (parsed === null && rig.bones.some((b) => b.name === raw)) parsed = { bone: raw };
      named = parsed !== null || raw.startsWith('part:');
    }
    if (parsed === null) {
      if (named) skip(layer.id, 'unknown-bone');
      else unnamed.push(layer);
      continue;
    }
    const bone = rig.bones.find((b) => b.name === parsed.bone);
    if (bone === undefined) {
      skip(layer.id, 'unknown-bone');
      continue;
    }
    let view = defaultView;
    if (parsed.view !== undefined) {
      view = rig.views.find((v) => v.name === parsed.view);
      if (view === undefined) {
        skip(layer.id, 'unknown-view');
        continue;
      }
    }
    if (view === undefined) {
      skip(layer.id, 'no-view');
      continue;
    }
    consider(layer, bone.id, view.id, parsed.variant ?? DEFAULT_VARIANT_NAME, 'name', parsed.part);
  }

  if (byOverlap && unnamed.length > 0) {
    if (defaultView === undefined) {
      for (const l of unnamed) skip(l.id, 'no-view');
    } else {
      const shapes: PartShape[] = [];
      const bySource = new Map<LayerId, PixelRo>();
      for (const layer of unnamed) {
        const source = sourceOf(layer);
        const image = typeof source === 'string' ? undefined : tx.image(source.imageId);
        if (typeof source === 'string') skip(layer.id, source);
        else if (image === undefined) skip(layer.id, 'image-missing');
        else {
          const alpha = new Uint8Array(image.width * image.height);
          for (let y = 0; y < image.height; y++) {
            for (let x = 0; x < image.width; x++) {
              const px = image.get(x, y);
              const opaque =
                image instanceof IndexedImage
                  ? px !== image.transparentIndex
                  : (px as readonly number[])[3] !== 0;
              alpha[y * image.width + x] = opaque ? 255 : 0;
            }
          }
          shapes.push({
            layerId: layer.id,
            x: source.offset.x,
            y: source.offset.y,
            w: image.width,
            h: image.height,
            alpha,
          });
          bySource.set(layer.id, layer);
        }
      }
      const result = bindByOverlap(
        shapes,
        { bones: rig.bones, view: defaultView },
        opts.overlap ?? {},
      );
      for (const a of result.assignments) {
        const layer = bySource.get(a.layerId);
        if (layer !== undefined)
          consider(layer, a.boneId, defaultView.id, DEFAULT_VARIANT_NAME, 'overlap');
      }
      for (const a of result.ambiguous)
        ambiguous.push({ layerId: a.layerId, candidates: a.candidates });
      for (const id of result.unmatched) skip(id, 'no-overlap');
    }
  } else if (!byOverlap) {
    // unnamed layers are simply not ours
  }

  // Allocate ids (deterministically, in plan order) and record what to write.
  interface Write extends Planned {
    partId: PartId;
    variantId: VariantId;
    newPart: boolean;
    layerName: string;
    pivot: { x: number; y: number };
  }
  const writes: Write[] = [];
  const newPartOfKey = new Map<string, PartId>();
  const pivotsByView = new Map<ViewId, ReadonlyMap<BoneId, { pivot: { x: number; y: number } }>>();
  for (const p of planned) {
    const view = must(rig.views.find((v) => v.id === p.viewId));
    let pivots = pivotsByView.get(p.viewId);
    if (pivots === undefined) {
      pivots = snapSkeleton(rig, view, new Map()).bones;
      pivotsByView.set(p.viewId, pivots);
    }
    const bonePivot = pivots.get(p.boneId)?.pivot ?? { x: 0, y: 0 };
    const layerNm = partLayerName(
      p.part === undefined
        ? { bone: boneNameOf(p.boneId) }
        : { bone: boneNameOf(p.boneId), part: p.part },
    );
    const key = `${p.boneId}|${p.part ?? ''}`;
    const existing = rig.parts.find(
      (q) => q.boneId === p.boneId && partLayerNameById.get(q.layerId) === layerNm,
    );
    let partId = existing?.id ?? newPartOfKey.get(key);
    const newPart = partId === undefined;
    if (newPart) {
      if (partLayerNames.has(layerNm)) {
        skip(p.layer.id, 'name-taken');
        continue;
      }
      partLayerNames.add(layerNm);
      partId = tx.newId('part');
      newPartOfKey.set(key, partId);
    }
    writes.push({
      ...p,
      partId: must(partId),
      variantId: tx.newId('variant'),
      newPart,
      layerName: layerNm,
      pivot: { x: bonePivot.x - p.source.offset.x, y: bonePivot.y - p.source.offset.y },
    });
  }

  tx.update((d) => {
    const r = mutRig(d);
    for (const w of writes) {
      const variant = {
        id: w.variantId,
        name: w.variant,
        viewId: w.viewId,
        imageId: w.source.imageId,
        pivot: w.pivot,
        tags: [] as string[],
      };
      const loc = locate(d.layers, w.layer.id);
      if (loc === undefined) continue;
      if (w.newPart) {
        const layer = loc.list[loc.index] as unknown as Record<string, unknown>;
        layer.kind = 'part';
        delete layer.cels;
        layer.name = w.layerName;
        r.parts.push({ id: w.partId, boneId: w.boneId, layerId: w.layer.id, variants: [variant] });
      } else {
        r.parts.find((p) => p.id === w.partId)?.variants.push(variant);
        loc.list.splice(loc.index, 1);
      }
      const z = opts.zByBone?.[w.layerName] ?? opts.zByBone?.[boneNameOf(w.boneId)];
      if (z !== undefined && w.newPart) {
        const view = r.views.find((v) => v.id === w.viewId);
        if (view !== undefined) view.defaultZ[w.partId] = z;
      }
    }
  });
  for (const w of writes) {
    bound.push({
      layerId: w.layer.id,
      partId: w.partId,
      variantId: w.variantId,
      boneId: w.boneId,
      viewId: w.viewId,
      how: w.how,
      merged: !w.newPart,
    });
  }
  return { bound, ambiguous, skipped };
}

function locate(layers: Layer[], id: LayerId): { list: Layer[]; index: number } | undefined {
  for (const [index, l] of layers.entries()) {
    if (l.id === id) return { list: layers, index };
    if (l.kind === 'group') {
      const f = locate(l.children, id);
      if (f !== undefined) return f;
    }
  }
  return undefined;
}
