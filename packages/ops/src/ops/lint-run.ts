/**
 * `lint.run`: structured findings over a document (read-only; MCP `lint`).
 * @packageDocumentation
 */
import { lint } from '@pixel-forge/lint';
import type { LintJson, LintOptions } from '@pixel-forge/lint';
import { RULE_IDS } from '@pixel-forge/lint';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { AnimRef, DocRef } from '../refs.js';

/** A JSON value (the `data` of a finding). */
const Json: z.ZodType<LintJson> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(Json),
    z.record(z.string(), Json),
  ]),
);

const Pixel = z.strictObject({ x: z.int(), y: z.int() });

/** One finding, as `lint` reports it. */
const LintFindingOutput = z.strictObject({
  rule: z.enum(RULE_IDS).describe('Rule id, for example "rig.jointGap".'),
  severity: z
    .enum(['error', 'warning', 'info'])
    .describe('"error" breaks an invariant, "warning" should be fixed, "info" may be intended.'),
  location: z
    .strictObject({
      layerId: z.string().optional().describe('Layer id.'),
      animationId: z.string().optional().describe('Animation id.'),
      frameId: z.string().optional().describe('Frame id.'),
      frameIndex: z.int().optional().describe('Frame index in its animation.'),
      skin: z.string().optional().describe('"base" or the skin name.'),
      pixel: Pixel.optional().describe('First offending pixel, canvas coordinates.'),
      overrideId: z.string().optional().describe('Override id.'),
      view: z.string().optional().describe('Rig view name.'),
      bone: z.string().optional().describe('Bone name.'),
    })
    .describe('Where the finding is; a rule fills the fields that apply.'),
  message: z.string().describe('One line for people.'),
  data: z
    .record(z.string(), Json)
    .describe('Machine-readable details; keys per rule are in packages/lint/README.md.'),
});

/** `lint.run` (MCP `lint`, CLI `pf lint`). */
export const lintRun = defineOp({
  name: 'lint.run',
  safety: 'read',
  summary:
    'Lint the document: palette, orphan pixels, joint gaps, stale overrides, empty frames, clipping, holes.',
  description:
    'Sorted by rule, then document order. Narrow with enable, disable, animations or skins. "error" means a broken invariant; fix warnings before delivery. pixels.clipped: part art cut off at the canvas edge. rig.partHole: 1 px holes in rotated parts. count 0 is not a visual pass (jointGap checks rest only): see render_contact_sheet.',
  mcp: { name: 'lint' },
  cli: { command: ['lint'] },
  input: z.strictObject({
    doc: DocRef,
    enable: z
      .array(z.enum(RULE_IDS))
      .optional()
      .describe('Run only these rule ids (default: all).'),
    disable: z
      .array(z.enum(RULE_IDS))
      .optional()
      .describe('Skip these rule ids (applied after enable).'),
    animations: z
      .array(AnimRef)
      .optional()
      .describe('Animations to render and check (default: all, in document order).'),
    skins: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Skin names to render for palette checks; "base" is the base colours (default: base, then every skin).',
      ),
    maxPixels: z.int().min(1).optional().describe('Most pixels listed per finding (default 16).'),
  }),
  output: z.strictObject({
    count: z.int().describe('Number of findings.'),
    findings: z.array(LintFindingOutput).describe('The findings, in report order.'),
  }),
  examples: [
    {
      title: 'Lint the hero, joint and palette rules only',
      input: { doc: 'doc_g1ed5q', enable: ['rig.jointGap', 'palette.offPalette'] },
    },
  ],
  handler: (ctx, input) => {
    const opts: LintOptions = {
      ...(input.enable === undefined ? {} : { enable: input.enable }),
      ...(input.disable === undefined ? {} : { disable: input.disable }),
      ...(input.animations === undefined ? {} : { animations: input.animations }),
      ...(input.skins === undefined
        ? {}
        : { skins: input.skins.map((s) => (s === 'base' ? 'base' : { name: s })) }),
      ...(input.maxPixels === undefined ? {} : { maxPixels: input.maxPixels }),
    };
    const findings = lint(ctx.view, opts);
    return { count: findings.length, findings };
  },
});
