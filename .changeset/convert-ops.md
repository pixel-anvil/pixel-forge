---
'@pixel-forge/ops': minor
'@pixel-forge/io': minor
'@pixel-forge/server': minor
'@pixel-forge/cli': minor
---

Add the `convert` tool group (E4.5, FR-CONV-01..09) with `image_to_sprite` and `convert_apply`. `image_to_sprite` reads a PNG inside the workspace roots (JPEG and WebP are refused with "convert the image to PNG first") and opens a new document: crop, background removal, grid or target size, downscale, clean-up, palette (preset id, colour list or made from the image) and dither, from shortcut fields or one `ConvertRecipe`; with `variants` each combination is a layer. `convert_apply` runs the same steps on a layer cel (replace it, or add a layer; one undo step) or puts a variant contact sheet in a new document and returns the tile labels. `@pixel-forge/io` exports `createEmptyDocumentStore`. Scenario W1 (`photo_ball.png` to a 32 px PICO-8 sprite with 4 variants, lint clean, JPEG and WebP refused) joins `pnpm scenarios`. The `tools/list` size limit rises from 98,000 to 104,000 bytes (KNOWN_ISSUES MCP-04); `core` alone stays under 45,000.
