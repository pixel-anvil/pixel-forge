/**
 * Atomic save through the `FileSystem` port (FR-DOC-01).
 * @packageDocumentation
 */
import { sha256Hex } from '@pixel-forge/raster';
import { IoError } from '../errors.js';
import { dirnameOf } from '../fs.js';
import type { FileSystem } from '../fs.js';

/** Options of {@link saveAtomic}. */
export interface SaveAtomicOptions {
  /**
   * Suffix of the temporary file `<path>.tmp-<nonce>` (a process id, a counter, ...). Default: the
   * first 12 hex digits of the SHA-256 of `bytes`, which keeps the function pure and gives two
   * writers of different content different temp files.
   */
  readonly nonce?: string;
}

/**
 * Writes `bytes` to `path` so that readers see either the old file or the new one, never a torn
 * file: the bytes go to `<path>.tmp-<nonce>` in the same folder, which is then renamed over `path`.
 * The parent folder is created when missing. On any failure the temp file is removed (best effort)
 * and the original file is left untouched.
 *
 * The port has no `fsync`, so durability across a power cut is up to the adapter.
 * @throws IoError `FS_FAILED` with the original error as `cause`.
 */
export async function saveAtomic(
  fs: FileSystem,
  path: string,
  bytes: Uint8Array,
  options: SaveAtomicOptions = {},
): Promise<void> {
  const tmp = `${path}.tmp-${options.nonce ?? sha256Hex(bytes).slice(0, 12)}`;
  try {
    const dir = dirnameOf(path);
    if (dir !== '') await fs.mkdirp(dir);
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, path);
  } catch (e) {
    try {
      await fs.remove(tmp);
    } catch {
      // The temp file is garbage either way; the original error is the one to report.
    }
    throw new IoError(
      'FS_FAILED',
      `could not save '${path}': ${e instanceof Error ? e.message : String(e)}`,
      {
        cause: e,
      },
    );
  }
}
