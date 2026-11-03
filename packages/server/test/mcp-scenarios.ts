// One scenario per MCP tool: how to set up a document, what to call and what the undo stack must
// show afterwards. mcp-tools.test.ts checks the table against tools/list.
import { expect } from 'vitest';
import { HERO_ID } from './mcp-helpers.js';
import type { McpFixture } from './mcp-helpers.js';

export type Base = 'none' | 'hero' | 'flat' | 'flatRig';

export interface Scenario {
  /** The document the call works on (`none`: the call makes or opens its own). */
  readonly base: Base;
  /** Extra tool calls to run (and not count) before the call under test. */
  readonly setup?: (f: McpFixture, doc: string, memo: Record<string, unknown>) => Promise<void>;
  readonly args: (ctx: {
    doc: string;
    root: string;
    memo: Record<string, unknown>;
  }) => Record<string, unknown>;
  /** `one`: exactly one new entry labelled `AI: <op>`; otherwise why the call records none. */
  readonly entry: 'one' | { readonly none: string };
}

const READ = { none: 'read-only' } as const;
const IMAGE = { none: 'read-only (returns an image)' } as const;
const run = [
  [0, 0],
  [0, 1],
  [0, 2],
  [1, 0],
];
const frame0 = { group: 'default' };

/** Gives the document a palette of three colours (the palette tools edit the active one). */
function withPalette(f: McpFixture, doc: string): Promise<void> {
  f.doc(doc).store.transact('palette', (tx) => {
    const id = tx.newId('palette');
    tx.update((d) => {
      d.palettes.push({
        id,
        name: 'test',
        colors: [
          [0, 0, 0, 0],
          [200, 200, 200, 255],
          [20, 20, 20, 255],
        ],
        ramps: [],
      });
      d.activePaletteId = id;
    });
  });
  return Promise.resolve();
}

