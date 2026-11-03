/**
 * `doc.undo`: revert the newest applied history entry of one document (MCP `undo`).
 * @packageDocumentation
 */
import { z } from 'zod';
import { defineOp } from '../define.js';
import { DocRef } from '../refs.js';

/** `doc.undo` (MCP `undo`, CLI `pf doc undo`). A history op: it runs without a transaction. */
export const docUndo = defineOp({
  name: 'doc.undo',
  safety: 'mutate',
  group: 'core',
  transaction: false,
  summary: 'Undo the newest applied change of the document (one history entry).',
  description:
    'Reverts the last applied history entry, whatever tool made it. Nothing to undo is not an error: undone is false. Re-apply with redo.',
  mcp: { name: 'undo' },
  input: z.strictObject({
    doc: DocRef,
  }),
  output: z.strictObject({
    undone: z
      .boolean()
      .describe('True when an entry was reverted; false when there was nothing to undo.'),
    label: z
      .string()
      .nullable()
      .describe(
        'Label of the reverted entry (for example "AI: rig.setPose"); null when nothing was undone.',
      ),
  }),
  examples: [
    {
      title: 'Undo the last change of the hero (nothing to undo on a fresh open)',
      input: { doc: 'doc_g1ed5q' },
      output: { undone: false, label: null },
    },
  ],
  handler: (ctx) => {
    const event = ctx.document.store.undo();
    return { undone: event !== undefined, label: event?.label ?? null };
  },
});
