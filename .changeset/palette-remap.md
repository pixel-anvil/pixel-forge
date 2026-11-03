---
'@pixel-forge/color': minor
'@pixel-forge/ops': minor
'@pixel-forge/server': minor
---

Add `palette_remap` (E5.4, FR-PAL-05) to the `palette` group. A mapping table `{from, to}` recolours drawings: by palette index in an indexed document, by exact colour in an RGBA one; the table applies at once, unlisted and transparent pixels stay, and the scope is the whole document or one layer and/or some frames. `swap` replaces the active palette's colours with another palette's (by id) or a list of the same length, keeping every index. A palette-locked RGBA document refuses a target colour that is not in the palette. The result counts changed pixels per drawing. `@pixel-forge/color` gains `indexLut`, `colorTable`, `swapPairs`, `applyIndexLut` and `applyColorTable` for skins to reuse. The `tools/list` size limit rises from 89,000 to 92,000 bytes (KNOWN_ISSUES MCP-04).
