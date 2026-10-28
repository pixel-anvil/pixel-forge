/**
 * Override staleness at document level (FR-RIG-22): list the overrides with their state, and the
 * "keep, discard, re-base" resolutions (`override_list` / `override_resolve`). The hashing and the
 * list edits are `rig`'s pure functions; this file finds the targets (the part renders and the
 * composite before the final overrides) and wraps the edits in the open {@link Transaction}.
 * @packageDocumentation
 */
import { checkOverride, discard, partTarget, rebase } from '@pixel-forge/rig';
import type {
  OverrideCheck,
  OverrideTargetRender,
  PartRender,
  StaleReason,
} from '@pixel-forge/rig';
import type {
  AnimRef,
  Animation,
  AnimationId,
  AuthoredAnimation,
  FrameId,
  ImageId,
  Override,
  OverrideId,
  OverrideTarget,
} from '@pixel-forge/schema';
import { CoreError } from './errors.js';
import type { CoreErrorCode } from './errors.js';
import { referencedImages, resolveAnimation } from './frames.js';
import type { DeepReadonly } from './json.js';
import { planFrame, renderStages } from './render.js';
import type { RenderOptions, RenderStages } from './render.js';
import { createRigRenderer, rendererOver, rigCall } from './rig-render.js';
import type { PartRenderer } from './rig-render.js';
import type { Transaction } from './transaction.js';
import type { DocumentView } from './view.js';

/** The state of one override (see {@link checkOverrides}). */
export interface OverrideStatus {
  readonly overrideId: OverrideId;
  readonly animationId: AnimationId;
  readonly frameId: FrameId;
  readonly target: DeepReadonly<OverrideTarget>;
  /** True for a mirror animation's own final override (checked against the flipped render). */
  readonly mirror: boolean;
  readonly stale: boolean;
  /**
   * Set when `stale`: `hash` (the region changed), `no-target` (nothing to compare with) or `error`
   * (the target could not be rendered; see `errorCode`). An `error` override is reported as stale
   * (it cannot be shown valid) and cannot be re-based until the render works again.
   */
  readonly reason?: StaleReason | 'error';
  /** Set for `reason: 'error'`: the code of the `CoreError` the render raised. */
  readonly errorCode?: CoreErrorCode;
  /** Set for `reason: 'error'`: its message. */
  readonly errorMessage?: string;
  /** The stored hash. */
  readonly baseHash: string;
  /** The hash of the region under the current render; missing for `no-target`. */
  readonly currentHash?: string;
}

/** Which render the final overrides are checked against: the drawing options of `renderFrame`. */
export type OverrideRenderOptions = Pick<
  RenderOptions,
  'exportOnly' | 'includeReference' | 'layers'
>;

/** Options of {@link checkOverrides} and {@link rebaseOverrides}. */
export interface OverrideCheckOptions {
  /** Only these animations (default: every animation, in document order). */
  readonly animations?: readonly AnimRef[];
  /** The rig renderer to use (its cache is reused). Default: a fresh {@link createRigRenderer}. */
  readonly rig?: PartRenderer;
  /**
   * The render the final overrides are hashed over. Default `{ exportOnly: true }`: the export render
   * (the render cache and `pf override import` use it), so hiding an editor-only layer never makes a
   * final override stale. Part overrides are always hashed over the part's own render.
   */
  readonly render?: OverrideRenderOptions;
}

/**
 * Why an override resolution was refused: `CoreError('BAD_ARGUMENT')` `details.reason`.
 * `unknown-override`: no animation has an override with that id; `no-target`: the override's target
 * is not rendered (a hidden part, a deleted frame), so there is nothing to re-base on;
 * `mirror-part-override`: a mirror animation's part override (T3.6).
 */
export type OverrideOpReason = 'unknown-override' | 'no-target' | 'mirror-part-override';

const refuse = (reason: OverrideOpReason, message: string): CoreError =>
  new CoreError('BAD_ARGUMENT', message, { reason });

type Ro<T> = DeepReadonly<T>;

/** A memoised success or failure, so a frame that cannot be rendered fails once, not per override. */
type Memo<T> = { readonly ok: T } | { readonly error: unknown };

function memo<K, T>(map: Map<K, Memo<T>>, key: K, make: () => T): T {
  let m = map.get(key);
  if (m === undefined) {
    try {
      m = { ok: make() };
    } catch (error) {
      m = { error };
    }
    map.set(key, m);
  }
  if ('error' in m) throw m.error;
  return m.ok;
}

/**
 * Lazily renders the targets of one animation's overrides, frame by frame. The parts of a frame are
 * computed once (`frameParts`) and shared by the part-override targets and by the composite the
 * final overrides are hashed over.
 */
