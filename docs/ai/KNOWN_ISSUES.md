# Known issues

Add a row when you find a problem you are not fixing in the current card. Remove or mark resolved when fixed.

| ID | Issue | Impact | Workaround/Plan | Since |
|---|---|---|---|---|
| PNG-01 | The `png` decoder ignores unknown chunks, including unknown *critical* ones, which strict PNG would reject. | Exotic or corrupt files may decode without an error. | Acceptable for now (we only read common encoders' output). Reject unknown critical chunks if it ever matters. | 2026-10-26 (T1.8) |
| PNG-02 | For gray/RGB `tRNS` colour keys, pngjs zeroes the RGB of keyed pixels; our decoder keeps the RGB and sets alpha 0 (as libpng does). | Cross-decoder comparisons must ignore RGB under alpha 0. | Documented and pinned by a test. | 2026-10-26 (T1.8) |
| PAL-01 | Built-in palette presets come from Lospec pages that state no licence. | Small legal uncertainty for a public repo. | Colour lists are generally treated as unprotectable data. Each preset credits its author and source URL. Remove a preset if an author objects. | 2026-10-27 (T1.3) |
| CORE-01 | `validate()` (I4) copies the id-scramble constants from `packages/schema/src/ids.ts` to decode id counters. | If the schema's scramble changes, the detector goes silent (it self-checks by re-encoding, so it never goes wrong). | Export a `decodeIdCounter` from schema and use it in core. | 2026-10-27 (T2.2) |
| CORE-02 | Frame-op refusals are `CoreError('BAD_ARGUMENT')` with `details.reason` (unknown-frame, last-frame, …) instead of dedicated codes. | Callers must switch on `details.reason`. | Promote to `CoreErrorCode` values when ops (T5.1) map errors to `OpError`. | 2026-10-27 (T2.2) |
