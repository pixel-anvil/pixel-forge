---
'@pixel-forge/ops': minor
'@pixel-forge/server': minor
'@pixel-forge/cli': minor
---

Add `skin_set` (E5.5, FR-PAL-07) to the `palette` group: create, replace or remove a skin. A remap skin takes `map` (`[{from, to}]` by palette index or exact palette colour, stored canonical); a palette skin takes `palette` (another palette of the document) or `colors` (a new palette, one colour per active entry). `export` gains `allSkins`: one sheet and JSON per skin with the same layout (`hero.png`, `hero.rival.png`); `pf export --all-skins` does the same. Palette edits that move indices are still refused while a palette skin exists. Scenario W7 (a palette-locked document with a skin `rival`: lint over every skin's render is clean, one sheet and one render folder per skin) joins `pnpm scenarios`, and a GUT test shows one atlas per skin. The `tools/list` size limit rises from 95,000 to 98,000 bytes (KNOWN_ISSUES MCP-04).
