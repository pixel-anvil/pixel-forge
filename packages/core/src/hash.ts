/**
 * `documentHash`: a deterministic fingerprint of a document and its images.
 * @packageDocumentation
 */
import { IndexedImage, sha256Hex } from '@pixel-forge/raster';
import { CoreError } from './errors.js';
import { imageHash } from './images.js';
import { canonicalJson } from './json.js';
import type { JsonValue } from './json.js';
import type { DocumentView } from './view.js';

/** UTF-8 bytes of a string (lone surrogates become U+FFFD, as `TextEncoder` does). */
export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return Uint8Array.from(out);
}

/**
 * The canonical text that {@link documentHash} hashes: canonical JSON (sorted keys) of
 * `{ doc, images }`, where `images` maps each id to `{ kind, width, height, transparentIndex?, hash }`
 * (`hash` from `hashRGBA` for RGBA images; see `imageHash` for indexed ones).
 */
export function documentCanonical(view: DocumentView): string {
  const images: Record<string, JsonValue> = {};
  for (const id of view.imageIds()) {
    const img = view.image(id);
    if (img === undefined) throw new CoreError('IMAGE_MISSING', `no image ${id}`, { imageId: id });
    images[id] =
      img instanceof IndexedImage
        ? {
            kind: 'indexed',
            width: img.width,
            height: img.height,
            transparentIndex: img.transparentIndex,
            hash: imageHash(img),
          }
        : { kind: 'rgba', width: img.width, height: img.height, hash: imageHash(img) };
  }
  return canonicalJson({ doc: view.doc as unknown as JsonValue, images });
}

/**
 * Lower-case hex SHA-256 of {@link documentCanonical}: equal documents with equal images give equal
 * hashes on every platform, whatever their object key order or tile allocation. The same operation
 * sequence on the same start state therefore gives the same hash, and undoing everything gives back
 * the initial hash. Image hashes are memoised per immutable instance, so repeated calls are cheap.
 */
export function documentHash(view: DocumentView): string {
  return sha256Hex(utf8(documentCanonical(view)));
}
