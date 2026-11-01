/**
 * File helpers for `io` ops: every file goes through the host's `FileSystem` port.
 * @packageDocumentation
 */
import type { OpContext } from './context.js';
import { OpError } from './errors.js';

/**
 * Reads a whole file through `ctx.host.fs`.
 * @throws OpError `IO_FAILED` (missing file, permissions).
 */
export async function readBytes(ctx: OpContext, path: string): Promise<Uint8Array> {
  try {
    return await ctx.host.fs.readFile(path);
  } catch (e) {
    throw new OpError(
      'IO_FAILED',
      `cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`,
      { path },
      { cause: e },
    );
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Width and height from a PNG's IHDR chunk (bytes 16..24), without decoding it.
 * @throws OpError `BAD_FILE` when the bytes are not a PNG.
 */
export function pngSize(bytes: Uint8Array, path: string): { w: number; h: number } {
  const ok =
    bytes.length >= 24 &&
    PNG_SIGNATURE.every((b, i) => bytes[i] === b) &&
    bytes[12] === 0x49 && // 'I' of IHDR
    bytes[13] === 0x48 &&
    bytes[14] === 0x44 &&
    bytes[15] === 0x52;
  if (!ok) throw new OpError('BAD_FILE', `${path} is not a PNG file`, { path });
  const u32 = (o: number): number =>
    (((bytes[o] ?? 0) << 24) |
      ((bytes[o + 1] ?? 0) << 16) |
      ((bytes[o + 2] ?? 0) << 8) |
      (bytes[o + 3] ?? 0)) >>>
    0;
  return { w: u32(16), h: u32(20) };
}

/** UTF-8 bytes of `text` (no `TextEncoder`: ops targets no DOM or Node typings). */
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}
