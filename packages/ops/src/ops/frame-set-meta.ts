/**
 * `frame.setMeta`: duration, markers, events and root motion of one frame.
 * @packageDocumentation
 */
import { jsonEqual } from '@pixel-forge/core';
import { Name } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import {
  AnimRef,
  DocRef,
  FrameRef,
  animationLabel,
  resolveAuthoredAnimation,
  resolveFrame,
} from '../refs.js';

/** `frame.setMeta` (MCP `frame_set_meta`, CLI `pf frame set-meta`). */
export const frameSetMeta = defineOp({
  name: 'frame.setMeta',
  safety: 'mutate',
  group: 'core',
  summary:
    "Set one frame's duration (ms), markers (name -> int px), events (names) and root motion (int px).",
  description:
    "Only the fields you give change, on this one frame. markers merge by name (null removes one); events replace the whole list; rootMotion is the move the game applies when this frame plays (int px, y down). New marker and event names join the document's markerDefs / eventDefs. Mirror animations have no frames: edit the source.",
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef,
    durationMs: z.int().min(1).optional().describe('Frame duration, ms.'),
    markers: z
      .record(Name, z.strictObject({ x: z.int(), y: z.int() }).nullable())
      .optional()
      .describe(
        'Markers by name, canvas px (e.g. "hand_r": {"x": 30, "y": 20}); null removes one.',
      ),
    events: z
      .array(Name)
      .optional()
      .describe('Event names fired on this frame; replaces the list.'),
    rootMotion: z
      .strictObject({ dx: z.int(), dy: z.int() })
      .optional()
      .describe('Root motion of this frame, int px.'),
  }),
  output: z.strictObject({
    animation: z.string().describe('"group/direction" of the animation.'),
    frameIndex: z.int(),
    frameId: z.string(),
    changed: z.array(z.string()).describe('Fields that changed; empty when nothing did.'),
  }),
  examples: [
    {
      title: 'Hold the hero frame 200 ms and fire a footstep event',
      input: {
        doc: 'doc_g1ed5q',
        animation: { group: 'default' },
        frame: 0,
        durationMs: 200,
        events: ['footstep'],
      },
    },
  ],
  handler: (ctx, input) => {
    const { index: ai, animation } = resolveAuthoredAnimation(ctx.doc, input.animation);
    const { index: fi, frame } = resolveFrame(animation, input.frame);
    if (
      input.durationMs === undefined &&
      input.markers === undefined &&
      input.events === undefined &&
      input.rootMotion === undefined
    ) {
      throw new OpError('BAD_INPUT', 'frame.setMeta needs at least one field to set', {
        issues: [{ path: '', message: 'give durationMs, markers, events or rootMotion' }],
      });
    }
    if (input.events !== undefined && new Set(input.events).size !== input.events.length) {
      throw new OpError('BAD_INPUT', 'events lists a name twice', {
        issues: [{ path: 'events', message: 'event names must be distinct' }],
      });
    }
    const markers: Record<string, { x: number; y: number }> = {};
    for (const [k, v] of Object.entries(frame.markers)) markers[k] = { x: v.x, y: v.y };
    for (const [k, v] of Object.entries(input.markers ?? {})) {
      if (v === null) Reflect.deleteProperty(markers, k);
      else markers[k] = v;
    }
    const sorted = Object.fromEntries(Object.entries(markers).sort(([a], [b]) => (a < b ? -1 : 1)));
    const changed: string[] = [];
    if (input.durationMs !== undefined && input.durationMs !== frame.durationMs) {
      changed.push('durationMs');
    }
    if (input.markers !== undefined && !jsonEqual(sorted, { ...frame.markers })) {
      changed.push('markers');
    }
    if (input.events !== undefined && !jsonEqual([...input.events], [...frame.events] as never)) {
      changed.push('events');
    }
    if (
      input.rootMotion !== undefined &&
      (input.rootMotion.dx !== frame.rootMotion.dx || input.rootMotion.dy !== frame.rootMotion.dy)
    ) {
      changed.push('rootMotion');
    }
    if (changed.length > 0) {
      ctx.tx.update((d) => {
        const anim = d.animations[ai];
        const target = anim !== undefined && 'frames' in anim ? anim.frames[fi] : undefined;
        if (target === undefined) return;
        if (input.durationMs !== undefined) target.durationMs = input.durationMs;
        if (input.markers !== undefined) {
          target.markers = sorted;
          for (const name of Object.keys(sorted)) {
            if (!d.markerDefs.some((m) => m.name === name)) d.markerDefs.push({ name });
          }
        }
        if (input.events !== undefined) {
          target.events = [...input.events];
          for (const name of input.events) {
            if (!d.eventDefs.some((e) => e.name === name)) d.eventDefs.push({ name });
          }
        }
        if (input.rootMotion !== undefined) {
          target.rootMotion = { dx: input.rootMotion.dx, dy: input.rootMotion.dy };
        }
      });
    }
    return { animation: animationLabel(animation), frameIndex: fi, frameId: frame.id, changed };
  },
});
