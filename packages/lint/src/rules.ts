/**
 * The rule registry. A rule is `{id, severity, summary, run(ctx)}`; `run` returns its findings in a
 * deterministic order (document order: animation, frame, skin, then pixel y then x). See the README
 * and `docs/ai/PLAYBOOKS.md`, "add a lint rule".
 * @packageDocumentation
 */
import { CoreError, checkOverrides } from '@pixel-forge/core';
import { JointCheckError, RigError, jointCheck } from '@pixel-forge/rig';
import type { LintContext, SkinTarget } from './context.js';
import { RULE_IDS } from './types.js';
import type { LintFinding, LintSeverity, RuleId } from './types.js';

/** One lint rule. */
export interface LintRule {
  readonly id: RuleId;
  /** Severity of its findings (a rule may report a different one where it says so). */
  readonly severity: LintSeverity;
  /** One line for docs and `--list`. */
  readonly summary: string;
  run(ctx: LintContext): LintFinding[];
}

const BASE: SkinTarget = { key: 'base', ref: 'base' };

/** Pixels (y, then x) matching `pred` over a dense RGBA buffer. */
function scan(
  data: Uint8Array,
  w: number,
  h: number,
  pred: (x: number, y: number, o: number) => boolean,
): [number, number][] {
  const out: [number, number][] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (pred(x, y, (y * w + x) * 4)) out.push([x, y]);
  return out;
}

const rgbKey = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;

function activeColors(ctx: LintContext): readonly (readonly number[])[] {
  const pal = ctx.doc.palettes.find((p) => p.id === ctx.doc.activePaletteId);
  return pal?.colors ?? [];
}

const offPalette: LintRule = {
  id: 'palette.offPalette',
  severity: 'error',
  summary:
    'A locked document renders a colour that is not in the palette (checked on the render output, per skin).',
  run(ctx) {
    if (!ctx.locked) return [];
    const base = new Set<number>();
    for (const c of activeColors(ctx))
      if ((c[3] ?? 0) > 0) base.add(rgbKey(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0));
    const out: LintFinding[] = [];
    const frames = ctx.frames();
    for (const f of frames) {
      for (const skin of ctx.skins()) {
        const img = ctx.render(f, skin);
        if (img === undefined) continue;
        // A palette skin replaces the palette: its own colours are the allowed ones (a pixel its
        // palette has no entry for stays in the base colour and is reported). A remap skin only
        // produces palette colours.
        const def =
          skin.key === 'base' ? undefined : ctx.doc.skins.find((s) => s.name === skin.key);
        let allowed = base;
        if (def !== undefined && 'paletteId' in def) {
          allowed = new Set<number>();
          const sp = ctx.doc.palettes.find((p) => p.id === def.paletteId);
          for (const c of sp?.colors ?? []) if (c[3] > 0) allowed.add(rgbKey(c[0], c[1], c[2]));
        }
        const { data, width, height } = img.toRGBA();
        const bad = scan(
          data,
          width,
          height,
          (_x, _y, o) =>
            (data[o + 3] ?? 0) > 0 &&
            !allowed.has(rgbKey(data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0)),
        );
        if (bad.length === 0) continue;
        const colors = [
          ...new Set(
            bad.map(([x, y]) => {
              const o = (y * width + x) * 4;
              return [data[o], data[o + 1], data[o + 2]]
                .map((v) => (v ?? 0).toString(16).padStart(2, '0'))
                .join('');
            }),
          ),
        ].sort();
        out.push({
          rule: 'palette.offPalette',
          severity: 'error',
          location: { ...ctx.at(f, skin.key), pixel: { x: bad[0]?.[0] ?? 0, y: bad[0]?.[1] ?? 0 } },
          message: `${String(bad.length)} pixel(s) use colours outside the palette (skin ${skin.key})`,
          data: { count: bad.length, pixels: ctx.cap(bad), colors: colors.slice(0, ctx.maxPixels) },
        });
      }
    }
    return out;
  },
};

