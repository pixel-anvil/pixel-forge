/**
 * Public types of the lint package: findings, options and the rule ids.
 * @packageDocumentation
 */
import type { SkinRef, resolveAnimation } from '@pixel-forge/core';

/** An animation reference: `{id}` or `{group, direction?}` (the schema `AnimRef`). */
export type LintAnimRef = Parameters<typeof resolveAnimation>[1];

/** Every rule id, in registry order (the order findings are reported in). */
export const RULE_IDS = [
  'palette.offPalette',
  'palette.opacityInLocked',
  'pixels.orphan',
  'rig.jointGap',
  'rig.staleOverride',
  'rig.overrideError',
  'rig.rotationResidual',
  'anim.emptyFrame',
  'lint.renderError',
] as const;

/** A rule id such as `palette.offPalette`. */
export type RuleId = (typeof RULE_IDS)[number];

/** `error` breaks an invariant, `warning` should be fixed, `info` is a hint that may be intended. */
export type LintSeverity = 'error' | 'warning' | 'info';

/** A JSON-safe value, the type of {@link LintFinding.data}. */
export type LintJson =
  null | boolean | number | string | readonly LintJson[] | { readonly [key: string]: LintJson };

/**
 * Where a finding is. Every field is optional; a rule fills what applies. Ids are the schema's
 * string ids; `skin` is `'base'` or the skin's name.
 */
export interface LintLocation {
  readonly layerId?: string;
  readonly animationId?: string;
  readonly frameId?: string;
  /** Index of the frame in its (source) animation. */
  readonly frameIndex?: number;
  readonly skin?: string;
  /** The first offending pixel (canvas coordinates); `data.pixels` lists more. */
  readonly pixel?: { readonly x: number; readonly y: number };
  readonly overrideId?: string;
  /** Rig view name (joint rules). */
  readonly view?: string;
  readonly bone?: string;
}

/** One lint result. */
export interface LintFinding {
  readonly rule: RuleId;
  readonly severity: LintSeverity;
  readonly location: LintLocation;
  /** Human-readable, one line. */
  readonly message: string;
  /** Machine-readable details; the keys per rule are in the package README. */
  readonly data: Readonly<Record<string, LintJson>>;
}

/** Options of `lint`. */
export interface LintOptions {
  /** Run only these rules (default: all). */
  readonly enable?: readonly RuleId[];
  /** Skip these rules (applied after `enable`). */
  readonly disable?: readonly RuleId[];
  /** Animations to render and check (default: every animation, in document order). */
  readonly animations?: readonly LintAnimRef[];
  /** Skins to render for `palette.offPalette` (default: `'base'` then every skin, in document order). */
  readonly skins?: readonly (SkinRef | 'base')[];
  /** Most pixels listed in `data.pixels` / `data.union` per finding (default 16, min 1). */
  readonly maxPixels?: number;
}
