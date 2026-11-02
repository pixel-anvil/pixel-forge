# @pixel-forge/png

Pure, deterministic PNG encode/decode on [fflate](https://github.com/101arrowz/fflate). Used by testkit and io.

**Depends on:** none (runtime dependency: `fflate`)

**Status:** implemented (T1.8)

Pure package: no Node built-ins in `src/` (eslint enforces it), no `Math.random`, no `Date.now`.
Works on `Uint8Array` / `DataView` only.

## API

```ts
import { encodePng, decodePng, decodePngRaw, PngError } from '@pixel-forge/png';

const bytes = encodePng({ width, height, data, kind: 'rgba' }); // or kind: 'gray8'
const rgba = decodePng(bytes); // { width, height, data /* RGBA8 */, kind: 'rgba' }
const raw = decodePngRaw(bytes); // keeps 8-bit greyscale as kind: 'gray8'
```

- `encodePng(img)`: `kind: 'rgba'` is 4 bytes per pixel (straight alpha), `kind: 'gray8'` is 1 byte
  per pixel (a palette index for indexed cels). Validates input and throws `PngError`
  (`INVALID_DIMENSIONS`, `INVALID_DATA_LENGTH`, `INVALID_KIND`).
- `decodePng(bytes)`: always returns RGBA8. Greyscale becomes R=G=B=value, alpha 255.
- `decodePngRaw(bytes)`: returns `kind: 'gray8'` (stored sample values untouched) only for colour type 0
  at bit depth 8 without `tRNS`; everything else is returned as `kind: 'rgba'`.
- `PngError`: the only error type thrown; branch on `error.code` (`PngErrorCode`): `BAD_SIGNATURE`,
  `TRUNCATED`, `BAD_CRC`, `BAD_IHDR`, `UNSUPPORTED_INTERLACE`, `UNSUPPORTED_FORMAT`,
  `IMAGE_TOO_LARGE`, `BAD_PALETTE`, `BAD_TRNS`, `MISSING_IDAT`, `DECOMPRESS_FAILED`,
  `BAD_DATA_SIZE`, `BAD_FILTER`, plus the three encoder codes above.

## Determinism rules (NFR-02, NFR-03)

The encoder output is a pure function of the input and the pinned `fflate` version:

- Chunks: signature, `IHDR` (8-bit; colour type 6 for `rgba`, 0 for `gray8`; no interlace), exactly one
  `IDAT`, `IEND`. No ancillary chunks (no `tIME`, `gAMA`, `pHYs`, `tEXt`).
- Deflate: `fflate.zlibSync` at **level 9** with **mem 8**, both pinned (`DEFLATE_LEVEL`, `DEFLATE_MEM`).
  Never Node `zlib` or a browser codec.
- Filter strategy: chosen **per scanline** as the filter type (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth)
  with the smallest sum of absolute signed residuals (the classic libpng heuristic); ties go to the
  lowest type. Integer maths only.
- Own table-driven CRC-32.

A test pins the SHA-256 of reference encodings, so any change to these rules (or an `fflate` upgrade that
changes deflate output) fails loudly. Update the pins only deliberately, and treat it as a file-format
stability event (NFR-03). Compare images by hashing decoded RGBA (ADR-010), not by file bytes, across
versions.

## Supported formats (decoder)

| Colour type          | Bit depths | Notes                                                   |
| -------------------- | ---------- | ------------------------------------------------------- |
| 0 greyscale          | 1, 2, 4, 8 | 1/2/4-bit scaled to 8-bit (x255, x85, x17); `tRNS` key  |
| 2 truecolour         | 8          | `tRNS` colour key                                       |
| 3 palette            | 1, 2, 4, 8 | `PLTE` + optional `tRNS`; index outside `PLTE` is error |
| 4 greyscale + alpha  | 8          |                                                         |
| 6 truecolour + alpha | 8          |                                                         |

- All five filter types, any number of `IDAT` chunks, CRC-32 of every chunk and the zlib Adler-32 are
  verified.
- `tRNS` colour keys set alpha 0 on matching pixels and keep the colour (libpng behaviour; pngjs also
  zeroes RGB).
- Bytes after `IEND` are ignored (some real files carry a stray byte). Unknown chunks are ignored.
- Not supported: Adam7 interlace (`UNSUPPORTED_INTERLACE`) and 16-bit samples (`UNSUPPORTED_FORMAT`).
- Images over 2^28 pixels are refused (`IMAGE_TOO_LARGE`).

## Tests and corpus

Oracles are independent (plan section 0.6): `pngjs` (dev dependency) decodes our output and encodes some
inputs; `test/corpus/` holds 23 PNGs written by pngjs, macOS `sips`, the Aseprite CLI, a hand-rolled chunk
writer (palette, low bit depth, `tRNS`, every filter type, multiple `IDAT`) and the CC0 hero sheets.
Regenerate with `sh packages/png/test/corpus/make-corpus.sh` (skips `sips` / Aseprite when absent; set
`ASEPRITE` to the CLI path). The test decodes every corpus file and compares RGBA with pngjs.
