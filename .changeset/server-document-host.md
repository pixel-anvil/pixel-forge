---
'@pixel-forge/server': minor
---

DocumentHost (an OpHost on the memory host plus lockfiles in `~/.pixel-forge/locks/<sha1(path)>.lock`, `DOC_LOCKED` with the owner's pid, stale-lock reclaim), `server.json` discovery helpers with stale detection by pid, workspace roots with symlink resolution so a link cannot escape a root, and an injectable base folder.
