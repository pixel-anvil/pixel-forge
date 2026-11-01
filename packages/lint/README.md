# @pixel-forge/lint

Findings: palette, orphans, joints, stale overrides, rotation residual and opacity.

**Depends on:** `core`, `rig` (tests also use `schema`, `raster`, `testkit`). Pure: reads a document, renders through `core`, never writes.

**Status:** T4.1: `lint`, the rule registry and seven rule areas below.

## Use

```ts
import { lint } from '@pixel-forge/lint';

const findings = lint(store, {
  disable: ['pixels.orphan'],
  skins: ['base'],
  animations: [{ group: 'run' }],
});
for (const f of findings) console.log(f.rule, f.severity, f.location, f.message);
```

`lint(view, opts?) -> LintFinding[]` takes a store, snapshot or transaction. It creates its own `createRigRenderer()` and passes it to `renderFrame` (KNOWN_ISSUES CORE-03: `renderFrame` has no default rig renderer). A frame that fails to render yields a `lint.renderError` finding (error) and is skipped by the render-based rules; an unknown animation in `opts.animations` throws `CoreError('BAD_ARGUMENT')`.

Options: `enable` (run only these rules), `disable` (applied after `enable`), `animations` (`{id}` or `{group, direction?}`; default all, mirrors included), `skins` (`'base'`, `{id}` or `{name}`; default `base` plus every skin), `maxPixels` (pixels listed per finding, default 16).

A finding is `{rule, severity: 'error' | 'warning' | 'info', location, message, data}`. `location` may hold `layerId`, `animationId`, `frameId`, `frameIndex`, `skin`, `pixel {x, y}` (the first one), `overrideId`, `view`, `bone`. `data` is JSON.

**Order**: by rule in `RULE_IDS` order (the table below), then by document order inside the rule (animation, frame, skin, pixel y then x; layers in tree order, cels by frame id). The same document gives the same list.

## Rules

| Rule                      | Severity | Reports                                                                                                                                                                                                                                                                                                                                                                                             | `data`                                                                 |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `palette.offPalette`      | error    | In a locked document (indexed, or `paletteLocked`), a frame of the **render output** has an opaque (alpha > 0) pixel whose RGB is not a palette colour. One finding per frame and skin. Base and remap skins are checked against the active palette; a palette skin against its own palette (a pixel its palette has no entry for stays in the base colour and is reported). Alpha is ignored here. | `count`, `pixels`, `colors` (hex)                                      |
| `palette.opacityInLocked` | warning  | A layer, group or image cel with opacity below 255 in a locked document (FR-PAL-06).                                                                                                                                                                                                                                                                                                                | `opacity`, `scope` (`layer` or `cel`), `layerName`                     |
| `pixels.orphan`           | info     | An opaque pixel of the unskinned render with no opaque pixel among its 8 neighbours (the `removeOrphans` post-pass definition, raster defaults). Spec 3.4 only names the pass, so this definition is the simplest one that matches it. `info` because a lone pixel can be intended (an eye, a sparkle).                                                                                             | `count`, `pixels`                                                      |
| `rig.jointGap`            | warning  | A joint with gap pixels in the joint check (FR-RIG-05, `docs/contracts/JOINT_CHECK.md`), run per rig view with its first direction and the defaults (+-30 degrees, step 5, radius 4). One finding per joint. If the check itself throws a rig error, one `error` finding with the code.                                                                                                             | `parent`, `gapCount`, `unionCount`, `union`, `angles [{angle, count}]` |
| `rig.staleOverride`       | warning  | `checkOverrides` marks an override stale: `hash` or `no-target` (FR-RIG-22).                                                                                                                                                                                                                                                                                                                        | `target`, `mirror`, `reason`                                           |
| `rig.overrideError`       | error    | `checkOverrides` could not check an override because the render failed (`reason: 'error'`, KNOWN_ISSUES CORE-03); kept out of `staleOverride`.                                                                                                                                                                                                                                                      | `target`, `mirror`, `errorCode`                                        |
| `rig.rotationResidual`    | warning  | **Stub**: registered, returns no findings. TODO(M1b, the variant auto-select card, FR-RIG-14): report a part whose residual exceeds `maxResidualDeg` (default 22.5). There is no auto-select yet, so no residual exists.                                                                                                                                                                            | none                                                                   |
| `anim.emptyFrame`         | warning  | A frame whose unskinned render is fully transparent.                                                                                                                                                                                                                                                                                                                                                | none                                                                   |
| `lint.renderError`        | error    | A frame could not be rendered. Runs last; only has findings if a render-based rule ran.                                                                                                                                                                                                                                                                                                             | `code`                                                                 |

Not implemented: the duplicate-palette-colour-under-a-skin warning noted in the core README (renderFrame, Skin).

## Evidence

`test/lint.test.ts` with the hand-drawn documents of `test/fixtures.ts`: every rule has a fixture that triggers it and one that does not, plus option handling, determinism, and the clean rig document (`capped` elbow, the `fixtures/joint/clean_capped_elbow` shape) with no findings. The synthetic hero is not used here: `lint` may not depend on `io`; it fails the joint check (T3.4 notes), which `rig.jointGap` would report.
