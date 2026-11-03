---
'@pixel-forge/convert': minor
---

Add `quantize` (E4.3): nearest-colour mapping in OKLab to an explicit or generated palette, with dither modes none, Bayer 2/4/8, Floyd-Steinberg and a strength control (0 equals none). Returns the RGBA image and an index map. New `ConvertErrorCode` `BAD_PALETTE`; exports `bayerMatrix`, `bayerThreshold` and `FLOYD_STEINBERG`.
