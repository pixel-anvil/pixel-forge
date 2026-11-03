---
'@pixel-forge/io': minor
---

Palette file parsers and writers (FR-PAL-02): `.hex` (Lospec), `.gpl` (GIMP), `.pal` (JASC-PAL) and PNG strips (one pixel per colour, first-seen order; alpha 0 pixels are skipped). Malformed files raise `IoError` with the new `BAD_PALETTE_FILE` or `PALETTE_TOO_LARGE` codes.
