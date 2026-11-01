/**
 * The safety classes of the op API (FR-AI-01), in their own module so `define` and `context` share
 * them without an import cycle.
 * @packageDocumentation
 */

/**
 * Safety classes (FR-AI-01):
 *
 * - `read`: looks at a document or the host, changes nothing. Synchronous.
 * - `mutate`: changes one document inside **one transaction = one undo step**, labelled
 *   `AI: <op>` (FR-AI-14). Synchronous; edits only through `ctx.tx`.
 * - `destructive`: like `mutate`, but the caller must pass `confirm: true` (the registry adds the
 *   field and refuses with `CONFIRM_REQUIRED` without it).
 * - `io`: reads or writes files through the host ports (open, save, import, export). May be
 *   asynchronous; may change its document once through `ctx.transact`.
 */
export const SAFETY_CLASSES = ['read', 'mutate', 'destructive', 'io'] as const;

/** A safety class (see {@link SAFETY_CLASSES}). */
export type Safety = (typeof SAFETY_CLASSES)[number];
