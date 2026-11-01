// Generators: MCP tool JSON, CLI metadata, OPERATIONS.md. The committed copies are checked by
// `pnpm gen:check`; these tests pin the shapes and the per-op contract every op must meet.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CONVENTIONS,
  DocRef,
  GENERATED_PATHS,
  cliMetadata,
  createRegistry,
  defineOp,
  docOpen,
  docSummary,
  generatedFiles,
  mcpTools,
  opInputSchema,
  operationsMarkdown,
  registry,
  rigSetPose,
  toJsonSchema,
  typeLabel,
} from '../src/index.js';
import type { JsonSchema } from '../src/index.js';

const wipe = defineOp({
  name: 'test.wipeAll',
  safety: 'destructive',
  summary: 'Wipe everything.',
  input: z.strictObject({
    doc: DocRef,
    mode: z.enum(['soft', 'hard']).describe('How hard.'),
    count: z.int().min(1).describe('How many.'),
    ratio: z.number().describe('A ratio.'),
    dry: z.boolean().default(false).describe('Dry run.'),
  }),
  output: z.int(),
  examples: [{ title: 'Wipe hard', input: { doc: 'doc_abc', mode: 'hard', count: 2, ratio: 0.5 } }],
  handler: () => 1,
});
const hidden = defineOp({
  name: 'test.hidden',
  safety: 'read',
  summary: 'Hidden everywhere.',
  input: z.strictObject({}),
  output: z.strictObject({}),
  examples: [{ title: 'x', input: {} }],
  mcp: { hidden: true },
  cli: { hidden: true },
  handler: () => ({}),
});
// A fixed op set, so adding built-in ops never breaks these shape tests.
const reg = createRegistry([docOpen, docSummary, rigSetPose, wipe, hidden]);

