/**
 * `doc.redo`: re-apply the newest undone history entry of one document (MCP `redo`).
 * @packageDocumentation
 */
import { z } from 'zod';
import { defineOp } from '../define.js';
import { DocRef } from '../refs.js';

/** `doc.redo` (MCP `redo`, CLI `pf doc redo`). A history op: it runs without a transaction. */
export const docRedo = defineOp({
  name: 'doc.redo',
  safety: 'mutate',
  transaction: false,
  summary: 'Redo the newest undone change of the document (one history entry).',
  description:
    'Re-applies the entry that the last doc.undo reverted. A new change clears the redo entries. Nothing to redo is not an error: redone is false.',
  mcp: { name: 'redo' },
  input: z.strictObject({
    doc: DocRef,
  }),
  output: z.strictObject({
    redone: z
      .boolean()
      .describe('True when an entry was re-applied; false when there was nothing to redo.'),
    label: z
      .string()
      .nullable()
      .describe(
        'Label of the re-applied entry (for example "AI: rig.setPose"); null when nothing was redone.',
      ),
  }),
  examples: [
    {
      title: 'Redo on a fresh open (nothing to redo)',
      input: { doc: 'doc_g1ed5q' },
      output: { redone: false, label: null },
    },
  ],
  handler: (ctx) => {
    const event = ctx.document.store.redo();
    return { redone: event !== undefined, label: event?.label ?? null };
  },
});
