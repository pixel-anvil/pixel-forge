# Frozen v1 fixtures

Frozen at schema v1 on 2026-10-27. Never regenerate these files.

`minimal-document.json` is a complete `document.json` as schema v1 writes it (pretty-printed,
sorted keys, LF line ends, trailing newline). It was produced once from the hand-written builder
`packages/schema/test/fixtures/src/minimal-doc.ts`; that builder may change, this copy may not.

Future schema versions and migrations must keep this file opening: `Document.parse` accepts it as
long as `schemaVersion` is 1, and once v2 exists the migration registry (`io`) must upgrade it
without error. If a schema change makes this file stop parsing, the change is breaking and needs an
ADR, a version bump and a migration (ADR-005).
