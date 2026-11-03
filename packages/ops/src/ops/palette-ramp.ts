/**
 * `palette.ramp`: generate a colour ramp (shadows cool, lights warm) and optionally add it.
 * @packageDocumentation
 */
import { MAX_RAMP_STEPS, generateRamp, insertRamp } from '@pixel-forge/color';
import { Name } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { HexColor, toHex } from '../grid.js';
import { colorOf, storePalette, targetPalette } from '../palette-target.js';
import { DocRef } from '../refs.js';

const Unit = z.number().min(0).max(1);

/** `palette.ramp` (MCP `palette_ramp`, CLI `pf palette ramp`). */
export const paletteRamp = defineOp({
  name: 'palette.ramp',
  safety: 'mutate',
  group: 'palette',
  summary: 'Generate a dark-to-light colour ramp from a base colour; optionally add it.',
  description:
    'OKLab ramp, step 0 darkest. Shadows turn toward blue, lights toward yellow by up to hueShift degrees; the base colour stays exact at baseIndex. Without add: true it only returns the colours. add inserts them (at, default the end) and records a named ramp; an indexed document keeps its pixels.',
  input: z.strictObject({
    doc: DocRef,
    base: HexColor.describe('Base colour.'),
    steps: z.int().min(1).max(MAX_RAMP_STEPS).describe('Colours in the ramp.'),
    baseIndex: z
      .int()
      .min(0)
      .max(MAX_RAMP_STEPS - 1)
      .optional()
      .describe('Where the base sits (default: middle).'),
    hueShift: z
      .number()
      .min(0)
      .max(180)
      .optional()
      .describe('Largest hue turn at the ends, degrees (default 20; 0 = none).'),
    satShift: z
      .number()
      .min(-1)
      .max(1)
      .optional()
      .describe('Chroma change at the ends: shadows x(1-s), lights x(1+s) (default 0).'),
    lightRange: z
      .tuple([Unit, Unit])
      .optional()
      .describe('OKLab lightness [darkest, lightest] (default from the base).'),
    coolHue: z
      .number()
      .min(0)
      .max(360)
      .optional()
      .describe('Shadow hue target, OKLCH degrees (default 265).'),
    warmHue: z
      .number()
      .min(0)
      .max(360)
      .optional()
      .describe('Light hue target, OKLCH degrees (default 90).'),
    add: z
      .boolean()
      .optional()
      .describe('Add the ramp to the active palette (default false: only return it).'),
    at: z.int().min(0).max(256).optional().describe('With add: insert here (default: the end).'),
    name: Name.optional().describe('With add: ramp name (default "ramp1", "ramp2"...).'),
  }),
  output: z.strictObject({
    colors: z.array(z.string()).describe('The ramp, dark to light, "#rrggbb[aa]".'),
    indices: z.array(z.int()).optional().describe('Palette indices of the new colours (with add).'),
    ramp: z.string().optional().describe('Name of the recorded ramp (with add).'),
    warning: z.string().optional(),
  }),
  examples: [
    {
      title: 'A 5-colour skin ramp, added to the palette',
      input: { doc: 'doc_g1ed5q', base: '#c8503c', steps: 5, add: true, name: 'skin' },
    },
  ],
  handler: (ctx, input) => {
    if (input.add !== true && (input.at !== undefined || input.name !== undefined)) {
      throw new OpError('BAD_INPUT', '"at" and "name" only apply with add: true', {
        issues: [{ path: input.at === undefined ? 'name' : 'at', message: 'needs add: true' }],
      });
    }
    let ramp;
    try {
      ramp = generateRamp({
        base: colorOf(input.base),
        steps: input.steps,
        ...(input.baseIndex === undefined ? {} : { baseIndex: input.baseIndex }),
        ...(input.hueShift === undefined ? {} : { hueShift: input.hueShift }),
        ...(input.satShift === undefined ? {} : { satShift: input.satShift }),
        ...(input.lightRange === undefined ? {} : { lightRange: input.lightRange }),
        ...(input.coolHue === undefined ? {} : { coolHue: input.coolHue }),
        ...(input.warmHue === undefined ? {} : { warmHue: input.warmHue }),
      });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new OpError('BAD_INPUT', error.message, {
        issues: [{ path: '', message: error.message }],
      });
    }
    const colors = ramp.map((c) => toHex(c));
    if (input.add !== true) return { colors };
    const target = targetPalette(ctx, true);
    let name = input.name;
    if (name === undefined) {
      const taken = new Set(target.palette.ramps.map((r) => r.name));
      let n = target.palette.ramps.length + 1;
      while (taken.has(`ramp${String(n)}`)) n++;
      name = `ramp${String(n)}`;
    }
    const at = input.at ?? target.palette.colors.length;
    let edit;
    try {
      edit = insertRamp(target.palette, ramp, { at, name });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new OpError('BAD_INPUT', error.message, {
        issues: [{ path: input.at === undefined ? 'steps' : 'at', message: error.message }],
      });
    }
    const done = storePalette(ctx, target, edit.palette, edit.remap, false);
    return {
      colors,
      indices: ramp.map((_, i) => at + i),
      ramp: name,
      ...(done.warning === undefined ? {} : { warning: done.warning }),
    };
  },
});
