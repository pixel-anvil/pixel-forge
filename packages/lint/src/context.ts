/**
 * The shared state of one `lint` run: the resolved options and a memoised, error-tolerant renderer.
 * @packageDocumentation
 */
import { CoreError, createRigRenderer, renderFrame, resolveAnimation } from '@pixel-forge/core';
import type { DocumentView, PartRenderer, SkinRef } from '@pixel-forge/core';
import type { LintFinding, LintLocation, LintOptions } from './types.js';

/** `maxPixels` default. */
export const MAX_PIXELS_DEFAULT = 16;

type Doc = DocumentView['doc'];
type Rendered = ReturnType<typeof renderFrame>;

/** A frame to check: an animation (by index in `doc.animations`) and one of its frames. */
export interface FrameTarget {
  readonly animIndex: number;
  readonly animId: string;
  readonly frameIndex: number;
  readonly frameId: string;
}

/** A skin to render: `'base'` or a named skin. */
export interface SkinTarget {
  readonly key: string;
  readonly ref: SkinRef | 'base';
}

/** What a rule receives. */
export class LintContext {
  readonly rig: PartRenderer = createRigRenderer();
  readonly maxPixels: number;
  /** Render failures, one finding per (animation, frame, skin); reported by `lint.renderError`. */
  readonly renderErrors: LintFinding[] = [];
  private readonly memo = new Map<string, Rendered | undefined>();

  constructor(
    readonly view: DocumentView,
    readonly opts: LintOptions,
  ) {
    this.maxPixels = Math.max(1, Math.floor(opts.maxPixels ?? MAX_PIXELS_DEFAULT));
  }

  get doc(): Doc {
    return this.view.doc;
  }

  /** True for an indexed document or a locked RGBA document (FR-PAL-06). */
  get locked(): boolean {
    return this.doc.meta.colorMode === 'indexed' || this.doc.meta.paletteLocked;
  }

  /** The animations to check, as indices into `doc.animations`, in document order. */
  animationIndices(): number[] {
    const all = this.doc.animations.map((_, i) => i);
    if (this.opts.animations === undefined) return all;
    const wanted = new Set(this.opts.animations.map((r) => resolveAnimation(this.doc, r)));
    return all.filter((i) => wanted.has(i));
  }

  /** Every frame of the chosen animations (a mirror has its source's frames). */
  frames(): FrameTarget[] {
    const out: FrameTarget[] = [];
    for (const animIndex of this.animationIndices()) {
      const anim = this.doc.animations[animIndex];
      if (anim === undefined) continue;
      const src =
        'mirrorOf' in anim ? this.doc.animations.find((a) => a.id === anim.mirrorOf) : anim;
      if (src === undefined || !('frames' in src)) continue;
      src.frames.forEach((f, frameIndex) =>
        out.push({ animIndex, animId: anim.id, frameIndex, frameId: f.id }),
      );
    }
    return out;
  }

  /** The skins to render: the option, else `base` then every skin. */
  skins(): SkinTarget[] {
    if (this.opts.skins === undefined) {
      return [
        { key: 'base', ref: 'base' },
        ...this.doc.skins.map((s): SkinTarget => ({ key: s.name, ref: { id: s.id } })),
      ];
    }
    const seen = new Set<string>();
    const out: SkinTarget[] = [];
    for (const ref of this.opts.skins) {
      const skin =
        ref === 'base'
          ? undefined
          : this.doc.skins.find((s) => ('id' in ref ? s.id === ref.id : s.name === ref.name));
      const key = ref === 'base' ? 'base' : (skin?.name ?? ('name' in ref ? ref.name : ref.id));
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, ref });
    }
    return out;
  }

  /** The location fields shared by the per-frame rules. */
  at(f: FrameTarget, skin?: string): LintLocation {
    return {
      animationId: f.animId,
      frameId: f.frameId,
      frameIndex: f.frameIndex,
      ...(skin === undefined ? {} : { skin }),
    };
  }

  /** The (memoised) export render of a frame; `undefined` when it fails (the error is recorded once). */
  render(f: FrameTarget, skin: SkinTarget): Rendered | undefined {
    const key = `${f.animId}|${String(f.frameIndex)}|${skin.key}`;
    if (this.memo.has(key)) return this.memo.get(key);
    let img: Rendered | undefined;
    try {
      img = renderFrame(
        this.view,
        { id: this.doc.animations[f.animIndex]?.id ?? ('' as never) },
        f.frameIndex,
        {
          // The export render: lint checks the image export writes (hidden and non-exported layers
          // are skipped), like `checkOverrides` and the render cache.
          exportOnly: true,
          skin: skin.ref,
          rig: this.rig,
        },
      );
    } catch (e) {
      if (!(e instanceof CoreError)) throw e;
      this.renderErrors.push({
        rule: 'lint.renderError',
        severity: 'error',
        location: this.at(f, skin.key),
        message: `render failed: ${e.message}`,
        data: { code: e.code },
      });
    }
    this.memo.set(key, img);
    return img;
  }

  /** The first `maxPixels` pixels of a list, as JSON. */
  cap(pixels: readonly (readonly [number, number])[]): [number, number][] {
    return pixels.slice(0, this.maxPixels).map(([x, y]) => [x, y]);
  }
}
