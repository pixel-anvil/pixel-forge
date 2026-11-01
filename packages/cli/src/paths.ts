import { isAbsolute, resolve } from 'node:path';

/**
 * Input fields that name a file, as the ops spell them (`doc.open` `path`, `io.import` `file` and
 * `outlineFile`, `pxf.pack` `dir`, ...). The CLI and `pf check` make them absolute before the call, because the
 * document host only takes absolute paths when workspace roots are set.
 */
export const PATH_INPUT_KEYS: readonly string[] = ['path', 'file', 'outlineFile', 'dir'];

/** Returns a copy of `input` whose string path fields are absolute (relative ones resolve against `base`). */
export function resolvePathInputs(
  input: Readonly<Record<string, unknown>>,
  base: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const key of PATH_INPUT_KEYS) {
    const value = out[key];
    if (typeof value === 'string' && value !== '' && !isAbsolute(value)) {
      out[key] = resolve(base, value);
    }
  }
  return out;
}
