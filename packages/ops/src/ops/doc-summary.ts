/**
 * `doc.summary`: a compact overview of one open document (layers, rig, animations), the first
 * thing an LLM reads after `doc.open` (also served as the MCP resource `pf://doc/{id}/summary`).
 * @packageDocumentation
 */
import { ColorMode, LoopMode } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { DocRef, animationLabel, partNamer, walkLayers } from '../refs.js';

const Size = z.strictObject({ w: z.int(), h: z.int() });
const Point = z.strictObject({ x: z.int(), y: z.int() });

/** The output of `doc.summary`. */
export const DocSummary = z.strictObject({
  doc: z.string().describe('Document id.'),
  name: z.string(),
  path: z.string().nullable().describe('Backing file, null for an unsaved document.'),
  version: z.int().describe('Runtime version: +1 per change, undo and redo.'),
  dirty: z.boolean().describe('Changed (or undone/redone) since it was opened or last saved.'),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  canvas: Size,
  origin: Point.describe('Anchor pixel shared with the engine (mirroring flips about origin.x).'),
  pixelsPerUnit: z.number(),
  colorMode: ColorMode,
  paletteLocked: z.boolean(),
  palette: z
    .strictObject({ name: z.string(), colors: z.int() })
    .nullable()
    .describe('The active palette, null when there is none.'),
  skins: z.array(z.string()),
  layers: z
    .array(
      z.strictObject({
        id: z.string(),
        path: z.string().describe('Names from the root, joined by "/".'),
        kind: z.enum(['pixel', 'reference', 'part', 'group']),
        visible: z.boolean(),
      }),
    )
    .describe('Every layer, depth first, bottom to top.'),
  rig: z
    .strictObject({
      bones: z.array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          parent: z.string().nullable(),
          length: z.int(),
        }),
      ),
      parts: z.array(
        z.strictObject({
          id: z.string(),
          name: z.string().describe('Part-layer name: how ops address the part.'),
          bone: z.string(),
          variants: z.array(z.string()),
        }),
      ),
      views: z.array(
        z.strictObject({ id: z.string(), name: z.string(), directions: z.array(z.string()) }),
      ),
    })
    .nullable()
    .describe('Null when the document has no rig.'),
  animations: z.array(
    z.strictObject({
      id: z.string(),
      label: z.string().describe('"group/direction", or "group" when undirected.'),
      group: z.string(),
      direction: z.string().nullable(),
      loop: LoopMode,
      frames: z.int().describe('Frame count (the source animation for a mirror).'),
      durationMs: z.int().describe('Total duration.'),
      mirrorOf: z.string().nullable().describe('Label of the source animation of a mirror.'),
      overrides: z.int(),
    }),
  ),
});

/** `doc.summary` (MCP `doc_summary`, CLI `pf doc summary`). */
export const docSummary = defineOp({
  name: 'doc.summary',
  safety: 'read',
  summary:
    'Summarise an open document: canvas, palette, layers, rig (bones, parts, views) and animations.',
  description:
    'Names in the result (bones, parts, layers, animation group/direction) are what the other tools take as references. It shows no rest angles and no pose keys: for pivots and tips as numbers use render_frame with bones: true.',
  input: z.strictObject({ doc: DocRef }),
  output: DocSummary,
  examples: [{ title: 'Summarise the hero', input: { doc: 'doc_g1ed5q' } }],
  handler: (ctx) => {
    const { doc } = ctx;
    const { store, path, savedVersion } = ctx.document;
    const rig = doc.rig;
    const nameOfPart = partNamer(doc);
    const boneName = new Map(rig?.bones.map((b) => [b.id, b.name]));
    const palette = doc.palettes.find((p) => p.id === doc.activePaletteId);
    return {
      doc: doc.meta.id,
      name: doc.meta.name,
      path: path ?? null,
      version: store.version,
      dirty: savedVersion === undefined || savedVersion !== store.version,
      canUndo: store.canUndo,
      canRedo: store.canRedo,
      canvas: { w: doc.meta.canvas.w, h: doc.meta.canvas.h },
      origin: { x: doc.meta.origin.x, y: doc.meta.origin.y },
      pixelsPerUnit: doc.meta.pixelsPerUnit,
      colorMode: doc.meta.colorMode,
      paletteLocked: doc.meta.paletteLocked,
      palette: palette === undefined ? null : { name: palette.name, colors: palette.colors.length },
      skins: doc.skins.map((s) => s.name),
      layers: walkLayers(doc).map(({ layer, path: p }) => ({
        id: layer.id,
        path: p,
        kind: layer.kind,
        visible: layer.visible,
      })),
      rig:
        rig === undefined
          ? null
          : {
              bones: rig.bones.map((b) => ({
                id: b.id,
                name: b.name,
                parent: b.parentId === undefined ? null : (boneName.get(b.parentId) ?? b.parentId),
                length: b.length,
              })),
              parts: rig.parts.map((p) => ({
                id: p.id,
                name: nameOfPart(p),
                bone: boneName.get(p.boneId) ?? p.boneId,
                variants: p.variants.map((v) => v.name),
              })),
              views: rig.views.map((v) => ({
                id: v.id,
                name: v.name,
                directions: [...v.directions],
              })),
            },
      animations: doc.animations.map((a) => {
        const source = 'mirrorOf' in a ? doc.animations.find((s) => s.id === a.mirrorOf) : a;
        const frames = source !== undefined && 'frames' in source ? source.frames : [];
        return {
          id: a.id,
          label: animationLabel(a),
          group: a.group,
          direction: a.direction ?? null,
          loop: source !== undefined && 'loop' in source ? source.loop : 'loop',
          frames: frames.length,
          durationMs: frames.reduce((sum, f) => sum + f.durationMs, 0),
          mirrorOf:
            'mirrorOf' in a ? (source === undefined ? a.mirrorOf : animationLabel(source)) : null,
          overrides: a.overrides.length,
        };
      }),
    };
  },
});
