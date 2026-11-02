/**
 * Lint: structured findings over a document (palette, orphans, joints, stale overrides, opacity,
 * empty frames). Pure: renders through `core`, never writes.
 * @packageDocumentation
 */
import type { DocumentView } from '@pixel-forge/core';
import { LintContext } from './context.js';
import { RULES } from './rules.js';
import type { LintFinding, LintOptions } from './types.js';

export { RULES } from './rules.js';
export type { LintRule } from './rules.js';
export { RULE_IDS } from './types.js';
export type {
  LintAnimRef,
  LintFinding,
  LintJson,
  LintLocation,
  LintOptions,
  LintSeverity,
  RuleId,
} from './types.js';

/** Package identifier, used by the scaffold smoke test. */
export const lintPackage = '@pixel-forge/lint' as const;

/**
 * Lints a document (a store, snapshot or transaction). Frames are rendered with the rig renderer
 * (`createRigRenderer`, created here), so rules see the render output, under every skin where the
 * rule says so. Findings are ordered by rule (registry order, `RULE_IDS`), then by document order
 * within the rule; the result is deterministic.
 *
 * @throws CoreError `BAD_ARGUMENT` for an unknown animation in `opts.animations`.
 */
export function lint(view: DocumentView, opts: LintOptions = {}): LintFinding[] {
  const enable = opts.enable === undefined ? undefined : new Set<string>(opts.enable);
  const disable = new Set<string>(opts.disable ?? []);
  const ctx = new LintContext(view, opts);
  const out: LintFinding[] = [];
  for (const rule of RULES) {
    if (enable !== undefined && !enable.has(rule.id)) continue;
    if (disable.has(rule.id)) continue;
    out.push(...rule.run(ctx));
  }
  return out;
}
