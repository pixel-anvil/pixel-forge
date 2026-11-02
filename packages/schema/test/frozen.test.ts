import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Document, SCHEMA_VERSION } from '../src/index.js';
import { sortedPrettyJson } from './helpers.js';

const frozenUrl = new URL('../../../fixtures/frozen/v1/minimal-document.json', import.meta.url);
const text = readFileSync(frozenUrl, 'utf8');

describe('frozen v1 document (fixtures/frozen/v1/minimal-document.json)', () => {
  it('still parses with the current Document schema', () => {
    const result = Document.safeParse(JSON.parse(text));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(result.data?.meta.schemaVersion).toBe(1);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('round-trips byte for byte: parse -> sorted pretty JSON equals the committed file', () => {
    const parsed = Document.parse(JSON.parse(text));
    expect(parsed).toStrictEqual(JSON.parse(text));
    expect(sortedPrettyJson(parsed)).toBe(text);
  });

  it('is committed in canonical form: LF line ends, trailing newline, sorted keys', () => {
    expect(text).not.toContain('\r');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(sortedPrettyJson(JSON.parse(text))).toBe(text);
  });
});
