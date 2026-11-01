---
'@pixel-forge/core': patch
'@pixel-forge/rig': patch
'@pixel-forge/raster': patch
'@pixel-forge/ops': patch
---

G1 gate review fixes. core: `bakeAnimation` inserts the baked layer at the top level (it no longer inherits a group's opacity, visibility or export flag) and hides the rig on every baked frame; `applySkeletonTemplate` refuses (`bone-mismatch`) a reused root whose template parent is missing; `deleteView` refuses (`view-in-use`) a view an authored animation resolves to; `bindParts` counts cel opacity (`animated`, new skip reason `translucent`, cel opacity moves to the layer); `splitRegion` refuses `rig-block-order` when a pixel layer would change which pixels cover which, and `translucent` when translucent art would fold into a part as a variant. rig: `overlapMask` / `overlapMasks` / `checkOverlapPaint` count only fully opaque upper pixels on a layer of opacity 255 as hiding paint (`overlapMasks` takes `layerOpacity`); `attributeEdit` no longer overflows the stack on very large edits; `jointCheck` rejects a sweep with too many steps instead of spinning. raster: `ellipse` / `ellipsePixels` reach the last row of 84 flat sizes up to 24x24 (other sizes unchanged). ops: `rig.bindParts` and `part.split` descriptions list the new skip and refusal reasons.
