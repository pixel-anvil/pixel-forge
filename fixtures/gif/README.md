# fixtures/gif

GIF files written by tools other than pixel-forge, for the GIF decoder (card E6.1, `packages/io/src/gif.ts`).
Each file is smaller than 4 KB. The expected frame hashes are computed by the generator scripts from the scene
they draw (plain pixel arrays), never by the decoder under test.

**Licence: all files here (GIFs, JSON and scripts) were made for this repository and are released under CC0 1.0.
They contain no third-party pixels.**

| Files | Writer | What it covers | Generator |
|---|---|---|---|
| `pil_opaque.gif` | Pillow 11.3.0 | 3 opaque frames, delays 60/120/200 ms, loop forever, local palettes | `make_pil.py` |
| `pil_interlaced.gif` | Pillow 11.3.0 | one interlaced frame (Pillow interlaces only single-image files), no loop extension | `make_pil.py` |
| `pil_sprite_disposal0..3.gif` | Pillow 11.3.0 | a moving sprite on a transparent background, one file per disposal method (0 and 1 leave a trail, 2 and 3 show each frame alone), transparency index, sub-rectangles | `make_pil.py` |
| `imageio_anim.gif` | macOS ImageIO (Apple's encoder) | GIF87a header with 89a extensions, 4 frames, delays 0.1/0.2/0.05/0.5 s, loop forever, transparency | `make_imageio.swift` |
| `sips_static.gif` | macOS `sips -s format gif` | still GIF87a with a Graphic Control Extension | `make_sips.py` + the `sips` command in its header |

`pil_expected.json` and `imageio_expected.json` hold, for each file, the size, the frame durations in ms, the loop
count and the sha256 of each composed frame (`width` u32 BE, `height` u32 BE, RGBA bytes: the `hashRGBA` layout).

To rebuild: `python3 -I make_pil.py .` (needs Pillow); `swiftc make_imageio.swift -o make_imageio && ./make_imageio .`;
`python3 -I make_sips.py <dir>` then `sips -s format gif <dir>/static.png --out sips_static.gif`. Pillow and ImageIO
output can change between versions, so the committed files are the oracle: do not regenerate them to make a test pass.
Aseprite was not available when these were made, so no Aseprite-written GIF is committed yet.