describe('mcpTools', () => {
  it('describes every visible op as an MCP tool', () => {
    const tools = mcpTools(reg);
    expect(tools.map((t) => t.name)).toEqual([
      'doc_open',
      'doc_summary',
      'rig_set_pose',
      'test_wipe_all',
    ]);
    const pose = tools.find((t) => t.name === 'rig_set_pose');
    expect(pose).toMatchObject({
      title: 'rig.setPose',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { 'pixel-forge/op': 'rig.setPose', 'pixel-forge/safety': 'mutate' },
      inputSchema: {
        type: 'object',
        required: ['doc', 'animation', 'frame'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
    });
    expect(pose?.description).toContain(CONVENTIONS);
    expect(pose?.description).toContain('one undo step');
    expect(pose?.description).toMatch(/Example \(Raise the right arm/);
    const json = JSON.stringify(tools);
    expect(json).not.toContain('$schema');
    expect(json).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(json).not.toContain('__proto__');
    expect(tools.find((t) => t.name === 'doc_summary')?.annotations.readOnlyHint).toBe(true);
  });

  it('adds confirm to destructive tools and omits non-object output schemas', () => {
    const t = mcpTools(reg).find((x) => x.name === 'test_wipe_all');
    expect(t?.annotations.destructiveHint).toBe(true);
    expect((t?.inputSchema.properties as Record<string, unknown>).confirm).toEqual({
      type: 'boolean',
      description: 'Must be true: this operation is destructive.',
    });
    expect(t?.inputSchema.required).not.toContain('dry');
    expect(t?.outputSchema).toBeUndefined();
    expect(t?.description).toContain('"confirm":true');
  });
});

describe('cliMetadata', () => {
  it('maps top-level fields to flags with kinds', () => {
    const meta = cliMetadata(reg);
    expect(meta.$comment).toMatch(/Do not edit/);
    expect(meta.commands.map((c) => c.command.join(' '))).toEqual([
      'doc open',
      'doc summary',
      'rig set-pose',
      'test wipe-all',
    ]);
    const w = meta.commands.find((c) => c.op === 'test.wipeAll');
    expect(w?.options).toEqual([
      {
        name: 'doc',
        flag: '--doc',
        kind: 'string',
        required: true,
        description: expect.any(String) as string,
      },
      {
        name: 'mode',
        flag: '--mode',
        kind: 'string',
        required: true,
        description: 'How hard.',
        choices: ['soft', 'hard'],
      },
      { name: 'count', flag: '--count', kind: 'integer', required: true, description: 'How many.' },
      { name: 'ratio', flag: '--ratio', kind: 'number', required: true, description: 'A ratio.' },
      { name: 'dry', flag: '--dry', kind: 'boolean', required: false, description: 'Dry run.' },
      {
        name: 'confirm',
        flag: '--confirm',
        kind: 'boolean',
        required: false,
        description: expect.any(String) as string,
      },
    ]);
    const pose = meta.commands.find((c) => c.op === 'rig.setPose');
    expect(pose?.options.find((o) => o.name === 'frame')?.kind).toBe('json');
  });
});

describe('operationsMarkdown', () => {
  it('documents safety classes, errors and every op', () => {
    const md = operationsMarkdown(reg);
    expect(md).toMatch(/^# Operations\n/);
    for (const op of ['doc.open', 'doc.summary', 'rig.setPose', 'test.wipeAll', 'test.hidden']) {
      expect(md).toContain(`\n## ${op}\n`);
    }
    expect(md).toContain('| `CONFIRM_REQUIRED` |');
    expect(md).toContain('[`rig.setPose`](#rigsetpose)');
    expect(md).toContain('"confirm":true');
    expect(md).toContain('- MCP tool: (hidden)');
    expect(md).toContain('(no fields)');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('notes ops that manage the history themselves', () => {
    const undo = defineOp({
      name: 'test.undo',
      safety: 'mutate',
      summary: 'Undo.',
      input: z.strictObject({ doc: DocRef }),
      output: z.strictObject({}),
      examples: [{ title: 'x', input: { doc: 'doc_a' } }],
      transaction: false,
      handler: () => ({}),
    });
    expect(operationsMarkdown(createRegistry([undo]))).toContain('no transaction');
  });
});

describe('helpers', () => {
  it('labels JSON Schema types', () => {
    const cases: [JsonSchema, string][] = [
      [{ type: 'string' }, 'string'],
      [{ type: 'integer', minimum: 0 }, 'integer >= 0'],
      [{ type: 'integer' }, 'integer'],
      [{ enum: ['a', 'b'] }, '"a" \\| "b"'],
      [{ const: true }, 'true'],
      [{ type: 'array', items: { type: 'number' } }, 'number[]'],
      [{ type: 'object', additionalProperties: { type: 'number' } }, 'map of number'],
      [{ type: 'object', properties: { x: {}, y: {} } }, '{x, y}'],
      [{ type: 'object' }, 'object'],
      [{ anyOf: [{ type: 'integer' }, { type: 'null' }] }, 'integer \\| null'],
      [{}, 'any'],
    ];
    for (const [schema, label] of cases) expect(typeLabel(schema)).toBe(label);
  });

  it('builds compact JSON Schemas and refuses unrepresentable ones', () => {
    expect(toJsonSchema(z.int(), 'output')).toEqual({ type: 'integer' });
    expect(
      toJsonSchema(z.strictObject({ a: z.int().default(1) }), 'input').required,
    ).toBeUndefined();
    expect(() => toJsonSchema(z.custom<string>(), 'input')).toThrow();
  });

  it('lists the generated files', () => {
    expect(generatedFiles(registry).map((f) => f.path)).toEqual([
      GENERATED_PATHS.mcpTools,
      GENERATED_PATHS.cli,
      GENERATED_PATHS.operations,
    ]);
  });
});

describe('every built-in op', () => {
  it.each(registry.list().map((op) => [op.name, op] as const))(
    '%s meets the op contract (described fields, object schemas)',
    (_name, op) => {
      const input = opInputSchema(op);
      expect(input.type).toBe('object');
      for (const [field, prop] of Object.entries(input.properties as Record<string, JsonSchema>)) {
        expect(typeof prop.description, `${op.name}.${field} needs .describe()`).toBe('string');
      }
      expect(toJsonSchema(op.output, 'output').type).toBe('object');
      expect(op.summary.length).toBeLessThanOrEqual(200);
    },
  );
});
