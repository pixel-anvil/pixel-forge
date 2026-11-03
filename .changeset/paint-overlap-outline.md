---
'@pixel-forge/core': patch
'@pixel-forge/server': patch
---

`part.paintOverlap` without `color` now fills with the most frequent opaque colour that is not the outline colour (the darkest colour next to transparency), so small outlined parts are no longer filled with the outline. The MCP server instructions state once that clients prefix tool names (`mcp__pf__undo`).
