/**
 * Plain-JSON values, deep-readonly types, sealing (deep freeze with structural sharing), equality,
 * canonical serialisation and path lookup.
 * @packageDocumentation
 */
import { CoreError } from './errors.js';

/** A JSON primitive. Numbers are finite. */
export type JsonPrimitive = null | boolean | number | string;

/** A JSON array (read-only). */
export type JsonArray = readonly JsonValue[];

/** A JSON object (read-only). Keys are own, enumerable string keys; values are never `undefined`. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Any JSON value. */
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

/** A JSON container (array or object). */
export type JsonContainer = JsonArray | JsonObject;

/**
 * A location in a JSON tree: object keys (strings) and array indices (non-negative integers), from
 * the root. `[]` is the root itself. Example: `['animations', 0, 'frames', 2, 'durationMs']`.
 */
export type JsonPath = readonly (string | number)[];

/**
 * Deeply read-only view of `T`: every object, array and tuple becomes `readonly`; primitives (including
 * branded ids) are unchanged. Store snapshots are typed with it, and they are frozen at runtime too.
 */
export type DeepReadonly<T> = T extends
  null | undefined | boolean | number | string | bigint | symbol
  ? T
  : { readonly [K in keyof T]: DeepReadonly<T[K]> };

/** Nodes created (and frozen) by core. Every node reachable from a sealed node is sealed too. */
const SEALED = new WeakSet<object>();

/** True for arrays and objects. */
export function isContainer(v: unknown): v is JsonContainer {
  return typeof v === 'object' && v !== null;
}

/** True when `v` is a node that core sealed: deeply frozen plain JSON, safe to share by reference. */
export function isSealed(v: unknown): boolean {
  return typeof v === 'object' && v !== null && SEALED.has(v);
}

/** Freezes one freshly built container and marks it sealed. Its children must already be sealed. */
export function sealNode<T extends JsonContainer>(node: T): T {
  Object.freeze(node);
  SEALED.add(node);
  return node;
}

function isPlainObject(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function badValue(path: readonly (string | number)[], message: string): CoreError {
  return new CoreError('BAD_VALUE', `${message} at ${formatPath(path)}`, { path: [...path] });
}

/**
 * Returns a sealed (deeply frozen) copy of `value`, reusing sealed sub-trees by reference. Throws
 * `BAD_VALUE` for anything that is not plain JSON. `resolve` lets the draft machinery replace a draft
 * proxy by its final value: it returns `undefined` for a value that is not a draft.
 */
export function seal(value: unknown, resolve?: (v: object) => JsonValue | undefined): JsonValue {
  const active = new Set<object>();
  const path: (string | number)[] = [];
  const visit = (v: unknown): JsonValue => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw badValue(path, `non-finite number ${String(v)}`);
      return v;
    }
    if (typeof v !== 'object') {
      throw badValue(
        path,
        `${typeof v} is not JSON${v === undefined ? ' (delete the key instead)' : ''}`,
      );
    }
    if (SEALED.has(v)) return v as JsonContainer;
    const resolved = resolve?.(v);
    if (resolved !== undefined) return resolved;
    if (active.has(v)) throw badValue(path, 'cyclic value');
    active.add(v);
    let out: JsonContainer;
    if (Array.isArray(v)) {
      const src = v as readonly unknown[];
      const arr: JsonValue[] = new Array<JsonValue>(src.length);
      for (let i = 0; i < src.length; i++) {
        path.push(i);
        if (!(i in src)) throw badValue(path, 'array hole');
        arr[i] = visit(src[i]);
        path.pop();
      }
      out = arr;
    } else {
      if (!isPlainObject(v)) throw badValue(path, 'not a plain object');
      if (Object.getOwnPropertySymbols(v).length > 0) throw badValue(path, 'symbol key');
      const obj: Record<string, JsonValue> = {};
      for (const key of Object.keys(v)) {
        path.push(key);
        if (key === '__proto__') throw badValue(path, 'reserved key "__proto__"');
        obj[key] = visit((v as Record<string, unknown>)[key]);
        path.pop();
      }
      out = obj;
    }
    active.delete(v);
    return sealNode(out);
  };
  return visit(value);
}

/** Deep structural equality of two JSON values (object key order is irrelevant). */
export function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (!isContainer(a) || !isContainer(b)) return false;
  const arrA = Array.isArray(a);
  if (arrA !== Array.isArray(b)) return false;
  if (arrA) {
    const x = a as JsonArray;
    const y = b as JsonArray;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      if (!jsonEqual(x[i] as JsonValue, y[i] as JsonValue)) return false;
    }
    return true;
  }
  const x = a as JsonObject;
  const y = b as JsonObject;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  for (const k of keys) {
    if (!Object.hasOwn(y, k) || !jsonEqual(x[k] as JsonValue, y[k] as JsonValue)) return false;
  }
  return true;
}

/** Keys in canonical order (UTF-16 code unit order, as `Array.prototype.sort` with no comparator). */
export function sortedKeys(o: JsonObject): string[] {
  return Object.keys(o).sort();
}

/**
 * Canonical JSON text: object keys sorted, no whitespace, numbers and strings as `JSON.stringify`
 * writes them. Equal values (by {@link jsonEqual}) give equal text, whatever their key order.
 */
export function canonicalJson(value: JsonValue): string {
  if (!isContainer(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${(value as JsonArray).map((v) => canonicalJson(v)).join(',')}]`;
  }
  const o = value as JsonObject;
  const parts = sortedKeys(o).map(
    (k) => `${JSON.stringify(k)}:${canonicalJson(o[k] as JsonValue)}`,
  );
  return `{${parts.join(',')}}`;
}

/** Readable path for messages, e.g. `/animations/0/frames`. */
export function formatPath(path: JsonPath): string {
  return path.length === 0 ? '(root)' : `/${path.map(String).join('/')}`;
}

/** Validates the type of every path segment (strings, or non-negative integers). */
export function checkPath(path: JsonPath): void {
  const raw: unknown = path;
  if (!Array.isArray(raw)) throw new CoreError('BAD_PATH', 'a path is an array of segments');
  for (const seg of path) {
    if (typeof seg === 'string') {
      if (seg === '__proto__') {
        throw new CoreError('BAD_PATH', `reserved key "__proto__" in ${formatPath(path)}`, {
          path: [...path],
        });
      }
    } else if (typeof seg !== 'number' || !Number.isInteger(seg) || seg < 0) {
      throw new CoreError('BAD_PATH', `bad segment ${String(seg)} in ${formatPath(path)}`, {
        path: [...path],
      });
    }
  }
}

/**
 * The child of a container: an own key of an object (a string segment) or an index of an array (a
 * number segment). `undefined` when absent or when the segment kind does not fit the container.
 */
export function childOf(node: JsonContainer, seg: string | number): JsonValue | undefined {
  if (Array.isArray(node)) {
    const arr = node as JsonArray;
    return typeof seg === 'number' && seg < arr.length ? arr[seg] : undefined;
  }
  if (typeof seg !== 'string') return undefined;
  const o = node as JsonObject;
  return Object.hasOwn(o, seg) ? o[seg] : undefined;
}

/** The value at `path`, or `undefined` when the path does not resolve. Own properties only. */
export function getAt(root: JsonValue, path: JsonPath): JsonValue | undefined {
  checkPath(path);
  let node: JsonValue | undefined = root;
  for (const seg of path) {
    if (!isContainer(node)) return undefined;
    node = childOf(node, seg);
    if (node === undefined) return undefined;
  }
  return node;
}
