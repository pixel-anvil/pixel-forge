/**
 * Canonical JSON text of the `.pxf` JSON entries (NFR-03): keys sorted by UTF-16 code unit at every
 * level, 2-space indent, LF line ends, one trailing newline. Arrays keep their order.
 * @packageDocumentation
 */
import { strFromU8, strToU8 } from 'fflate';
import { IoError } from '../errors.js';

function ser(v: unknown, indent: string, path: string): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new IoError('BAD_INPUT', `non-finite number at ${path}`);
    return JSON.stringify(v);
  }
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const items = v.map((x: unknown, i) => `${inner}${ser(x, inner, `${path}[${String(i)}]`)}`);
    return `[\n${items.join(',\n')}\n${indent}]`;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // Own keys sorted by code unit, set explicitly so integer-like keys are sorted as text too.
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (keys.length === 0) return '{}';
    const items = keys.map(
      (k) => `${inner}${JSON.stringify(k)}: ${ser(o[k], inner, `${path}.${k}`)}`,
    );
    return `{\n${items.join(',\n')}\n${indent}}`;
  }
  throw new IoError('BAD_INPUT', `value at ${path} is not JSON`);
}

/** The canonical `.pxf` JSON text of `value` (see the module comment), ending in a newline. */
export function canonicalPretty(value: unknown): string {
  return `${ser(value, '', '$')}\n`;
}

/** UTF-8 bytes of {@link canonicalPretty}. */
export function canonicalBytes(value: unknown): Uint8Array {
  return strToU8(canonicalPretty(value));
}

/** Parses UTF-8 JSON bytes; `what` names the entry in the error. */
export function parseJsonBytes(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(strFromU8(bytes)) as unknown;
  } catch (e) {
    throw new IoError('BAD_PXF', `${what} is not valid JSON`, { cause: e });
  }
}
