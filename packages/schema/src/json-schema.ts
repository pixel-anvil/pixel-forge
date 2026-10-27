/**
 * JSON Schema (draft 2020-12) export of the file contracts, via zod's `z.toJSONSchema`. Pure: each
 * call builds a fresh schema. Refinements (canonical remaps, angle quanta, non-empty keys,
 * override set/erase, unique render skins, the layer depth limit) are not representable in JSON
 * Schema and are omitted; zod parsing is the authority.
 * @packageDocumentation
 */
import { z } from 'zod';
import { Document } from './document.js';
import { Layer } from './layers.js';
import { Manifest, RenderIndex } from './render.js';

/** A JSON Schema object as produced by zod. */
export type JsonSchema = z.core.JSONSchema.BaseSchema;

const toJsonSchema = (schema: z.ZodType): JsonSchema => {
  const metadata = z.registry<{ id: string }>();
  // `Layer.out` is the recursive structure; the depth pre-check in `Layer.in` has no JSON Schema form.
  metadata.add(Layer.out, { id: 'Layer' });
  return z.toJSONSchema(schema, { metadata, target: 'draft-2020-12' });
};

/** JSON Schema of `document.json`. */
export function documentJsonSchema(): JsonSchema {
  return toJsonSchema(Document);
}

/** JSON Schema of `render/index.json`. */
export function renderIndexJsonSchema(): JsonSchema {
  return toJsonSchema(RenderIndex);
}

/** JSON Schema of `manifest.json`. */
export function manifestJsonSchema(): JsonSchema {
  return toJsonSchema(Manifest);
}
