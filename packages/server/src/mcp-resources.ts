/**
 * The resource half of the MCP server (FR-AI-15): read-only JSON views of the open documents.
 *
 * | URI | Content |
 * | --- | --- |
 * | `pf://docs` | the open documents (id, name, path, version, dirty, canvas, counts) |
 * | `pf://doc/{id}/summary` | the `doc.summary` output |
 * | `pf://doc/{id}/palette` | colour mode, palette lock and the palettes (colours as hex) |
 * | `pf://doc/{id}/rig` | the `rig` section of `doc.summary` (bones, parts, views), or `null` |
 * | `pf://doc/{id}/animations/{group}/{direction}` | one animation and its frames |
 * | `pf://doc/{id}/animations/{group}` | the same for an undirected animation (additive) |
 * | `pf://doc/{id}/animations/{group}/{direction}/pose/{frame}` | the `rig.readPose` output of one frame |
 * | `pf://doc/{id}/animations/{group}/pose/{frame}` | the same for an undirected animation |
 *
 * Summaries and rigs come from the `doc.summary` op and animations are resolved with the ops
 * `resolveAnimation` helper, so a name means the same thing as in a tool call. An unknown document,
 * animation or URI is an MCP error (`-32002` resource not found, `-32602` for a malformed URI), not
 * an empty result.
 * @packageDocumentation
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { OpError, animationLabel, resolveAnimation, toHex } from '@pixel-forge/ops';
import type { HostedDocument, OpHost, OpRegistry } from '@pixel-forge/ops';

/** The MCP error code for a resource that does not exist (MCP specification, resources). */
export const RESOURCE_NOT_FOUND = -32002;

const JSON_MIME = 'application/json';

/** What the resources need from the server. */
export interface ResourceContext {
  readonly host: OpHost;
  readonly registry: OpRegistry;
  /** Set when calls are forwarded to `pf serve`: resources then have no documents to show. */
  readonly forwarding: boolean;
}

