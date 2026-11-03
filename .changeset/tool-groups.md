---
'@pixel-forge/ops': minor
'@pixel-forge/server': minor
'@pixel-forge/cli': minor
---

Add tool groups (TG.1). Every op has a required `group` (`core` or `rig`; a new op without one does not compile). `pf mcp --tools core,rig` (or env `PF_TOOLS`) lists only those groups; the default is every group, so current clients see no change. With fewer groups the server also lists `tool_groups` (enable or disable a group at run time, with `notifications/tools/list_changed`) and `find_tool` (search all tools, returns the group), and a call to a hidden tool fails with `REFUSED` and a message that names its group. The server instructions name the groups. `core` alone is 43 KB of `tools/list` against 83.5 KB for all groups. `McpToolDefinition._meta` gains `pixel-forge/group` (additive); `OPERATIONS.md` gains a Group column.
