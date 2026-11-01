// defineOp: definition-time checks and derived names.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DocRef, defaultCliCommand, defaultMcpName, defineOp } from '../src/index.js';
import type { OpSpec, Safety } from '../src/index.js';

const base = {
  name: 'test.doThing',
  safety: 'read' as Safety,
  summary: 'Do a thing.',
  input: z.strictObject({ doc: DocRef, n: z.int().optional() }),
  output: z.strictObject({ ok: z.boolean() }),
  examples: [{ title: 'one', input: { doc: 'doc_abc' }, output: { ok: true } }],
  handler: () => ({ ok: true }),
} as const;

type Spec = OpSpec<Safety, typeof base.input, typeof base.output>;
const define = (patch: Partial<Record<keyof Spec, unknown>>) => () =>
  defineOp({ ...base, ...patch } as Spec);

describe('defineOp', () => {
  it('derives MCP and CLI names', () => {
    expect(defaultMcpName('rig.setPose')).toBe('rig_set_pose');
    expect(defaultMcpName('doc.open')).toBe('doc_open');
    expect(defaultCliCommand('rig.setPose')).toEqual(['rig', 'set-pose']);
    const op = defineOp(base);
    expect(op).toMatchObject({
      mcpName: 'test_do_thing',
      cliCommand: ['test', 'do-thing'],
      targetsDocument: true,
      transactional: false,
    });
    expect(Object.isFrozen(op)).toBe(true);
    const custom = defineOp({ ...base, mcp: { name: 'thing' }, cli: { command: ['thing'] } });
    expect([custom.mcpName, custom.cliCommand]).toEqual(['thing', ['thing']]);
  });

  it('marks mutate ops transactional unless transaction: false', () => {
    expect(defineOp({ ...base, safety: 'mutate' }).transactional).toBe(true);
    expect(defineOp({ ...base, safety: 'destructive' }).transactional).toBe(true);
    expect(defineOp({ ...base, safety: 'mutate', transaction: false }).transactional).toBe(false);
  });

  it.each([
    [{ name: 'Test.thing' }, /area\.verbNoun/],
    [{ name: 'test' }, /area\.verbNoun/],
    [{ safety: 'write' }, /unknown safety/],
    [{ summary: '' }, /summary/],
    [{ summary: 'two\nlines' }, /summary/],
    [{ summary: 'x'.repeat(201) }, /summary/],
    [{ input: z.string() }, /zod object/],
    [
      {
        safety: 'mutate',
        input: z.strictObject({ n: z.int() }),
        examples: [{ title: 't', input: { n: 1 } }],
      },
      /"doc" input field/,
    ],
    [{ input: z.strictObject({ doc: DocRef, confirm: z.boolean() }) }, /reserved/],
    [{ transaction: false }, /only applies/],
    [{ mcp: { name: 'bad name' } }, /MCP tool name/],
    [{ cli: { command: [] } }, /CLI command/],
    [{ cli: { command: ['Bad'] } }, /CLI command/],
    [{ examples: [] }, /at least one example/],
    [{ examples: [{ title: ' ', input: { doc: 'doc_abc' } }] }, /no title/],
    [{ examples: [{ title: 't', input: { doc: 'nope' } }] }, /example 0 input is invalid/],
    [
      { examples: [{ title: 't', input: { doc: 'doc_a' }, output: { ok: 1 } }] },
      /example 0 output is invalid/,
    ],
  ])('rejects %j', (patch, message) => {
    expect(define(patch)).toThrow(message);
  });
});
