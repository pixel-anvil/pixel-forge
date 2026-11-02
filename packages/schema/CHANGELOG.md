# @pixel-forge/schema

## 0.1.0

### Minor Changes

- a5112e2: FK with exact key interpolation and quantisation, hierarchical snapping (ADR-012), prepareAnimation/PreparedAnimation; schema exports isValidAngleQuantum and angleQuantumSteps.
- a2dbd50: Add the v1 domain model: branded ids with a deterministic seeded generator, constants, zod schemas and inferred types for the document, palettes, skins, layer tree, cels, rig, animations, frames, keys, overrides, `manifest.json` and `render/index.json`, op references (`AnimRef`, `FrameRef`), and JSON Schema export.
- First release (M1a): the headless core, `.pxf` and `.aseprite` I/O, rig and RotSprite, lint, the operation API, the MCP server, the `pf` CLI and the Godot import addon.
