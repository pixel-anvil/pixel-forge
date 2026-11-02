/**
 * `pack` / `unpack`: `.pxf` file to and from the `.pxfd/` folder form (spec 7, ADR-005).
 * @packageDocumentation
 */
import { Manifest } from '@pixel-forge/schema';
import { IoError } from '../errors.js';
import { dirnameOf, joinPath } from '../fs.js';
import type { FileSystem } from '../fs.js';
import { saveAtomic } from './atomic.js';
import { parseJsonBytes } from './json.js';
import { imageEntryId, isRenderEntry } from './read.js';
import { buildZip, orderEntries, readZip } from './zip.js';
import type { ZipEntry } from './zip.js';

/** Name of the file at the root of a `.pxfd/` folder that stops Godot importing its PNGs. */
export const GDIGNORE = '.gdignore';

const ROOT_FILES: ReadonlySet<string> = new Set(['manifest.json', 'document.json']);

/** Options of {@link unpack}. */
export interface UnpackOptions {
  /** Delete an existing `dirPath` (recursively) first. Default false: an existing folder is an error. */
  readonly overwrite?: boolean;
}

/**
 * Expands `pxfPath` into the folder `dirPath` with identical content: one file per ZIP entry
 * (`manifest.json`, `document.json`, `images/`, `render/`) plus an empty `.gdignore` at the root.
 * Entry bytes are copied verbatim, so {@link pack} rebuilds the same archive. Not atomic: a failure
 * can leave a partial folder.
 * @throws IoError `BAD_PXF` (not a `.pxf`), `EXISTS` (folder exists, no `overwrite`), `FS_FAILED`.
 */
export async function unpack(
  fs: FileSystem,
  pxfPath: string,
  dirPath: string,
  options: UnpackOptions = {},
): Promise<void> {
  const entries = readZip(await wrap(`read '${pxfPath}'`, () => fs.readFile(pxfPath)));
  if (!entries.has('manifest.json') || !entries.has('document.json')) {
    throw new IoError('BAD_PXF', `'${pxfPath}' has no manifest.json / document.json`);
  }
  await wrap(`prepare '${dirPath}'`, async () => {
    if (await fs.exists(dirPath)) {
      if (options.overwrite !== true) {
        throw new IoError('EXISTS', `'${dirPath}' already exists`);
      }
      await fs.remove(dirPath, { recursive: true });
    }
    await fs.mkdirp(dirPath);
  });
  const list = orderEntries([...entries].map(([path, data]): ZipEntry => ({ path, data })));
  await wrap(`write '${dirPath}'`, async () => {
    for (const e of list) {
      const target = joinPath(dirPath, e.path);
      await fs.mkdirp(dirnameOf(target));
      await fs.writeFile(target, e.data);
    }
    await fs.writeFile(joinPath(dirPath, GDIGNORE), new Uint8Array(0));
  });
}

/**
 * Builds `pxfPath` from the folder `dirPath` (the inverse of {@link unpack}), atomically. Only
 * `manifest.json`, `document.json`, `images/<id>.png` and the render cache (`render/index.json`,
 * `render/**.png`) are packed; `.gdignore`, `.DS_Store` and any other file are ignored. A symbolic
 * link in any of those places is refused, not followed and not skipped. The archive is built by the same deterministic writer as `writePxf` (fixed
 * order, compression and timestamp from `manifest.json`), so `pack(unpack(x))` is byte-identical to
 * any `x` that this build wrote.
 * @throws IoError `BAD_PXF` (missing or invalid manifest / document), `SYMLINK`, `FS_FAILED`.
 */
export async function pack(fs: FileSystem, pxfPath: string, dirPath: string): Promise<void> {
  const entries: ZipEntry[] = [];
  const walk = async (rel: string): Promise<void> => {
    const items = await wrap(`list '${joinPath(dirPath, rel)}'`, () =>
      fs.readdir(joinPath(dirPath, rel)),
    );
    for (const item of items) {
      const path = rel === '' ? item.name : `${rel}/${item.name}`;
      const inImages = path === 'images' || path.startsWith('images/');
      const inRender = path === 'render' || path.startsWith('render/');
      // A link where pack reads would be followed by readFile: it could pull a file from outside
      // the folder into the archive (NFR-06). Skipping it would hide a missing image, so refuse.
      if (item.isSymlink === true && (inImages || inRender || ROOT_FILES.has(path))) {
        throw new IoError(
          'SYMLINK',
          `'${path}' in '${dirPath}' is a symbolic link; pack does not follow links (replace it with the file)`,
        );
      }
      if (item.isDirectory) {
        // `images/` is flat (readPxf accepts `images/<id>.png` only); `render/` nests by skin.
        if (path === 'images' || path === 'render' || path.startsWith('render/')) await walk(path);
      } else if (
        ROOT_FILES.has(path) ||
        (inImages && imageEntryId(path) !== undefined) ||
        isRenderEntry(path)
      ) {
        entries.push({
          path,
          data: await wrap(`read '${path}'`, () => fs.readFile(joinPath(dirPath, path))),
        });
      }
    }
  };
  await walk('');
  const byPath = new Map(entries.map((e) => [e.path, e.data]));
  const manifestBytes = byPath.get('manifest.json');
  if (manifestBytes === undefined || !byPath.has('document.json')) {
    throw new IoError('BAD_PXF', `'${dirPath}' has no manifest.json / document.json`);
  }
  const manifest = Manifest.safeParse(parseJsonBytes(manifestBytes, 'manifest.json'));
  if (!manifest.success) {
    throw new IoError('INVALID_DOCUMENT', 'manifest.json is invalid', { cause: manifest.error });
  }
  await saveAtomic(fs, pxfPath, buildZip(entries, manifest.data.modified));
}

async function wrap<T>(what: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof IoError) throw e;
    throw new IoError(
      'FS_FAILED',
      `could not ${what}: ${e instanceof Error ? e.message : String(e)}`,
      {
        cause: e,
      },
    );
  }
}