/** A concrete resource of `resources/list`. */
export interface ResourceEntry {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

/** A URI template of `resources/templates/list`. */
export interface ResourceTemplateEntry {
  readonly uriTemplate: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

/** The templates the server serves. */
export const RESOURCE_TEMPLATES: readonly ResourceTemplateEntry[] = [
  {
    uriTemplate: 'pf://doc/{id}/summary',
    name: 'Document summary',
    description: 'Canvas, palette, layers, rig and animations of an open document (doc_summary).',
    mimeType: JSON_MIME,
  },
  {
    uriTemplate: 'pf://doc/{id}/palette',
    name: 'Document palette',
    description: 'Colour mode, palette lock and the palettes with their colours as hex.',
    mimeType: JSON_MIME,
  },
  {
    uriTemplate: 'pf://doc/{id}/rig',
    name: 'Document rig',
    description: 'Bones, parts and views by the names the tools take; null without a rig.',
    mimeType: JSON_MIME,
  },
  {
    uriTemplate: 'pf://doc/{id}/animations/{group}/{direction}',
    name: 'Animation',
    description: 'One animation with its frames (duration, markers, events, root motion).',
    mimeType: JSON_MIME,
  },
  {
    uriTemplate: 'pf://doc/{id}/animations/{group}',
    name: 'Undirected animation',
    description: 'The same for an animation without a direction.',
    mimeType: JSON_MIME,
  },
  {
    uriTemplate: 'pf://doc/{id}/animations/{group}/{direction}/pose/{frame}',
    name: 'Frame pose',
    description:
      'Bone and part values of one frame (index or frame id) and which are keys (rig_read_pose).',
    mimeType: JSON_MIME,
  },
  {
    uriTemplate: 'pf://doc/{id}/animations/{group}/pose/{frame}',
    name: 'Undirected frame pose',
    description: 'The same for an animation without a direction.',
    mimeType: JSON_MIME,
  },
];

/** The slice of the `doc.summary` output the resources use. */
interface SummaryView {
  readonly doc: string;
  readonly name: string;
  readonly path: string | null;
  readonly version: number;
  readonly dirty: boolean;
  readonly canvas: { readonly w: number; readonly h: number };
  readonly rig: unknown;
  readonly animations: readonly unknown[];
  readonly layers: readonly unknown[];
}

const notFound = (uri: string, what: string, details: Record<string, unknown> = {}): McpError =>
  new McpError(RESOURCE_NOT_FOUND, `${what}: ${uri}`, { uri, ...details });

function forwardingError(uri: string): McpError {
  const error = new OpError(
    'NOT_IMPLEMENTED',
    'a pf serve process is running and calls are forwarded to it; forwarding arrives with M2, so this server has no documents to show',
    { reason: 'forwarding' },
  );
  return new McpError(ErrorCode.InternalError, error.message, { uri, ...error.toJSON() });
}

async function summaryOf(ctx: ResourceContext, hosted: HostedDocument): Promise<SummaryView> {
  const result = await ctx.registry.call('doc.summary', { doc: hosted.id }, { host: ctx.host });
  if (!result.ok) throw new McpError(ErrorCode.InternalError, result.error.message, result.error);
  return result.output as SummaryView;
}

/** The concrete resources of `resources/list`: `pf://docs` and, per open document, its views. */
export function listResources(ctx: ResourceContext): ResourceEntry[] {
  const docs: ResourceEntry[] = [
    {
      uri: 'pf://docs',
      name: 'Open documents',
      description: 'The documents open in this server.',
      mimeType: JSON_MIME,
    },
  ];
  if (ctx.forwarding) return docs;
  for (const hosted of ctx.host.list()) {
    const base = `pf://doc/${hosted.id}`;
    const label = `${hosted.store.doc.meta.name} (${hosted.id})`;
    const entry = (path: string, name: string, description: string): ResourceEntry => ({
      uri: `${base}/${path}`,
      name: `${label}: ${name}`,
      description,
      mimeType: JSON_MIME,
    });
    docs.push(
      entry('summary', 'summary', 'Canvas, palette, layers, rig and animations.'),
      entry('palette', 'palette', 'Colour mode, palette lock and palettes.'),
      entry('rig', 'rig', 'Bones, parts and views.'),
    );
    for (const a of hosted.store.doc.animations) {
      const where = animationLabel(a);
      docs.push(entry(`animations/${where}`, `animation ${where}`, 'Frames of the animation.'));
    }
  }
  return docs;
}

type Parsed =
  | { readonly kind: 'docs' }
  | {
      readonly kind: 'summary' | 'palette' | 'rig';
      readonly id: string;
    }
  | {
      readonly kind: 'animation';
      readonly id: string;
      readonly group: string;
      readonly direction: string | undefined;
    }
  | {
      readonly kind: 'pose';
      readonly id: string;
      readonly group: string;
      readonly direction: string | undefined;
      readonly frame: string;
    };

function parseUri(uri: string): Parsed {
  const bad = (): never => {
    throw notFound(uri, 'unknown resource');
  };
  if (!uri.startsWith('pf://')) return bad();
  let parts: string[];
  try {
    parts = uri
      .slice('pf://'.length)
      .split('/')
      .map((s) => decodeURIComponent(s));
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `malformed resource URI: ${uri}`, { uri });
  }
  const [head, id, view, group, direction] = parts;
  const poseFrame = (at: number): string | undefined => {
    const f = parts[at + 1];
    return parts[at] === 'pose' && parts.length === at + 2 && f !== undefined && f !== ''
      ? f
      : undefined;
  };
  if (parts.length === 1 && head === 'docs') return { kind: 'docs' };
  if (head !== 'doc' || id === undefined || id === '') return bad();
  if (parts.length === 3 && (view === 'summary' || view === 'palette' || view === 'rig')) {
    return { kind: view, id };
  }
  if (view === 'animations' && group !== undefined && group !== '') {
    if (parts.length === 4) return { kind: 'animation', id, group, direction: undefined };
    const plain = poseFrame(4);
    if (plain !== undefined) return { kind: 'pose', id, group, direction: undefined, frame: plain };
    const directed = poseFrame(5);
    if (directed !== undefined && direction !== undefined && direction !== '') {
      return { kind: 'pose', id, group, direction, frame: directed };
    }
    if (parts.length === 5 && direction !== undefined && direction !== '') {
      return { kind: 'animation', id, group, direction };
    }
  }
  return bad();
}

const json = (uri: string, value: unknown): ResourceContents => ({
  contents: [{ uri, mimeType: JSON_MIME, text: JSON.stringify(value) }],
});

/** The result of `resources/read`. */
export interface ResourceContents {
  [key: string]: unknown;
  readonly contents: readonly { uri: string; mimeType: string; text: string }[];
}

/**
 * Reads one resource.
 * @throws McpError `-32002` for an unknown document, animation or URI; `-32602` for a URI that
 *   cannot be decoded.
 */
export async function readResource(ctx: ResourceContext, uri: string): Promise<ResourceContents> {
  const target = parseUri(uri);
  if (ctx.forwarding) throw forwardingError(uri);
  if (target.kind === 'docs') {
    const documents = [];
    for (const hosted of ctx.host.list()) {
      const s = await summaryOf(ctx, hosted);
      documents.push({
        doc: s.doc,
        name: s.name,
        path: s.path,
        version: s.version,
        dirty: s.dirty,
        canvas: s.canvas,
        layers: s.layers.length,
        animations: s.animations.length,
        rig: s.rig !== null,
      });
    }
    return json(uri, { documents });
  }
  const hosted = ctx.host.list().find((d) => d.id === target.id);
  if (hosted === undefined) {
    throw notFound(uri, 'document is not open', {
      available: ctx.host.list().map((d) => d.id),
    });
  }
  switch (target.kind) {
    case 'summary':
      return json(uri, await summaryOf(ctx, hosted));
    case 'rig':
      return json(uri, { doc: hosted.id, rig: (await summaryOf(ctx, hosted)).rig });
    case 'palette': {
      const doc = hosted.store.doc;
      return json(uri, {
        doc: hosted.id,
        colorMode: doc.meta.colorMode,
        paletteLocked: doc.meta.paletteLocked,
        active: doc.activePaletteId ?? null,
        palettes: doc.palettes.map((p) => ({
          id: p.id,
          name: p.name,
          colors: p.colors.map((c) => toHex(c)),
          ramps: p.ramps.map((r) => ({ name: r.name, indices: [...r.indices] })),
        })),
      });
    }
    case 'pose': {
      const animation =
        target.direction === undefined
          ? { group: target.group }
          : { group: target.group, direction: target.direction };
      const frame = /^\d+$/.test(target.frame) ? Number(target.frame) : target.frame;
      const result = await ctx.registry.call(
        'rig.readPose',
        { doc: hosted.id, animation, frame },
        { host: ctx.host },
      );
      if (!result.ok) {
        if (result.error.code === 'NOT_FOUND') {
          throw notFound(uri, 'animation or frame not found', result.error.details);
        }
        throw new McpError(ErrorCode.InternalError, result.error.message, result.error);
      }
      return json(uri, { doc: hosted.id, ...(result.output as object) });
    }
    case 'animation': {
      const doc = hosted.store.doc;
      const ref =
        target.direction === undefined
          ? { group: target.group }
          : { group: target.group, direction: target.direction };
      let resolved;
      try {
        resolved = resolveAnimation(doc, ref);
      } catch (e) {
        if (e instanceof OpError && e.code === 'NOT_FOUND') {
          throw notFound(uri, 'animation not found', {
            available: e.details.available ?? [],
          });
        }
        throw e;
      }
      const { animation } = resolved;
      const source =
        'mirrorOf' in animation
          ? doc.animations.find((a) => a.id === animation.mirrorOf)
          : animation;
      const frames = source !== undefined && 'frames' in source ? source.frames : [];
      return json(uri, {
        doc: hosted.id,
        id: animation.id,
        label: animationLabel(animation),
        group: animation.group,
        direction: animation.direction ?? null,
        loop: source !== undefined && 'loop' in source ? source.loop : null,
        mirrorOf: source !== undefined && source !== animation ? animationLabel(source) : null,
        overrides: animation.overrides.length,
        frames: frames.map((f, index) => ({
          index,
          id: f.id,
          durationMs: f.durationMs,
          markers: f.markers,
          events: f.events,
          rootMotion: f.rootMotion,
        })),
      });
    }
  }
}
