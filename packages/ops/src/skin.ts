/**
 * Skin references for the render ops.
 * @packageDocumentation
 */
import type { SkinRef } from '@pixel-forge/core';
import { z } from 'zod';
import { OpError } from './errors.js';
import type { ReadonlyDocument } from './refs.js';

/** A skin by id (`skn_...`) or name; omit for the base (unskinned) render. */
export const SkinArg = z
  .string()
  .min(1)
  .describe('Skin name or id ("skn_..."); omit for the base render.');

/**
 * Resolves a {@link SkinArg} (id first, then name) to the reference `renderFrame` takes.
 * @throws OpError `NOT_FOUND` (`kind: 'skin'`, `available`: the skin names).
 */
export function resolveSkin(doc: ReadonlyDocument, ref: string | undefined): SkinRef | undefined {
  if (ref === undefined) return undefined;
  const byId = doc.skins.find((s) => s.id === ref);
  if (byId !== undefined) return { id: byId.id };
  const byName = doc.skins.find((s) => s.name === ref);
  if (byName !== undefined) return { id: byName.id };
  throw new OpError(
    'NOT_FOUND',
    `no skin "${ref}"; the document has ${doc.skins.length === 0 ? 'none' : doc.skins.map((s) => s.name).join(', ')}`,
    { kind: 'skin', ref, available: doc.skins.map((s) => s.name) },
  );
}
