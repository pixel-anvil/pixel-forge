---
'@pixel-forge/io': minor
'@pixel-forge/ops': minor
---

Animated GIF export (FR-DOC-06, E6.2): a clean-room GIF89a encoder (`encodeGif`, `exportGif`). `io.export` (`export`, `pf export`) takes a `.gif` path and writes one animation with its frame durations and loop mode (pingpong plays back and forth). One global palette of up to 256 colours with a transparent index; more colours are refused with `PALETTE_TOO_LARGE`, partial alpha with `BAD_INPUT`. The output of `io.export` makes `png` and `json` optional and adds `gif`.
