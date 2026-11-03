---
'@pixel-forge/ops': minor
'@pixel-forge/server': minor
---

Add the op `rig.setPartZ` (MCP `rig_set_part_z`, CLI `pf rig set-part-z`): change a part's default z in a view after the part exists, as one undo step. It replaces the per-frame z keys that were needed before. Existing ops keep their schemas; only the `zByBone` field text now points to the new op.
