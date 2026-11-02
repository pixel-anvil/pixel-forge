/**
 * `@pixel-forge/schema`: the domain model (spec 3) and file contracts (spec 7) as zod schemas with
 * inferred types, branded ids with a deterministic generator, references and constants.
 *
 * Each schema and its inferred type share a name (`Document` is both). Parsing validates structure
 * only (types, ranges, names, integers, finite angles) and never adds defaults, so a parsed value
 * equals its input. Cross-references (I1-I4, I6) are checked by `core`'s `validate()`.
 * @packageDocumentation
 */

/** Package identifier, used by the scaffold smoke test. */
export const schemaPackage = '@pixel-forge/schema' as const;

export * from './constants.js';
export * from './ids.js';
export * from './primitives.js';
export * from './palette.js';
export * from './layers.js';
export * from './rig.js';
export * from './animation.js';
export * from './document.js';
export * from './refs.js';
export * from './render.js';
export * from './json-schema.js';
