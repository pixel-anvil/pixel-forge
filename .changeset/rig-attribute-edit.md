---
'@pixel-forge/rig': minor
'@pixel-forge/core': minor
---

Edit attribution (FR-RIG-22/24): `attributeEdit(ctx, before, edited)` turns an edited frame into part overrides (an edit inside exactly one part's footprint that shows through the composite) and a final override for the rest, with 8-bit erase masks (`IndexedImage`, 255), pivot-relative or canvas anchors and `baseHash` taken as `checkOverride` checks it (rig); `attributeEditTx(tx, animRef, frameRef, edited)` builds the context from the export render and writes the overrides, the entry point of `pf override import` (core); `attributeEditTxReport` also lists the existing overrides (this frame, and its mirrors') that the import made stale. `EditContext.finalOnly` and `RigError` code `BAD_ARGUMENT` (reason `before-mismatch`) are additive.
