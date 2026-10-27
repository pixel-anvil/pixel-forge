# Known issues

Add a row when you find a problem you are not fixing in the current card. Remove or mark resolved when fixed.

| ID | Issue | Impact | Workaround/Plan | Since |
|---|---|---|---|---|
| PNG-01 | The `png` decoder ignores unknown chunks, including unknown *critical* ones, which strict PNG would reject. | Exotic or corrupt files may decode without an error. | Acceptable for now (we only read common encoders' output). Reject unknown critical chunks if it ever matters. | 2026-10-26 (T1.8) |
| PNG-02 | For gray/RGB `tRNS` colour keys, pngjs zeroes the RGB of keyed pixels; our decoder keeps the RGB and sets alpha 0 (as libpng does). | Cross-decoder comparisons must ignore RGB under alpha 0. | Documented and pinned by a test. | 2026-10-26 (T1.8) |
