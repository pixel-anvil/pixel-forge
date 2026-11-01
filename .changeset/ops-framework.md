---
"@pixel-forge/ops": minor
"@pixel-forge/core": minor
---

Operation API framework: defineOp, the registry (one transaction = one undo step labelled `AI: <op>`, validate guard, confirm for destructive ops), OpContext, OpError with mapping of core/io/rig errors, reference resolution by id or name, the OpHost interface with an in-memory host, generators for MCP tool JSON, CLI metadata and OPERATIONS.md, and the ops doc.open, doc.summary and rig.setPose. A change listener that throws after a commit is reported as a `warnings` entry, not as a failed call. core: `validate(view, {images})` limits the pixel content checks to the given images.
