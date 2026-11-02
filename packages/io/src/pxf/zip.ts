/**
 * The `.pxf` ZIP container (spec 7, ADR-005, NFR-03): a deterministic writer on `fflate.zipSync` and
 * a checked reader.
 *
 * Determinism rules (a test pins each):
 * - **Entry order** is fixed by {@link orderEntries}: `manifest.json`, `document.json`, `images/*`
 *   sorted, `render/index.json`, then the rest of `render/*` sorted (code-unit order of the full path).
 * - **Compression**: `*.json` entries are deflated at the pinned level {@link JSON_DEFLATE_LEVEL} with
 *   memory level {@link JSON_DEFLATE_MEM} (method 8). `*.png` entries are **stored** (method 0): a
 *   PNG is already deflate-compressed by the `png` package, so deflating it again gains nothing. Both
 *   methods are read by Godot's `ZIPReader`, by `unzip` and by every ZIP library.
 * - **Timestamps**: every entry carries the DOS date/time of the manifest's `modified`, read as UTC
 *   and rounded down to 2 s (the DOS resolution). `fflate` formats `mtime` with the machine's *local*
 *   time zone, so the DOS fields are overwritten after `zipSync` with the UTC values: the bytes do
 *   not depend on the time zone. Years outside 1980..2107 are clamped.
 * - No extra fields, no comments, no ZIP64, no data descriptors.
 * @packageDocumentation
 */
import { unzipSync, zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import { IoError } from '../errors.js';

/** Deflate level of the JSON entries (pinned; changing it is a file-format stability event). */
export const JSON_DEFLATE_LEVEL = 9;
/** Deflate memory level of the JSON entries (pinned). */
export const JSON_DEFLATE_MEM = 8;

/** Largest accepted inflated size of one entry (guards against zip bombs). */
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

/** One file of the archive. */
export interface ZipEntry {
  /** Path inside the archive, `/` separated, e.g. `images/img_ab12cd.png`. */
  readonly path: string;
  readonly data: Uint8Array;
}

const rank = (path: string): number => {
  if (path === 'manifest.json') return 0;
  if (path === 'document.json') return 1;
  if (path.startsWith('images/')) return 2;
  if (path === 'render/index.json') return 3;
  if (path.startsWith('render/')) return 4;
  return 5;
};

/** Sorts entries into the fixed `.pxf` order (a copy). */
export function orderEntries<T extends { readonly path: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    const r = rank(a.path) - rank(b.path);
    if (r !== 0) return r;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/** True for a path that is safe to write below a folder: relative, no `..`, no backslash. */
export function isSafeEntryPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    return false;
  }
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** DOS (time, date) 16-bit fields for an ISO timestamp, read as UTC, rounded down to 2 s. */
export function dosDateTime(iso: string): { time: number; date: number } {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) throw new IoError('BAD_PXF', `bad timestamp ${iso}`);
  const year = Math.min(2107, Math.max(1980, t.getUTCFullYear()));
  const clamped = year !== t.getUTCFullYear();
  const mo = clamped ? 1 : t.getUTCMonth() + 1;
  const d = clamped ? 1 : t.getUTCDate();
  const h = clamped ? 0 : t.getUTCHours();
  const mi = clamped ? 0 : t.getUTCMinutes();
  const s = clamped ? 0 : t.getUTCSeconds();
  return { time: (h << 11) | (mi << 5) | (s >> 1), date: ((year - 1980) << 9) | (mo << 5) | d };
}

const u16 = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number): number => u16(b, o) + u16(b, o + 2) * 65536;
const put16 = (b: Uint8Array, o: number, v: number): void => {
  b[o] = v & 255;
  b[o + 1] = (v >> 8) & 255;
};

/** Overwrites the DOS time/date of every local and central header (see the module comment). */
function stampDosTime(zip: Uint8Array, iso: string): void {
  const { time, date } = dosDateTime(iso);
  const eocd = zip.length - 22; // zipSync writes no archive comment
  const count = u16(zip, eocd + 10);
  let p = u32(zip, eocd + 16);
  for (let i = 0; i < count; i++) {
    put16(zip, p + 12, time);
    put16(zip, p + 14, date);
    const local = u32(zip, p + 42);
    put16(zip, local + 10, time);
    put16(zip, local + 12, date);
    p += 46 + u16(zip, p + 28) + u16(zip, p + 30) + u16(zip, p + 32);
  }
}

/**
 * Builds the archive from `entries` in {@link orderEntries} order (duplicates are an error), with
 * the DOS timestamp of `modifiedIso`. The result is a pure function of the arguments.
 */
export function buildZip(entries: readonly ZipEntry[], modifiedIso: string): Uint8Array {
  const data: Zippable = {};
  for (const e of orderEntries(entries)) {
    if (!isSafeEntryPath(e.path)) throw new IoError('BAD_PXF', `unsafe entry path '${e.path}'`);
    if (Object.hasOwn(data, e.path)) throw new IoError('BAD_PXF', `duplicate entry '${e.path}'`);
    // mtime is overwritten below; any valid date will do (local-time year 2000 always exists).
    const mtime = new Date(2000, 0, 1, 12);
    data[e.path] = e.path.endsWith('.png')
      ? [e.data, { level: 0, mtime }]
      : [e.data, { level: JSON_DEFLATE_LEVEL, mem: JSON_DEFLATE_MEM, mtime }];
  }
  const zip = zipSync(data);
  stampDosTime(zip, modifiedIso);
  return zip;
}

/**
 * Reads every file of the archive (folder entries are skipped). Rejects, with `BAD_PXF`, a corrupt
 * archive, an unsafe entry path or an entry that inflates beyond {@link MAX_ENTRY_BYTES}.
 */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (f.originalSize > MAX_ENTRY_BYTES) {
          throw new IoError(
            'BAD_PXF',
            `entry '${f.name}' is larger than ${String(MAX_ENTRY_BYTES)} bytes`,
          );
        }
        return !f.name.endsWith('/');
      },
    });
  } catch (e) {
    if (e instanceof IoError) throw e;
    throw new IoError('BAD_PXF', 'not a readable ZIP archive', { cause: e });
  }
  const out = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(files)) {
    if (!isSafeEntryPath(path)) throw new IoError('BAD_PXF', `unsafe entry path '${path}'`);
    out.set(path, data);
  }
  return out;
}
