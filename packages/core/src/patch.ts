/**
 * Structural patches: an ordered list of JSON-patch style operations with before/after values, the
 * diff that produces them, and the batch applier used by transactions, undo and redo.
 * @packageDocumentation
 */
import { CoreError } from './errors.js';
import { checkPath, childOf, formatPath, isContainer, jsonEqual, sealNode } from './json.js';
import type { JsonArray, JsonContainer, JsonObject, JsonPath, JsonValue } from './json.js';

/**
 * Adds a value: a new object key, or an array element inserted at index `path[-1]` (later elements
 * shift right; the index may equal the length to append). Inverse: `remove`.
 */
export interface AddOp {
  readonly op: 'add';
  readonly path: JsonPath;
  readonly after: JsonValue;
}

/**
 * Removes a value: an object key, or the array element at index `path[-1]` (later elements shift left).
 * `before` is the removed value. Inverse: `add`.
 */
export interface RemoveOp {
  readonly op: 'remove';
  readonly path: JsonPath;
  readonly before: JsonValue;
}

/** Replaces the existing value at `path` (an object key, an array index, or the root `[]`). */
export interface ReplaceOp {
  readonly op: 'replace';
  readonly path: JsonPath;
  readonly before: JsonValue;
  readonly after: JsonValue;
}

/**
 * One structural operation (RFC 6902 `add` / `remove` / `replace` semantics, with the path as an
 * array and the old value kept so the operation can be inverted). Values are sealed (frozen) JSON,
 * shared by reference with the documents they came from.
 */
export type StructuralOp = AddOp | RemoveOp | ReplaceOp;

/** The inverse of one operation. */
export function invertOp(op: StructuralOp): StructuralOp {
  switch (op.op) {
    case 'add':
      return { op: 'remove', path: op.path, before: op.after };
    case 'remove':
      return { op: 'add', path: op.path, after: op.before };
    case 'replace':
      return { op: 'replace', path: op.path, before: op.after, after: op.before };
  }
}

/** The inverse of an ordered list: each operation inverted, in reverse order. */
export function invertOps(ops: readonly StructuralOp[]): StructuralOp[] {
  return ops.map(invertOp).reverse();
}

function hasId(v: JsonValue): v is JsonObject & { readonly id: JsonValue } {
  return isContainer(v) && !Array.isArray(v) && Object.hasOwn(v, 'id');
}

/**
 * Minimal, deterministic diff from `a` to `b`, appended to `out`. Identical references are skipped
 * at once, so the cost is proportional to the nodes that were copied, not to the document.
 *
 * - Objects: keys in sorted order; a missing key is `add` / `remove`, a changed value recurses.
 * - Arrays: the common prefix and suffix are skipped, the remaining elements are paired by position
 *   (recursing, except objects whose `id` differs, which are replaced whole), then the surplus is
 *   removed or added. One insertion, deletion or element edit gives exactly one operation.
 * - Anything else (a primitive, or a change of kind) is a `replace`.
 */
export function diff(a: JsonValue, b: JsonValue, path: JsonPath, out: StructuralOp[]): void {
  if (a === b) return;
  if (isContainer(a) && isContainer(b)) {
    const arrA = Array.isArray(a);
    if (arrA === Array.isArray(b)) {
      if (arrA) diffArray(a as JsonArray, b as JsonArray, path, out);
      else diffObject(a as JsonObject, b as JsonObject, path, out);
      return;
    }
  }
  out.push({ op: 'replace', path, before: a, after: b });
}

function diffObject(a: JsonObject, b: JsonObject, path: JsonPath, out: StructuralOp[]): void {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    const inA = Object.hasOwn(a, k);
    const inB = Object.hasOwn(b, k);
    const p = [...path, k];
    if (inA && inB) diff(a[k] as JsonValue, b[k] as JsonValue, p, out);
    else if (inA) out.push({ op: 'remove', path: p, before: a[k] as JsonValue });
    else out.push({ op: 'add', path: p, after: b[k] as JsonValue });
  }
}

function diffArray(a: JsonArray, b: JsonArray, path: JsonPath, out: StructuralOp[]): void {
  let start = 0;
  while (
    start < a.length &&
    start < b.length &&
    jsonEqual(a[start] as JsonValue, b[start] as JsonValue)
  ) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (
    endA > start &&
    endB > start &&
    jsonEqual(a[endA - 1] as JsonValue, b[endB - 1] as JsonValue)
  ) {
    endA--;
    endB--;
  }
  const lenA = endA - start;
  const lenB = endB - start;
  const paired = Math.min(lenA, lenB);
  for (let i = 0; i < paired; i++) {
    const x = a[start + i] as JsonValue;
    const y = b[start + i] as JsonValue;
    const p = [...path, start + i];
    if (hasId(x) && hasId(y) && !jsonEqual(x.id, y.id))
      out.push({ op: 'replace', path: p, before: x, after: y });
    else diff(x, y, p, out);
  }
  for (let i = paired; i < lenA; i++) {
    out.push({ op: 'remove', path: [...path, start + paired], before: a[start + i] as JsonValue });
  }
  for (let i = paired; i < lenB; i++) {
    out.push({ op: 'add', path: [...path, start + i], after: b[start + i] as JsonValue });
  }
}