const opacityInLocked: LintRule = {
  id: 'palette.opacityInLocked',
  severity: 'warning',
  summary: 'A layer or cel has opacity below 100% in a locked document (FR-PAL-06).',
  run(ctx) {
    if (!ctx.locked) return [];
    const out: LintFinding[] = [];
    const animOf = new Map<string, string>();
    for (const a of ctx.doc.animations)
      if ('frames' in a) for (const fr of a.frames) animOf.set(fr.id, a.id);
    const walk = (layers: typeof ctx.doc.layers): void => {
      for (const l of layers) {
        if (l.opacity < 255) {
          out.push({
            rule: 'palette.opacityInLocked',
            severity: 'warning',
            location: { layerId: l.id },
            message: `layer "${l.name}" has opacity ${String(l.opacity)}/255 in a locked document`,
            data: { opacity: l.opacity, scope: 'layer', layerName: l.name },
          });
        }
        if (l.kind === 'group') walk(l.children);
        else if (l.kind === 'pixel' || l.kind === 'reference') {
          for (const frameId of Object.keys(l.cels).sort()) {
            const cel = l.cels[frameId as keyof typeof l.cels];
            if (cel === undefined || !('imageId' in cel) || cel.opacity >= 255) continue;
            const animationId = animOf.get(frameId);
            out.push({
              rule: 'palette.opacityInLocked',
              severity: 'warning',
              location: {
                layerId: l.id,
                frameId,
                ...(animationId === undefined ? {} : { animationId }),
              },
              message: `cel of layer "${l.name}" has opacity ${String(cel.opacity)}/255 in a locked document`,
              data: { opacity: cel.opacity, scope: 'cel', layerName: l.name },
            });
          }
        }
      }
    };
    walk(ctx.doc.layers);
    return out;
  },
};

const orphan: LintRule = {
  id: 'pixels.orphan',
  severity: 'info',
  summary:
    'An opaque pixel of the render has no opaque pixel among its 8 neighbours (the removeOrphans post-pass definition).',
  run(ctx) {
    const out: LintFinding[] = [];
    for (const f of ctx.frames()) {
      const img = ctx.render(f, BASE);
      if (img === undefined) continue;
      const { data, width: w, height: h } = img.toRGBA();
      const opaque = (x: number, y: number): boolean =>
        x >= 0 && y >= 0 && x < w && y < h && (data[(y * w + x) * 4 + 3] ?? 0) > 0;
      const lone = scan(data, w, h, (x, y, o) => {
        if ((data[o + 3] ?? 0) === 0) return false;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if ((dx !== 0 || dy !== 0) && opaque(x + dx, y + dy)) return false;
        return true;
      });
      if (lone.length === 0) continue;
      out.push({
        rule: 'pixels.orphan',
        severity: 'info',
        location: { ...ctx.at(f), pixel: { x: lone[0]?.[0] ?? 0, y: lone[0]?.[1] ?? 0 } },
        message: `${String(lone.length)} isolated pixel(s)`,
        data: { count: lone.length, pixels: ctx.cap(lone) },
      });
    }
    return out;
  },
};

const jointGap: LintRule = {
  id: 'rig.jointGap',
  severity: 'warning',
  summary:
    'A joint opens a gap on the outer side of a bend within the sweep (FR-RIG-05, JOINT_CHECK.md).',
  run(ctx) {
    const rig = ctx.doc.rig;
    if (rig === undefined) return [];
    const out: LintFinding[] = [];
    const palette =
      ctx.doc.meta.colorMode === 'indexed'
        ? activeColors(ctx).map((c): [number, number, number, number] => [
            c[0] ?? 0,
            c[1] ?? 0,
            c[2] ?? 0,
            c[3] ?? 0,
          ])
        : undefined;
    for (const view of rig.views) {
      let report;
      try {
        report = jointCheck({
          rig,
          images: ctx.view,
          canvas: ctx.doc.meta.canvas,
          ...(view.directions[0] === undefined ? {} : { direction: view.directions[0] }),
          ...(palette === undefined ? {} : { palette }),
        });
      } catch (e) {
        if (!(e instanceof JointCheckError || e instanceof RigError)) throw e;
        out.push({
          rule: 'rig.jointGap',
          severity: 'error',
          location: { view: view.name },
          message: `joint check could not run on view "${view.name}": ${e.message}`,
          data: { code: e.code },
        });
        continue;
      }
      for (const j of report.joints) {
        if (j.gapCount === 0) continue;
        out.push({
          rule: 'rig.jointGap',
          severity: 'warning',
          location: {
            view: view.name,
            bone: j.bone,
            pixel: { x: j.union[0]?.[0] ?? 0, y: j.union[0]?.[1] ?? 0 },
          },
          message: `joint ${j.parent} > ${j.bone} has ${String(j.union.length)} gap pixel(s) (${String(j.gapCount)} over the sweep)`,
          data: {
            parent: j.parent,
            gapCount: j.gapCount,
            unionCount: j.union.length,
            union: ctx.cap(j.union),
            angles: j.angles
              .filter((a) => a.gaps.length > 0)
              .map((a) => ({ angle: a.angle, count: a.gaps.length })),
          },
        });
      }
    }
    return out;
  },
};

