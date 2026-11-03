---
'@pixel-forge/color': minor
'@pixel-forge/core': minor
'@pixel-forge/ops': minor
'@pixel-forge/server': minor
---

Add palette editing, sorting and a ramp generator (E5.2, FR-PAL-03). New tool group `palette`: `palette_edit` (add, remove, replace, move colours), `palette_sort` (hue, luminance, luma, chroma) and `palette_ramp` (OKLab ramp, shadows toward blue, lights toward yellow, optionally added to the palette). In an indexed document the pixels, ramps and remap skins follow every index change; removing a colour pixels still use is refused. `@pixel-forge/color` gains `generateRamp`, `insertRamp`, `replaceColor`, `composeRemaps`, `sinCosDeg` and the sort key `luma`; the hue sort no longer uses `atan2`. `@pixel-forge/core` gains `remapPaletteIndices`. The `tools/list` size limit rises from 84,000 to 89,000 bytes (KNOWN_ISSUES MCP-04).
