---
'@pixel-forge/color': minor
'@pixel-forge/ops': minor
'@pixel-forge/server': minor
'@pixel-forge/cli': minor
---

Add palette generation from an image (E5.3, FR-PAL-04). New tool `palette_generate` (group `palette`, CLI `pf palette generate`): makes 2 to 256 colours from a PNG file or from a frame or layer of the open document, by k-means++ in OKLab (default, seeded) or median cut. The result is deterministic for the same image, method and seed. Alpha 0 pixels are ignored; the colours are opaque, occur in the image and are sorted darkest first; an image with fewer colours than asked returns its own colours. Without `add: true` it only returns the colours; with it, the colours are stored as a new palette (`activate: true` makes it active). `@pixel-forge/color` gains `generatePalette`. The `tools/list` size limit rises from 89,000 to 92,000 bytes (KNOWN_ISSUES MCP-04).
