# Architecture Decision Records

One decision per file, at most one page. Numbering is stable; supersede rather than rewrite accepted ADRs.

| ID | Title | Status |
|---|---|---|
| [ADR-001](ADR-001.md) | Option D: greenfield headless-core TypeScript app | Accepted |
| [ADR-002](ADR-002.md) | Package graph and layering | Accepted |
| [ADR-003](ADR-003.md) | Operation API as a zod registry | Accepted |
| [ADR-004](ADR-004.md) | Single document owner with snapshot sync | Accepted |
| [ADR-005](ADR-005.md) | `.pxf` as a zip with a render cache | Accepted |
| [ADR-006](ADR-006.md) | Browser-first editor; desktop shell deferred | Accepted |
| [ADR-007](ADR-007.md) | Sparse tiles and patch-based history | Accepted |
| [ADR-008](ADR-008.md) | RotSprite, part variants and overrides (warping deferred) | Proposed (pending T0.4, T1.6) |
| [ADR-009](ADR-009.md) | Godot: engine-neutral baked output plus a driver | Accepted |
| [ADR-010](ADR-010.md) | Determinism rules | Proposed (pending T1.6) |
| [ADR-011](ADR-011.md) | Views and mirroring model | Accepted |
| [ADR-012](ADR-012.md) | Rig maths conventions (refines spec §3.4.7) | Accepted (T3.1) |

## Template

```md
# ADR-NNN: Title

- **Status**: Proposed | Accepted | Superseded by ADR-NNN
- **Date**: YYYY-MM-DD

## Context
## Decision
## Consequences
## Links
Spec sections, review IDs, plan cards.
```

A breaking change to the file schema, the op API or `__pf` needs a new ADR and a migration.
