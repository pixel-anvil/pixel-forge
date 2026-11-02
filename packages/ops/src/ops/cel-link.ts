/**
 * `cel.link`: link a cel to another frame's cel, unlink it, or link identical cels.
 * @packageDocumentation
 */
import { imageHash, referencedImages } from '@pixel-forge/core';
import type { Cel, FrameId, ImageId, Layer } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import type { OpContext } from '../context.js';
import { OpError } from '../errors.js';
import {
  AnimRef,
  DocRef,
  FrameRef,
  LayerRef,
  resolveAuthoredAnimation,
  resolveFrame,
  resolveLayer,
} from '../refs.js';
import type { ReadonlyDocument } from '../refs.js';

type CelLayer = Extract<Layer, { cels: unknown }>;

/** The cel map of the layer with this id, in a draft. */
function celsOf(layers: Layer[], id: string): CelLayer['cels'] | undefined {
  for (const l of layers) {
    if (l.id === id) return 'cels' in l ? l.cels : undefined;
    if (l.kind === 'group') {
      const found = celsOf(l.children, id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

const refuse = (reason: string, message: string, extra: Record<string, unknown> = {}): OpError =>
  new OpError('REFUSED', message, { reason, ...extra });

const frameOf = (doc: ReadonlyDocument, anim: AnimRef, frame: FrameRef): FrameId =>
  resolveFrame(resolveAuthoredAnimation(doc, anim).animation, frame).frame.id;

/** Deletes the images in `candidates` that nothing references any more. */
function dropOrphans(ctx: OpContext, candidates: Iterable<ImageId>): void {
  const still = referencedImages(ctx.tx.doc);
  for (const id of candidates) {
    if (!still.has(id) && ctx.tx.image(id) !== undefined) ctx.tx.deleteImage(id);
  }
}

/** `cel.link` (MCP `cel_link`, CLI `pf cel link`). */
export const celLink = defineOp({
  name: 'cel.link',
  safety: 'mutate',
  summary:
    'Link a layer\'s cel to another frame\'s cel (mode "link"), make a linked cel independent ("unlink"), or link all identical cels ("linkIdentical").',
  description:
    'A linked cel shows the same pixels as its target; links cross animations, one hop (a link to a link goes to its target). "link": animation, frame (the cel that becomes the link), source.frame (source.animation defaults to animation). "unlink" copies the pixels into the cel. "linkIdentical" links, per layer, every cel with identical pixels, offset and opacity to the first in document order. Pixel layers only: part layers have no cels.',
  input: z.strictObject({
    doc: DocRef,
    layer: LayerRef,
    mode: z.enum(['link', 'unlink', 'linkIdentical']).describe('What to do.'),
    animation: AnimRef.optional().describe(
      'link/unlink: animation of the cel. linkIdentical: limits the scan (default: all).',
    ),
    frame: FrameRef.optional().describe("link/unlink: the cel's frame."),
    source: z
      .strictObject({
        animation: AnimRef.optional().describe(
          'Animation of the source frame (default: animation).',
        ),
        frame: FrameRef,
      })
      .optional()
      .describe('link: the frame whose cel is shown.'),
  }),
  output: z.strictObject({
    mode: z.enum(['link', 'unlink', 'linkIdentical']),
    changed: z.int().describe('Cels that were linked or unlinked (0 for a no-op).'),
    imagesDeleted: z.int().describe('Images that nothing used any more.'),
  }),
  examples: [
    {
      title: 'Link the hero layer cels that have identical pixels',
      input: { doc: 'doc_g1ed5q', layer: 'body', mode: 'linkIdentical' },
    },
  ],
  handler: (ctx, input) => {
    const { layer, path } = resolveLayer(ctx.doc, input.layer);
    if (!('cels' in layer)) {
      throw refuse('no-cels', `${path} has no cels (kind ${layer.kind})`, { layer: layer.id });
    }
    const layerId = layer.id;
    const imagesBefore = ctx.tx.imageIds().length;
    const need = <T>(v: T | undefined, what: string): T => {
      if (v === undefined) {
        throw new OpError('BAD_INPUT', `mode "${input.mode}" needs "${what}"`, {
          issues: [{ path: what, message: 'required for this mode' }],
        });
      }
      return v;
    };
    let changed = 0;

    if (input.mode === 'link') {
      const animation = need(input.animation, 'animation');
      const source = need(input.source, 'source');
      const dest = frameOf(ctx.doc, animation, need(input.frame, 'frame'));
      const from = frameOf(ctx.doc, source.animation ?? animation, source.frame);
      if (dest === from) throw refuse('self-link', 'a cel cannot link to itself');
      const cels = layer.cels as Readonly<Record<string, Cel>>;
      const srcCel = cels[from];
      if (srcCel === undefined) {
        throw refuse('no-source-cel', `${path} has no cel at the source frame`, { frame: from });
      }
      const target = 'linkTo' in srcCel ? srcCel.linkTo : from;
      if (target === dest) throw refuse('self-link', 'the source cel already links to this cel');
      const old = cels[dest];
      if (old !== undefined && 'linkTo' in old && old.linkTo === target) {
        return { mode: input.mode, changed: 0, imagesDeleted: 0 };
      }
      if (
        old !== undefined &&
        'imageId' in old &&
        Object.values(cels).some((c) => 'linkTo' in c && c.linkTo === dest)
      ) {
        throw refuse('linked-from', 'other cels link to this cel; unlink or relink them first', {
          frame: dest,
        });
      }
      ctx.tx.update((d) => {
        const target2 = celsOf(d.layers, layerId);
        if (target2 !== undefined) target2[dest] = { linkTo: target };
      });
      if (old !== undefined && 'imageId' in old) dropOrphans(ctx, [old.imageId]);
      changed = 1;
    } else if (input.mode === 'unlink') {
      const dest = frameOf(ctx.doc, need(input.animation, 'animation'), need(input.frame, 'frame'));
      const cels = layer.cels as Readonly<Record<string, Cel>>;
      const cel = cels[dest];
      if (cel === undefined)
        throw refuse('no-cel', `${path} has no cel at that frame`, { frame: dest });
      if ('linkTo' in cel) {
        const owner = cels[cel.linkTo];
        const image =
          owner !== undefined && 'imageId' in owner ? ctx.tx.image(owner.imageId) : undefined;
        if (owner === undefined || !('imageId' in owner) || image === undefined) {
          throw refuse('broken-link', 'the link target has no drawing', { frame: dest });
        }
        const copy = ctx.tx.createImage(image);
        ctx.tx.update((d) => {
          const target = celsOf(d.layers, layerId);
          if (target !== undefined) {
            target[dest] = {
              imageId: copy,
              offset: { x: owner.offset.x, y: owner.offset.y },
              opacity: owner.opacity,
            };
          }
        });
        changed = 1;
      }
    } else {
      const scope =
        input.animation === undefined
          ? ctx.doc.animations
          : [resolveAuthoredAnimation(ctx.doc, input.animation).animation];
      const order: FrameId[] = [];
      for (const a of scope) {
        if ('frames' in a) for (const f of a.frames) order.push(f.id);
      }
      const cels = layer.cels as Readonly<Record<string, Cel>>;
      const first = new Map<string, FrameId>();
      const relink = new Map<FrameId, FrameId>();
      for (const f of order) {
        const cel = cels[f];
        if (cel === undefined || !('imageId' in cel)) continue;
        const image = ctx.tx.image(cel.imageId);
        if (image === undefined) continue;
        const key = `${imageHash(image)}|${String(cel.offset.x)},${String(cel.offset.y)}|${String(cel.opacity)}`;
        const keep = first.get(key);
        if (keep === undefined) first.set(key, f);
        else relink.set(f, keep);
      }
      if (relink.size > 0) {
        const gone = [...relink.keys()].flatMap((f) => {
          const c = cels[f];
          return c !== undefined && 'imageId' in c ? [c.imageId] : [];
        });
        ctx.tx.update((d) => {
          const target = celsOf(d.layers, layerId);
          if (target === undefined) return;
          for (const [f, keep] of relink) target[f] = { linkTo: keep };
          for (const [k, c] of Object.entries(target)) {
            if ('linkTo' in c) {
              const to = relink.get(c.linkTo);
              if (to !== undefined) target[k as FrameId] = { linkTo: to };
            }
          }
        });
        dropOrphans(ctx, gone);
        changed = relink.size;
      }
    }
    return {
      mode: input.mode,
      changed,
      imagesDeleted: Math.max(0, imagesBefore - ctx.tx.imageIds().length),
    };
  },
});