export const SCENARIOS: Record<string, Scenario> = {
  anim_create: {
    base: 'hero',
    args: ({ doc }) => ({ doc, group: 'run', direction: 'side', frames: 4 }),
    entry: 'one',
  },
  anim_update: {
    base: 'hero',
    args: ({ doc }) => ({ doc, animation: frame0, loop: 'pingpong' }),
    entry: 'one',
  },
  cel_link: {
    base: 'flat',
    setup: async (f, doc) => {
      // the same first cell again, as a separate image: identical pixels to link
      await f.call('import_file', {
        doc,
        file: `${f.root}/run.png`,
        cell: [64, 64],
        animations: [{ group: 'run_copy', cells: [[0, 0]] }],
      });
    },
    args: ({ doc }) => ({ doc, layer: 'body', mode: 'linkIdentical' }),
    entry: 'one',
  },
  convert_apply: {
    base: 'flat',
    args: ({ doc }) => ({
      doc,
      animation: { group: 'run' },
      frame: 0,
      layer: 'body',
      palette: 'pico-8',
    }),
    entry: 'one',
  },
  image_to_sprite: {
    base: 'none',
    args: ({ root }) => ({ file: `${root}/idle.png`, height: 16, palette: 'pico-8' }),
    entry: { none: 'creates a new document; its history starts empty' },
  },
  doc_create: {
    base: 'none',
    args: () => ({ name: 'fresh', width: 32, height: 32 }),
    entry: { none: 'creates a new document; its history starts empty' },
  },
  doc_open: {
    base: 'none',
    args: ({ root }) => ({ path: `${root}/hero.pxf` }),
    entry: { none: 'opens a file; its history starts empty' },
  },
  doc_save: {
    base: 'hero',
    args: ({ doc, root }) => ({ doc, path: `${root}/hero-v2.pxf` }),
    entry: { none: 'writes a file, the document is not changed' },
  },
  doc_set_color_mode: {
    base: 'hero',
    setup: (f, doc) => {
      // M1a has no palette tool: give the document one directly, as the ops tests do
      f.doc(doc).store.transact('palette', (tx) => {
        const id = tx.newId('palette');
        tx.update((d) => {
          d.palettes.push({
            id,
            name: 'test',
            colors: [[0, 0, 0, 0]],
            ramps: [],
          });
          d.activePaletteId = id;
        });
      });
      return Promise.resolve();
    },
    args: ({ doc }) => ({ doc, paletteLocked: true }),
    entry: 'one',
  },
  doc_summary: { base: 'hero', args: ({ doc }) => ({ doc }), entry: READ },
  export: {
    base: 'hero',
    args: ({ doc, root }) => ({ doc, path: `${root}/out/hero.png`, scale: 2 }),
    entry: { none: 'writes files, the document is not changed' },
  },
  frame_add: {
    base: 'hero',
    args: ({ doc }) => ({ doc, animation: frame0, frame: 0 }),
    entry: 'one',
  },
  frame_delete: {
    base: 'hero',
    setup: async (f, doc) => {
      await f.call('frame_add', { doc, animation: frame0, frame: 0 });
    },
    args: ({ doc }) => ({ doc, animation: frame0, frame: 1 }),
    entry: 'one',
  },
  frame_duplicate: {
    base: 'hero',
    args: ({ doc }) => ({ doc, animation: frame0, frame: 0 }),
    entry: 'one',
  },
  frame_set_meta: {
    base: 'hero',
    args: ({ doc }) => ({ doc, animation: frame0, frame: 0, durationMs: 200, events: ['step'] }),
    entry: 'one',
  },
  import_file: {
    base: 'flat',
    args: ({ doc, root }) => ({
      doc,
      file: `${root}/idle.png`,
      cell: [64, 64],
      animations: [
        {
          group: 'idle',
          cells: [[0, 0]],
        },
      ],
    }),
    entry: 'one',
  },
  layer_update: {
    base: 'hero',
    args: ({ doc }) => ({ doc, layer: 'head', visible: false }),
    entry: 'one',
  },
  lint: { base: 'hero', args: ({ doc }) => ({ doc }), entry: READ },
  override_import: {
    base: 'hero',
    setup: async (f, doc) => {
      // the touched-up frame as a PNG: paint it, export it, then undo the paint so the import redoes it
      await f.call('pixels_write_grid', {
        doc,
        animation: frame0,
        frame: 0,
        x: 26,
        y: 4,
        rows: ['21'],
        legend: { '1': '#e8be96', '2': '#1e1e28' },
      });
      await f.call('export', { doc, path: `${f.root}/edited.png`, animations: [frame0] });
      await f.call('undo', { doc });
    },
    args: ({ doc, root }) => ({ doc, animation: frame0, frame: 0, file: `${root}/edited.png` }),
    entry: 'one',
  },
  override_list: { base: 'hero', args: ({ doc }) => ({ doc }), entry: READ },
  override_resolve: {
    base: 'hero',
    setup: async (f, doc, memo) => {
      await f.call('pixels_write_grid', {
        doc,
        animation: frame0,
        frame: 0,
        x: 26,
        y: 4,
        rows: ['21'],
        legend: { '1': '#e8be96', '2': '#1e1e28' },
      });
      const listed = await f.call('override_list', { doc });
      memo.overrides = (listed.json.output as { valid: string[] }).valid;
    },
    args: ({ doc, memo }) => ({ doc, action: 'discard', overrides: memo.overrides }),
    entry: 'one',
  },
  part_paint_overlap: {
    base: 'hero',
    setup: async (f, doc) => {
      await f.call('rig_set_pivot', { doc, part: 'lower_arm_r', pivot: { x: 3, y: 1 } });
    },
    args: ({ doc }) => ({ doc, bones: ['lower_arm_r'] }),
    entry: 'one',
  },
  palette_edit: {
    base: 'hero',
    setup: (f, doc) => withPalette(f, doc),
    args: ({ doc }) => ({
      doc,
      edits: [
        { do: 'add', color: '#1a1c2c' },
        { do: 'replace', index: 1, color: '#b13e53' },
      ],
    }),
    entry: 'one',
  },
  palette_generate: {
    base: 'hero',
    args: ({ doc }) => ({ doc, n: 4, animation: frame0, frame: 0, add: true, name: 'sprite4' }),
    entry: 'one',
  },
  draw_shapes: {
    base: 'hero',
    args: ({ doc }) => ({
      doc,
      animation: frame0,
      frame: 0,
      shapes: [{ type: 'rect', x: 2, y: 2, w: 6, h: 4, color: '#ff0000', filled: true }],
    }),
    entry: 'one',
  },
  selection_transform: {
    base: 'hero',
    args: ({ doc }) => ({
      doc,
      animation: frame0,
      frame: 0,
      region: { x: 20, y: 2, w: 10, h: 10 },
      action: 'move',
      dx: 3,
    }),
    entry: 'one',
  },
  shade_with_ramp: {
    base: 'hero',
    setup: async (f, doc) => {
      await withPalette(f, doc);
      await f.call('palette_ramp', { doc, base: '#e8be96', steps: 3, add: true, name: 'skin' });
    },
    args: ({ doc }) => ({
      doc,
      animation: frame0,
      frame: 0,
      region: { x: 21, y: 2, w: 8, h: 8 },
      ramp: 'skin',
      steps: -1,
    }),
    entry: 'one',
  },
  palette_ramp: {
    base: 'hero',
    setup: (f, doc) => withPalette(f, doc),
    args: ({ doc }) => ({ doc, base: '#c8503c', steps: 5, add: true, name: 'skin' }),
    entry: 'one',
  },
  palette_sort: {
    base: 'hero',
    setup: (f, doc) => withPalette(f, doc),
    args: ({ doc }) => ({ doc, by: 'luminance' }),
    entry: 'one',
  },
  palette_remap: {
    base: 'hero',
    args: ({ doc }) => ({ doc, map: [{ from: '#e8be96', to: '#010203' }] }),
    entry: 'one',
  },
  part_paint_variant: {
    base: 'hero',
    args: ({ doc }) => ({
      doc,
      part: 'lower_arm_r',
      rows: ['11'],
      legend: { '1': '#ff00ff' },
    }),
    entry: 'one',
  },
  part_split: {
    base: 'flatRig',
    args: ({ doc }) => ({
      doc,
      layer: 'body',
      animation: { group: 'run' },
      frame: 0,
      selection: { kind: 'rect', x: 24, y: 16, w: 18, h: 12 },
      partName: 'part:head',
    }),
    entry: 'one',
  },
  pixels_read_grid: {
    base: 'hero',
    args: ({ doc }) => ({ doc, animation: frame0, frame: 0, x: 21, y: 0, width: 8, height: 6 }),
    entry: READ,
  },
  pixels_write_grid: {
    base: 'hero',
    args: ({ doc }) => ({
      doc,
      animation: frame0,
      frame: 0,
      x: 26,
      y: 4,
      rows: ['21'],
      legend: { '1': '#e8be96', '2': '#1e1e28' },
    }),
    entry: 'one',
  },
  pxf_pack: {
    base: 'none',
    setup: async (f) => {
      await f.call('pxf_unpack', { file: f.hero, dir: `${f.root}/hero.pxfd` });
    },
    args: ({ root }) => ({ dir: `${root}/hero.pxfd`, file: `${root}/hero-packed.pxf` }),
    entry: { none: 'writes a file, opens no document' },
  },
  pxf_unpack: {
    base: 'none',
    args: ({ root }) => ({ file: `${root}/hero.pxf`, dir: `${root}/hero.pxfd` }),
    entry: { none: 'writes a folder, opens no document' },
  },
  redo: {
    base: 'hero',
    setup: async (f, doc) => {
      await f.call('frame_add', { doc, animation: frame0, frame: 0 });
      await f.call('undo', { doc });
    },
    args: ({ doc }) => ({ doc }),
    entry: { none: 'moves along the history, adds no entry of its own' },
  },
  render_contact_sheet: {
    base: 'hero',
    args: ({ doc }) => ({ doc, bones: true, pivots: true }),
    entry: IMAGE,
  },
  render_frame: {
    base: 'hero',
    args: ({ doc }) => ({ doc, animation: frame0, frame: 0, scale: 8, bones: true, pivots: true }),
    entry: IMAGE,
  },
  rig_apply_template: {
    base: 'flat',
    args: ({ doc }) => ({ doc, template: 'humanoid-side', viewName: 'side', height: 60 }),
    entry: 'one',
  },
  rig_fit_template: {
    base: 'flatRig',
    args: ({ doc }) => ({
      doc,
      template: 'humanoid-side',
      view: 'side',
      landmarks: {
        headTop: { x: 31, y: 16 },
        hips: { x: 30, y: 44 },
        feet: { x: 30, y: 63 },
        handR: { x: 38, y: 47 },
      },
    }),
    entry: 'one',
  },
  skin_set: {
    base: 'hero',
    setup: (f, doc) => withPalette(f, doc),
    args: ({ doc }) => ({ doc, skin: 'rival', map: [{ from: 1, to: 2 }] }),
    entry: 'one',
  },
  rig_apply_preset: {
    base: 'hero',
    args: ({ doc }) => ({ doc, preset: 'walk', frames: 6 }),
    entry: 'one',
  },
  rig_bake: {
    base: 'hero',
    args: ({ doc }) => ({ doc, animation: frame0, mode: 'new', confirm: true }),
    entry: 'one',
  },
  rig_bind_parts: {
    base: 'flatRig',
    setup: async (f, doc) => {
      await f.call('part_split', {
        doc,
        layer: 'body',
        animation: { group: 'run' },
        frame: 0,
        selection: { kind: 'rect', x: 24, y: 16, w: 18, h: 12 },
        name: 'cap',
        bind: false,
      });
    },
    args: ({ doc }) => ({
      doc,
      layers: ['cap'],
      rawNames: { cap: 'part:head@cap' },
      byOverlap: false,
    }),
    entry: 'one',
  },
  rig_edit_bones: {
    base: 'hero',
    args: ({ doc }) => ({
      doc,
      edits: [{ action: 'addBone', name: 'tail', parent: 'torso', length: 8 }],
    }),
    entry: 'one',
  },
  rig_joint_check: { base: 'hero', args: ({ doc }) => ({ doc }), entry: READ },
  rig_mirror_animation: {
    base: 'hero',
    args: ({ doc }) => ({ doc, source: frame0, direction: 'left' }),
    entry: 'one',
  },
  rig_set_part_z: {
    base: 'hero',
    args: ({ doc }) => ({ doc, part: 'lower_arm_r', z: 5 }),
    entry: 'one',
  },
  rig_copy_pose: {
    base: 'hero',
    setup: async (f, doc) => {
      await f.call('frame_duplicate', { doc, animation: frame0, frame: 0 });
      await f.call('rig_set_pose', {
        doc,
        animation: frame0,
        frame: 0,
        bones: { upper_arm_r: { angle: 30 } },
      });
    },
    args: ({ doc }) => ({
      doc,
      from: { animation: frame0, frame: 0 },
      to: { animation: frame0, frame: 1 },
      mirrored: true,
    }),
    entry: 'one',
  },
  render_compare: {
    base: 'hero',
    setup: async (f, doc) => {
      await f.call('frame_duplicate', { doc, animation: frame0, frame: 0 });
      await f.call('rig_set_pose', {
        doc,
        animation: frame0,
        frame: 1,
        bones: { upper_arm_r: { angle: 40 } },
      });
    },
    args: ({ doc }) => ({
      doc,
      a: { animation: frame0, frame: 0 },
      b: { animation: frame0, frame: 1 },
    }),
    entry: IMAGE,
  },
  rig_read_pose: {
    base: 'hero',
    args: ({ doc }) => ({ doc, animation: frame0, frame: 0 }),
    entry: READ,
  },
  rig_fit_pose: {
    base: 'hero',
    setup: async (f, doc) => {
      // frame 0 at rest, frame 1 posed: fit frame 0 to the render of frame 1
      await f.call('frame_duplicate', { doc, animation: frame0, frame: 0 });
      await f.call('rig_set_pose', {
        doc,
        animation: frame0,
        frame: 0,
        bones: { upper_arm_r: { angle: 0 } },
      });
      await f.call('rig_set_pose', {
        doc,
        animation: frame0,
        frame: 1,
        bones: { upper_arm_r: { angle: -40 } },
      });
    },
    args: ({ doc }) => ({
      doc,
      animation: frame0,
      frame: 0,
      targetFrame: 1,
      bones: ['upper_arm_r'],
    }),
    entry: READ,
  },
  rig_set_pivot: {
    base: 'hero',
    args: ({ doc }) => ({ doc, part: 'lower_arm_r', pivot: { x: 3, y: 1 } }),
    entry: 'one',
  },
  rig_set_pose: {
    base: 'hero',
    args: ({ doc }) => ({
      doc,
      animation: frame0,
      frame: 0,
      bones: { upper_arm_r: { angle: -45 } },
    }),
    entry: 'one',
  },
  undo: {
    base: 'hero',
    setup: async (f, doc) => {
      await f.call('frame_add', { doc, animation: frame0, frame: 0 });
    },
    args: ({ doc }) => ({ doc }),
    entry: { none: 'reverts the newest entry, adds none' },
  },
};

/** Opens the scenario's base document and returns its id. */
export async function prepare(f: McpFixture, base: Base): Promise<string> {
  if (base === 'none') return '';
  if (base === 'hero') {
    const opened = await f.call('doc_open', { path: f.hero });
    expect(opened.isError, opened.text).toBe(false);
    return HERO_ID;
  }
  const created = await f.call('doc_create', { name: 'flat', width: 64, height: 64 });
  expect(created.isError, created.text).toBe(false);
  const doc = (created.json.output as { doc: string }).doc;
  const imported = await f.call('import_file', {
    doc,
    file: `${f.root}/run.png`,
    cell: [64, 64],
    animations: [{ group: 'run', cells: run }],
  });
  expect(imported.isError, imported.text).toBe(false);
  if (base === 'flatRig') {
    const rigged = await f.call('rig_apply_template', {
      doc,
      template: 'humanoid-side',
      viewName: 'side',
      height: 60,
    });
    expect(rigged.isError, rigged.text).toBe(false);
  }
  return doc;
}
