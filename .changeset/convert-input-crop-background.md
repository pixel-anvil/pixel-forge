---
'@pixel-forge/convert': minor
'@pixel-forge/io': minor
'@pixel-forge/ops': patch
---

Add the first converter steps (E4.1). `convert` gets `cropImage` and `removeBackground` (modes none, key, flood, alpha; RGB tolerance) with `ConvertError`. `io` gets `decodeImageFile`, which reads PNG and refuses JPEG and WebP by magic bytes with a "convert to PNG first" message (new `IoErrorCode` `UNSUPPORTED_IMAGE`, mapped to `REFUSED` in `ops`).
