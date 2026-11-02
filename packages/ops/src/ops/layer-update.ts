/**
 * `layer.update`: rename a layer or change its visibility, opacity and export flag.
 * @packageDocumentation
 */
import { OPACITY_MAX, Name } from '@pixel-forge/schema';
import type { Layer } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { DocRef, LayerRef, resolveLayer, walkLayers } from '../refs.js';

/** The array holding the layer with this id, and its index. */
function locate(layers: Layer[], id: string): { siblings: Layer[]; index: number } | undefined {
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (l === undefined) continue;
    if (l.id === id) return { siblings: layers, index: i };
    if (l.kind === 'group') {
      const found = locate(l.children, id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** `layer.update` (MCP `layer_update`, CLI `pf layer update`). */
export const layerUpdate = defineOp({
  name: 'layer.update',
  safety: 'mutate',
  summary: 'Rename a layer, or set its visible flag, opacity (0..255) or export flag.',
  description:
    "Only the fields you give change. Names are lower-case a-z 0-9 _ - up to 48 characters and unique among siblings; a part layer's name is the part's name and must be unique in the document. A reference layer is never exported. Hidden or non-exported layers are skipped by export, lint and rig_bake. To hide a part on some frames only, key visible with rig_set_pose.",
  input: z.strictObject({
    doc: DocRef,
    layer: LayerRef,
    name: Name.optional().describe('New layer name.'),
    visible: z.boolean().optional().describe('Show or hide the layer in the editor render.'),
    opacity: z.int().min(0).max(OPACITY_MAX).optional().describe('Layer opacity, 0..255.'),
    export: z.boolean().optional().describe('Include the layer in exports and bakes.'),
  }),
  output: z.strictObject({
    layer: z.string().describe('Layer id.'),
    path: z.string().describe('Name path from the root afterwards (e.g. "body/arm").'),
    changed: z.array(z.string()).describe('Fields that changed; empty when nothing did.'),
  }),
  examples: [
    {
      title: "Hide the hero's head part from the editor render",
      input: { doc: 'doc_g1ed5q', layer: 'head', visible: false },
    },
  ],
  handler: (ctx, input) => {
    const { layer, path } = resolveLayer(ctx.doc, input.layer);
    if (
      input.name === undefined &&
      input.visible === undefined &&
      input.opacity === undefined &&
      input.export === undefined
    ) {
      throw new OpError('BAD_INPUT', 'layer.update needs a field to set', {
        issues: [{ path: '', message: 'give name, visible, opacity or export' }],
      });
    }
    if (input.export === true && layer.kind === 'reference') {
      throw new OpError('REFUSED', `${path} is a reference layer; it is never exported`, {
        reason: 'reference-layer',
        layer: layer.id,
      });
    }
    const all = walkLayers(ctx.doc);
    if (input.name !== undefined && input.name !== layer.name) {
      const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const sibling = all.find(
        (l) =>
          l.layer.id !== layer.id &&
          l.layer.name === input.name &&
          (l.path.includes('/') ? l.path.slice(0, l.path.lastIndexOf('/')) : '') === parentPath,
      );
      const samePart =
        layer.kind === 'part'
          ? all.find(
              (l) =>
                l.layer.id !== layer.id && l.layer.kind === 'part' && l.layer.name === input.name,
            )
          : undefined;
      const clash = sibling ?? samePart;
      if (clash !== undefined) {
        throw new OpError('REFUSED', `a layer named ${input.name} exists (${clash.path})`, {
          reason: 'name-taken',
          layer: clash.layer.id,
        });
      }
    }
    const changed: string[] = [];
    if (input.name !== undefined && input.name !== layer.name) changed.push('name');
    if (input.visible !== undefined && input.visible !== layer.visible) changed.push('visible');
    if (input.opacity !== undefined && input.opacity !== layer.opacity) changed.push('opacity');
    if (input.export !== undefined && input.export !== layer.export) changed.push('export');
    if (changed.length > 0) {
      ctx.tx.update((d) => {
        const at = locate(d.layers, layer.id);
        const target = at?.siblings[at.index];
        if (target === undefined) return;
        if (input.name !== undefined) target.name = input.name;
        if (input.visible !== undefined) target.visible = input.visible;
        if (input.opacity !== undefined) target.opacity = input.opacity;
        if (input.export !== undefined && target.kind !== 'reference') target.export = input.export;
      });
    }
    const after = walkLayers(ctx.doc).find((l) => l.layer.id === layer.id);
    return { layer: layer.id, path: after?.path ?? path, changed };
  },
});
