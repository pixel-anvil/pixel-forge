import type { z } from 'zod';

/** A deep copy through JSON, typed as the input (fixtures are JSON-safe). */
export const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** JSON with object keys sorted at every level, as `.pxf` writes it (NFR-03). */
export const sortedJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/** Dotted paths of every issue, descending into union branches. */
export const issuePaths = (
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly PropertyKey[] = [],
): string[] =>
  issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union' && issue.errors.length > 0) {
      return issue.errors.flatMap((branch) => issuePaths(branch, path));
    }
    return [path.map(String).join('.')];
  });

/** Issue paths of a failed parse; throws if the parse succeeded. */
export const failurePaths = (schema: z.ZodType, value: unknown): string[] => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('expected the parse to fail');
  return issuePaths(result.error.issues);
};

/** Return `xs[i]`, failing the test when it is missing. */
export const at = <T>(xs: readonly T[], i: number): T => {
  const x = xs[i];
  if (x === undefined) throw new Error(`missing element ${String(i)}`);
  return x;
};

/** Return `value`, failing the test when it is undefined. */
export const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

/**
 * Add an own, enumerable property, even for `__proto__` (an object literal key of that name would
 * set the prototype instead), as `JSON.parse` does.
 */
export const withOwn = <T extends object>(target: T, key: string, value: unknown): T => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return target;
};

/**
 * Pretty-printed JSON (2 spaces) with object keys sorted at every level, LF line ends and a
 * trailing newline: the committed form of `fixtures/frozen` files.
 */
export const sortedPrettyJson = (value: unknown): string =>
  `${JSON.stringify(
    value,
    (_key, v: unknown) =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
    2,
  )}\n`;