function overrideFindings(ctx: LintContext, errors: boolean): LintFinding[] {
  const statuses = checkOverrides(ctx.view, {
    ...(ctx.opts.animations === undefined ? {} : { animations: ctx.opts.animations }),
    rig: ctx.rig,
  });
  const out: LintFinding[] = [];
  for (const s of statuses) {
    if (!s.stale || (s.reason === 'error') !== errors) continue;
    const target = s.target === 'final' ? 'final' : s.target.partId;
    const location = { overrideId: s.overrideId, animationId: s.animationId, frameId: s.frameId };
    if (errors) {
      out.push({
        rule: 'rig.overrideError',
        severity: 'error',
        location,
        message: `override ${s.overrideId} could not be checked: ${s.errorMessage ?? 'render failed'}`,
        data: { target, mirror: s.mirror, errorCode: s.errorCode ?? null },
      });
    } else {
      out.push({
        rule: 'rig.staleOverride',
        severity: 'warning',
        location,
        message: `override ${s.overrideId} is stale (${s.reason ?? 'hash'})`,
        data: { target, mirror: s.mirror, reason: s.reason ?? 'hash' },
      });
    }
  }
  return out;
}

const staleOverride: LintRule = {
  id: 'rig.staleOverride',
  severity: 'warning',
  summary:
    'An override no longer matches what it was drawn over (FR-RIG-22): stale by hash or no target.',
  run: (ctx) => overrideFindings(ctx, false),
};

const overrideError: LintRule = {
  id: 'rig.overrideError',
  severity: 'error',
  summary: 'An override could not be checked because its target failed to render (CORE-03).',
  run: (ctx) => overrideFindings(ctx, true),
};

const rotationResidual: LintRule = {
  id: 'rig.rotationResidual',
  severity: 'warning',
  summary:
    'A part is rotated by more than maxResidualDeg (default 22.5) from its drawn variant (FR-RIG-14). Stub.',
  run() {
    // TODO(M1b, card for FR-RIG-14 variant auto-select): report residual > maxResidualDeg. Variant
    // auto-select does not exist yet, so there is no residual to measure; registered, no findings.
    return [];
  },
};

const emptyFrame: LintRule = {
  id: 'anim.emptyFrame',
  severity: 'warning',
  summary: 'A frame renders fully transparent.',
  run(ctx) {
    const out: LintFinding[] = [];
    for (const f of ctx.frames()) {
      const img = ctx.render(f, BASE);
      if (img === undefined) continue;
      const { data } = img.toRGBA();
      let any = false;
      for (let i = 3; i < data.length && !any; i += 4) any = (data[i] ?? 0) > 0;
      if (any) continue;
      out.push({
        rule: 'anim.emptyFrame',
        severity: 'warning',
        location: ctx.at(f),
        message: `frame ${String(f.frameIndex)} renders nothing`,
        data: {},
      });
    }
    return out;
  },
};

const renderError: LintRule = {
  id: 'lint.renderError',
  severity: 'error',
  summary: 'A frame could not be rendered, so the render-based rules skipped it. Runs last.',
  run: (ctx) => [...ctx.renderErrors],
};

const ALL: readonly LintRule[] = [
  offPalette,
  opacityInLocked,
  orphan,
  jointGap,
  staleOverride,
  overrideError,
  rotationResidual,
  emptyFrame,
  renderError,
];

/** Every rule in registry order (the order of {@link RULE_IDS}; findings come out in this order). */
export const RULES: readonly LintRule[] = RULE_IDS.map((id) => {
  const r = ALL.find((x) => x.id === id);
  if (r === undefined) throw new CoreError('BAD_ARGUMENT', `rule ${id} is not registered`);
  return r;
});