class Targets {
  private readonly parts = new Map<FrameId, Memo<readonly PartRender[]>>();
  private readonly stages = new Map<FrameId, Memo<RenderStages>>();
  private readonly source: Ro<AuthoredAnimation> | undefined;
  readonly palette: readonly (readonly [number, number, number, number])[] | undefined;

  constructor(
    private readonly view: DocumentView,
    private readonly anim: Ro<Animation>,
    private readonly rig: PartRenderer,
    private readonly render: OverrideRenderOptions,
  ) {
    const doc = view.doc;
    const src = 'mirrorOf' in anim ? doc.animations.find((a) => a.id === anim.mirrorOf) : anim;
    this.source = src === undefined || 'mirrorOf' in src ? undefined : src;
    const pal = doc.palettes.find((p) => p.id === doc.activePaletteId);
    this.palette = pal?.colors;
  }

  private frameIndex(frameId: FrameId): number {
    return this.source?.frames.findIndex((f) => f.id === frameId) ?? -1;
  }

  private partsOf(
    frameId: FrameId,
    fi: number,
    source: Ro<AuthoredAnimation>,
  ): readonly PartRender[] {
    return memo(this.parts, frameId, () => this.rig.frameParts(this.view, source, fi));
  }

  /** The target of `o`, or `undefined` when it has none. Throws the render's `CoreError`. */
  of(o: Ro<Override>): OverrideTargetRender | undefined {
    const fi = this.frameIndex(o.frameId);
    const source = this.source;
    if (fi < 0 || source === undefined) return undefined;
    if (o.target === 'final') {
      const st = memo(this.stages, o.frameId, () => {
        const opts: RenderOptions = {
          exportOnly: true,
          ...this.render,
          rig: rendererOver(() => this.partsOf(o.frameId, fi, source)),
        };
        return renderStages(this.view, planFrame(this.view, { id: this.anim.id }, fi, opts), opts);
      });
      const image = 'mirrorOf' in this.anim ? st.beforeMirrorFinals : st.beforeFinals;
      return image === undefined ? undefined : { image, offset: { x: 0, y: 0 } };
    }
    if ('mirrorOf' in this.anim) return undefined;
    const partId = o.target.partId;
    const part = this.partsOf(o.frameId, fi, source).find((p) => p.partId === partId);
    return part === undefined ? undefined : partTarget(part);
  }
}

const isMirrorPart = (anim: Ro<Animation>, o: Ro<Override>): boolean =>
  'mirrorOf' in anim && o.target !== 'final';

/**
 * Every override of the chosen animations with its state (FR-RIG-22; lint and the timeline list the
 * stale ones). Part overrides are hashed over their part's pre-override render, relative to the
 * snapped pivot, so a part that only moved keeps valid overrides while a rotation or a variant switch
 * makes them stale; a part that is not drawn in the frame (hidden, no variant in the view) makes
 * them stale with `no-target`. Final overrides are hashed over the composite after the post-passes
 * (step 6, the input of step 7) of `opts.render`; a mirror's own final overrides over the flipped
 * source render. An override of a frame that does not exist is `no-target`. A mirror's part overrides
 * are not listed yet (T3.6). Pure: renders, never writes.
 *
 * A render that fails (missing images, a direction with no view, `BAD_RIG`, ...) does not abort the
 * listing: the overrides that depend on it are reported stale with `reason: 'error'` and the
 * `CoreError`'s `errorCode` and `errorMessage`, and the others are still checked.
 *
 * @throws CoreError `BAD_ARGUMENT` for an unknown animation in `opts.animations`.
 */
export function checkOverrides(
  view: DocumentView,
  opts: OverrideCheckOptions = {},
): OverrideStatus[] {
  const rig = opts.rig ?? createRigRenderer();
  const anims =
    opts.animations === undefined
      ? view.doc.animations
      : opts.animations.map((ref) => {
          const a = view.doc.animations[resolveAnimation(view.doc, ref)];
          if (a === undefined) throw new CoreError('BAD_ARGUMENT', 'unknown animation');
          return a;
        });
  const out: OverrideStatus[] = [];
  for (const anim of anims) {
    const targets = new Targets(view, anim, rig, opts.render ?? {});
    for (const o of anim.overrides) {
      if (isMirrorPart(anim, o)) continue;
      let c: OverrideCheck;
      try {
        c = rigCall(() => checkOverride(o, targets.of(o), view, targets.palette));
      } catch (e) {
        if (!(e instanceof CoreError)) throw e;
        out.push({
          overrideId: o.id,
          animationId: anim.id,
          frameId: o.frameId,
          target: o.target,
          mirror: 'mirrorOf' in anim,
          stale: true,
          reason: 'error',
          errorCode: e.code,
          errorMessage: e.message,
          baseHash: o.baseHash,
        });
        continue;
      }
      out.push({
        overrideId: o.id,
        animationId: anim.id,
        frameId: o.frameId,
        target: o.target,
        mirror: 'mirrorOf' in anim,
        stale: c.stale,
        ...(c.reason === undefined ? {} : { reason: c.reason }),
        baseHash: o.baseHash,
        ...(c.currentHash === undefined ? {} : { currentHash: c.currentHash }),
      });
    }
  }
  return out;
}

