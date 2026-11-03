---
'@pixel-forge/ops': patch
'@pixel-forge/server': patch
---

Cut MCP `tools/list` from 83,005 to 75,775 bytes (MCP-04). The conventions line and the plain edit note move into the server instructions, and the listed schemas drop `additionalProperties: false` and `annotations.title`. Server validation is unchanged; the generated contract files keep the full text. `ops` exports `MUTATE_NOTE`.
