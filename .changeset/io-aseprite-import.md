---
"@pixel-forge/io": minor
---

`.aseprite` to document mapping (`createDocumentFromAseprite`, `importAsepriteTx`): tags become animations, untagged frames `default`, overlapping tags and Aseprite linked cels become one-hop links, `part:` layers become parts and variants through `bindParts`, the palette is imported. In-place re-import (`reimportAsepriteTx`, `reimportAseprite`) matches layers and parts by name and frames by `(tag, index)`, keeps bindings, pivots and keys, appends added frames without keys, and reports removed frames. io now depends on `rig` (part-layer name parsing).
