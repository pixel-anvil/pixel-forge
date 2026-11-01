---
"@pixel-forge/server": minor
"@pixel-forge/ops": patch
---

MCP stdio server on the official SDK (`createMcpServer`, `serveStdio`): the registry's ops as tools (image content, errors as tool results, `NOT_IMPLEMENTED` forwarding to a running `pf serve`, optional trace sink) and read-only `pf://` resources. `SERVER_PROTOCOL_VERSION` added. Ops: shorter tool descriptions (at most 800 characters), `toHex` exported.