/** The stale overrides among {@link checkOverrides}. */
export function listStaleOverrides(
  view: DocumentView,
  opts: OverrideCheckOptions = {},
): OverrideStatus[] {
  return checkOverrides(view, opts).filter((s) => s.stale);
}

/** `ids` grouped by animation index, in document order; refuses unknown ids. */
function locate(view: DocumentView, ids: readonly OverrideId[]): Map<number, Set<OverrideId>> {
  const out = new Map<number, Set<OverrideId>>();
  for (const id of ids) {
    const ai = view.doc.animations.findIndex((a) => a.overrides.some((o) => o.id === id));
    const anim = view.doc.animations[ai];
    if (anim === undefined) throw refuse('unknown-override', `no override ${id}`);
    const o = anim.overrides.find((x) => x.id === id);
    if (o !== undefined && isMirrorPart(anim, o)) {
      throw refuse('mirror-part-override', `override ${id} is a mirror's part override (T3.6)`);
    }
    const set = out.get(ai) ?? new Set<OverrideId>();
    set.add(id);
    out.set(ai, set);
  }
  return new Map([...out].sort((a, b) => a[0] - b[0]));
}

/**
 * Re-bases the overrides `ids` (FR-RIG-22 "re-base"): recaptures each one's `baseHash` under the
 * current render of the transaction, with the same targets as {@link checkOverrides} (so the same
 * `opts.render` must be used to check them later). Checks every id before changing anything.
 *
 * @throws CoreError `BAD_ARGUMENT` with `reason` `unknown-override`, `no-target`,
 * `mirror-part-override`; render errors like `renderFrame`.
 */
export function rebaseOverrides(
  tx: Transaction,
  ids: readonly OverrideId[],
  opts: Omit<OverrideCheckOptions, 'animations'> = {},
): void {
  const rig = opts.rig ?? createRigRenderer();
  const updates: { ai: number; oi: number; hash: string }[] = [];
  for (const [ai, want] of locate(tx, ids)) {
    const anim = tx.doc.animations[ai];
    if (anim === undefined) continue;
    const targets = new Targets(tx, anim, rig, opts.render ?? {});
    for (const id of want) {
      const o = anim.overrides.find((x) => x.id === id);
      if (o !== undefined && targets.of(o) === undefined) {
        throw refuse('no-target', `override ${id} has no rendered target to re-base on`);
      }
    }
    const next = rigCall(() =>
      rebase(anim.overrides, want, (o) => targets.of(o), tx, targets.palette),
    );
    next.forEach((o, oi) => {
      if (want.has(o.id)) updates.push({ ai, oi, hash: o.baseHash });
    });
  }
  tx.update((d) => {
    for (const { ai, oi, hash } of updates) {
      const o = d.animations[ai]?.overrides[oi];
      if (o !== undefined) o.baseHash = hash;
    }
  });
}

/**
 * Discards the overrides `ids` (FR-RIG-22 "discard") and deletes the images that no longer have any
 * reference in the document. Checks every id before changing anything. "Keep" needs no operation:
 * a stale override is still applied as it is.
 *
 * @throws CoreError `BAD_ARGUMENT` with `reason` `unknown-override` or `mirror-part-override` (a
 * mirror's part overrides are T3.6's, as for {@link rebaseOverrides}).
 */
export function discardOverrides(tx: Transaction, ids: readonly OverrideId[]): void {
  const plan: { ai: number; keep: Ro<Override>[] }[] = [];
  const released = new Set<ImageId>();
  for (const [ai, want] of locate(tx, ids)) {
    const anim = tx.doc.animations[ai];
    if (anim === undefined) continue;
    const r = discard(anim.overrides, want);
    plan.push({ ai, keep: r.overrides });
    for (const id of r.released) released.add(id);
  }
  tx.update((d) => {
    for (const { ai, keep } of plan) {
      const anim = d.animations[ai];
      if (anim === undefined) continue;
      const ids2 = new Set(keep.map((o) => o.id));
      anim.overrides = anim.overrides.filter((o) => ids2.has(o.id));
    }
  });
  const still = referencedImages(tx.doc);
  for (const id of [...released].sort()) {
    if (!still.has(id) && tx.image(id) !== undefined) tx.deleteImage(id);
  }
}
