---
'@pixel-forge/io': minor
'@pixel-forge/ops': minor
---

GIF import (FR-DOC-05, E6.1): a clean-room GIF87a/89a decoder (`decodeGif`) with local and global palettes, interlace, transparency, disposal methods 0 to 3, per-frame delays and the `NETSCAPE2.0` loop count, bounded against hostile files (`BAD_GIF` and `TOO_LARGE` `IoError` codes). `io.import` (`import_file`) takes a `.gif` and adds one animation with one frame per GIF frame; new `group` field. The converter still reads PNG only and refuses GIF with a message that says so.
