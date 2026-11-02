/**
 * `rig.applyPreset`: generate a motion preset (walk, run, ...) on the document's rig and store it as an
 * animation, in one undo step.
 * @packageDocumentation
 */
import { deleteFrame, insertFrame } from '@pixel-forge/core';
import { PRESET_NAMES, getPreset } from '@pixel-forge/rig';
import { DirectionName, Name } from '@pixel-forge/schema';
import type { AuthoredAnimation } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { DocRef, animationLabel, requireRig, viewForAnimation } from '../refs.js';
import { emptyFrame } from './anim-create.js';

/** The only view the presets are built for (a 3/4 view would be a later addition, not a new tool). */
const SUPPORTED_VIEW = 'side';

/** `rig.applyPreset` (MCP `rig_apply_preset`, tool group `rig`, CLI `pf rig apply-preset`). */
export const rigApplyPreset = defineOp({
  name: 'rig.applyPreset',
  safety: 'mutate',
  summary: 'Generate a motion preset (walk, run, jump, idle-breathe, swing) as an animation.',
  description:
    'Needs the humanoid template bone names. Writes animation <group>/side (group defaults to the preset); an existing one needs replace:true and loses its bone keys. Output: the resolved params, rootMotion and labels per frame. Next: render_contact_sheet.',
  input: z.strictObject({
    doc: DocRef,
    preset: z
      .string()
      .min(1)
      .describe(`Preset name: ${PRESET_NAMES.join(', ')}.`),
    params: z
      .record(z.string().min(1), z.number())
      .optional()
      .describe('Numeric parameters (defaults in the output).'),
    group: Name.optional().describe('Default: the preset name.'),
    direction: DirectionName.optional().describe('Default "side".'),
    frames: z.int().optional().describe('Same as params.frames.'),
    durationMs: z.int().min(1).optional().describe('Frame ms (default 100).'),
    view: z.string().optional().describe('Character view; only "side" (default).'),
    replace: z.boolean().optional().describe('Overwrite an existing animation.'),
  }),
  output: z.strictObject({
    animation: z.string().describe('Animation id.'),
    label: z.string().describe('"group/direction".'),
    created: z.boolean().describe('False when an existing animation was replaced.'),
    frames: z.int().describe('Frame count.'),
    loop: z.string().describe('Loop mode of the preset.'),
    angleQuantum: z.number().describe('Angle quantum the keys use, deg.'),
    params: z.record(z.string(), z.number()).describe('Every parameter with defaults filled in.'),
    rootMotion: z
      .array(z.strictObject({ dx: z.int(), dy: z.int() }))
      .describe('Root motion per frame, px (also stored on the frames).'),
    labels: z.array(z.record(z.string(), z.string())).describe('Labels per frame, e.g. foot_l.'),
    warnings: z.array(z.string()),
  }),
  examples: [
    {
      title: 'A 10-frame walk',
      input: { doc: 'doc_g1ed5q', preset: 'walk', frames: 10 },
    },
  ],
  handler: (ctx, input) => {
    const view = input.view ?? SUPPORTED_VIEW;
    if (view !== SUPPORTED_VIEW) {
      throw new OpError(
        'BAD_INPUT',
        `view "${view}" is not supported: presets are built for the "${SUPPORTED_VIEW}" view only`,
        { issues: [{ path: 'view', message: `only "${SUPPORTED_VIEW}"` }] },
      );
    }
    const doc = ctx.doc;
    const preset = getPreset(input.preset);
    const params: Record<string, number> = { ...(input.params ?? {}) };
    if (input.frames !== undefined) {
      if (params.frames !== undefined && params.frames !== input.frames) {
        throw new OpError('BAD_INPUT', 'frames and params.frames disagree; give one', {
          issues: [{ path: 'frames', message: 'differs from params.frames' }],
        });
      }
      params.frames = input.frames;
    }
    const group = input.group ?? preset.name;
    const direction = input.direction ?? SUPPORTED_VIEW;
    const rig = requireRig(doc);
    const rigView = viewForAnimation(doc, { direction });
    const result = preset.generate({ bones: rig.bones, view: rigView }, params);

    const existing = doc.animations.find((a) => a.group === group && a.direction === direction);
    if (existing !== undefined) {
      if (input.replace !== true) {
        throw new OpError(
          'REFUSED',
          `animation ${animationLabel(existing)} already exists; pass replace:true to overwrite its bone keys, or pick another group or direction`,
          { reason: 'animation-exists', animation: existing.id },
        );
      }
      if ('mirrorOf' in existing) {
        throw new OpError(
          'REFUSED',
          `${animationLabel(existing)} is a mirror and has no frames of its own; pick another group or direction`,
          { reason: 'mirror-animation', animation: existing.id },
        );
      }
    }

    const warnings: string[] = [];
    const n = result.frames.length;
    let id: AuthoredAnimation['id'];
    if (existing === undefined || !('frames' in existing)) {
      id = ctx.tx.newId('animation');
      const frameIds = Array.from({ length: n }, () => ctx.tx.newId('frame'));
      const anim: AuthoredAnimation = {
        id,
        group,
        direction,
        loop: result.loop,
        angleQuantum: result.angleQuantum,
        frames: frameIds.map((f) => emptyFrame(f, input.durationMs ?? 100)),
        overrides: [],
      };
      ctx.tx.update((d) => {
        d.animations.push(anim);
      });
    } else {
      id = existing.id;
      const ref = { id };
      const have = existing.frames.length;
      for (let i = have; i < n; i++) {
        insertFrame(ctx.tx, ref, i - 1, {
          position: 'after',
          ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        });
      }
      for (let i = have - 1; i >= n; i--) deleteFrame(ctx.tx, ref, i);
      if (existing.overrides.length > 0) {
        warnings.push(
          `${String(existing.overrides.length)} pixel override(s) kept; check them with override_list (they may be stale)`,
        );
      }
      if (existing.loop !== result.loop) {
        warnings.push(`loop changed from "${existing.loop}" to "${result.loop}"`);
      }
    }

    ctx.tx.update((d) => {
      const anim = d.animations.find((a) => a.id === id);
      if (anim === undefined || !('frames' in anim)) return;
      anim.loop = result.loop;
      anim.angleQuantum = result.angleQuantum;
      result.frames.forEach((pf, i) => {
        const frame = anim.frames[i];
        if (frame === undefined) return;
        frame.boneKeys = {};
        for (const [bone, key] of Object.entries(pf.boneKeys)) {
          if (key !== undefined) frame.boneKeys[bone as keyof typeof frame.boneKeys] = key;
        }
        frame.rootMotion = { dx: pf.rootMotion.dx, dy: pf.rootMotion.dy };
      });
    });

    return {
      animation: id,
      label: animationLabel({ group, direction }),
      created: existing === undefined,
      frames: n,
      loop: result.loop,
      angleQuantum: result.angleQuantum,
      params: { ...result.params },
      rootMotion: result.frames.map((f) => ({ dx: f.rootMotion.dx, dy: f.rootMotion.dy })),
      labels: result.frames.map((f) => ({ ...f.labels })),
      warnings,
    };
  },
});
