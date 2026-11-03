---
'@pixel-forge/ops': minor
'@pixel-forge/server': minor
---

Add the op `part.paintVariant` (MCP `part_paint_variant`, CLI `pf part paint-variant`): paint a text grid into a part variant's own image, as one undo step. The image grows and the pivot moves when the grid reaches outside it. Part overrides of that part go stale by the existing hash rule. `tools/list` no longer repeats the example title in each description, to stay under its byte limit.