function conflict(op: StructuralOp, message: string): CoreError {
  return new CoreError('PATCH_CONFLICT', `${op.op} ${formatPath(op.path)}: ${message}`, {
    path: [...op.path],
  });
}

/**
 * Applies `ops` in order to the sealed tree `root` and returns the new sealed root. Containers on the
 * paths are copied once per call (not once per operation) and frozen at the end; everything else is
 * shared with `root`. All values in `ops` must be sealed. With `strict`, the current value must equal
 * `before` (`replace`, `remove`) and an `add` on an object key needs the key to be absent; a mismatch
 * throws `PATCH_CONFLICT`. Without `strict` (transaction edits), structural problems throw `BAD_PATH`.
 */
export function applyOps(
  root: JsonValue,
  ops: readonly StructuralOp[],
  strict: boolean,
): JsonValue {
  const fresh = new Set<object>();
  const own = (node: JsonContainer): Record<string | number, JsonValue> => {
    if (fresh.has(node)) return node as unknown as Record<string | number, JsonValue>;
    const copy = Array.isArray(node) ? (node as JsonArray).slice() : { ...(node as JsonObject) };
    fresh.add(copy);
    return copy as unknown as Record<string | number, JsonValue>;
  };
  const fail = (op: StructuralOp, message: string): CoreError =>
    strict
      ? conflict(op, message)
      : new CoreError('BAD_PATH', `${op.op} ${formatPath(op.path)}: ${message}`, {
          path: [...op.path],
        });

  let top = root;
  for (const op of ops) {
    checkPath(op.path);
    if (op.path.length === 0) {
      if (op.op !== 'replace') throw fail(op, 'only replace applies to the root');
      if (strict && !jsonEqual(top, op.before)) throw conflict(op, 'root differs from before');
      top = op.after;
      continue;
    }
    if (!isContainer(top)) throw fail(op, 'the root is not a container');
    let parent = own(top);
    top = parent;
    const last = op.path.length - 1;
    let lastSeg: string | number = 0;
    for (const [i, seg] of op.path.entries()) {
      if (i === last) {
        lastSeg = seg;
        break;
      }
      const child = childOf(parent, seg);
      if (child === undefined || !isContainer(child)) {
        throw fail(op, `no container at ${formatPath(op.path.slice(0, i + 1))}`);
      }
      const copy = own(child);
      parent[seg] = copy;
      parent = copy;
    }
    applyLast(parent, op, lastSeg, strict, fail);
  }
  for (const node of fresh) sealNode(node as JsonContainer);
  return top;
}

function applyLast(
  parent: Record<string | number, JsonValue>,
  op: StructuralOp,
  seg: string | number,
  strict: boolean,
  fail: (op: StructuralOp, message: string) => CoreError,
): void {
  if (Array.isArray(parent)) {
    const arr = parent as unknown as JsonValue[];
    if (typeof seg !== 'number') throw fail(op, 'array index must be a number');
    const limit = op.op === 'add' ? arr.length : arr.length - 1;
    if (seg > limit)
      throw fail(op, `index ${String(seg)} out of range (length ${String(arr.length)})`);
    if (op.op !== 'add' && strict && !jsonEqual(arr[seg] as JsonValue, op.before)) {
      throw conflict(op, 'current value differs from before');
    }
    if (op.op === 'add') arr.splice(seg, 0, op.after);
    else if (op.op === 'remove') arr.splice(seg, 1);
    else arr[seg] = op.after;
    return;
  }
  if (typeof seg !== 'string') throw fail(op, 'object key must be a string');
  const present = Object.hasOwn(parent, seg);
  if (op.op === 'add') {
    if (present && strict) throw conflict(op, 'key already present');
    parent[seg] = op.after;
    return;
  }
  if (!present) throw fail(op, 'no such key');
  if (strict && !jsonEqual(parent[seg] as JsonValue, op.before)) {
    throw conflict(op, 'current value differs from before');
  }
  if (op.op === 'remove') {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removing a JSON key is the operation
    delete parent[seg];
  } else {
    parent[seg] = op.after;
  }
}
