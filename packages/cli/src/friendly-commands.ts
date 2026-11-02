/**
 * The hand-named CLI commands (T5.6b): `pf render`, `export`, `lint`, `override import|list|resolve`,
 * `pack` and `unpack`. They are not separate code paths: each is the generated subcommand of an op
 * (same flags, `--save`, `--confirm`, `--out`, JSON on stdout, exit codes) whose `doc` field and a few
 * others became positional arguments. {@link addOpCommand} applies the matching {@link FriendlySpec}
 * when it registers the op, so the command keeps the path `cliMetadata` gives it and nothing is
 * registered twice.
 * @packageDocumentation
 */

/** One positional argument, filling an input field of the op. */
export interface Positional {
  /** The op input field it fills (`doc` takes a file path that is opened first). */
  readonly field: string;
  /** Placeholder shown in the usage line. */
  readonly name: string;
  readonly description: string;
  /** Optional argument (`[name]`). */
  readonly optional?: boolean;
  /** Collects every remaining word into an array (`[name...]`). */
  readonly variadic?: boolean;
}

/** How an op becomes a friendly command. */
export interface FriendlySpec {
  /** The op name. */
  readonly op: string;
  /** Positional arguments, in order. They replace the flags of the same fields. */
  readonly positionals: readonly Positional[];
  /** Input fields that stay flags but are not mandatory here. */
  readonly relax?: readonly string[];
  /** Values used when the flag is not given (only for relaxed fields). */
  readonly defaults?: Readonly<Record<string, unknown>>;
  /** Makes this command the one `pf <group>` runs when its first word is not a subcommand. */
  readonly isDefault?: boolean;
}

const FILE: Positional = {
  field: 'doc',
  name: 'file',
  description: 'The .pxf document to open.',
};

/** The friendly commands, by op name. */
export const FRIENDLY: readonly FriendlySpec[] = [
  {
    op: 'render.frame',
    positionals: [FILE],
    relax: ['frame'],
    defaults: { frame: 0 },
    isDefault: true,
  },
  {
    op: 'io.export',
    positionals: [
      FILE,
      { field: 'path', name: 'sheet.png', description: 'PNG to write; the JSON goes beside it.' },
    ],
  },
  { op: 'lint.run', positionals: [FILE] },
  {
    op: 'override.import',
    positionals: [
      FILE,
      {
        field: 'animation',
        name: 'animation',
        description: 'Animation: "group", "group/direction" or an "anm_..." id.',
      },
      { field: 'frame', name: 'frame', description: 'Frame: 0-based index or a "frm_..." id.' },
      { field: 'file', name: 'edited.png', description: 'The edited PNG (canvas size, scale 1).' },
    ],
  },
  { op: 'override.list', positionals: [FILE] },
  {
    op: 'override.resolve',
    positionals: [
      FILE,
      {
        field: 'overrides',
        name: 'ids',
        description: 'Override ids ("ovr_..."); or use --all-stale.',
        optional: true,
        variadic: true,
      },
    ],
  },
  {
    op: 'pxf.pack',
    positionals: [
      { field: 'dir', name: 'folder.pxfd', description: 'The folder to pack.' },
      {
        field: 'file',
        name: 'out.pxf',
        description: 'The .pxf to write (default: beside the folder).',
        optional: true,
      },
    ],
  },
  {
    op: 'pxf.unpack',
    positionals: [
      { field: 'file', name: 'file.pxf', description: 'The .pxf to expand.' },
      {
        field: 'dir',
        name: 'folder.pxfd',
        description: 'The folder to create (default: beside the file).',
        optional: true,
      },
    ],
  },
];

/** The friendly spec of `op`, if it has one. */
export function friendlyFor(op: string): FriendlySpec | undefined {
  return FRIENDLY.find((f) => f.op === op);
}

/** `"run"`, `"run/side"` or `"anm_x"` as an animation reference; anything else is returned as it is. */
function animationRef(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.startsWith('anm_')) return { id: value };
  const slash = value.indexOf('/');
  return slash < 0
    ? { group: value }
    : { group: value.slice(0, slash), direction: value.slice(slash + 1) };
}

/**
 * Friendly spellings of op input: an animation as `group[/direction]` (also inside `animations`),
 * a frame word as a number when it is one.
 */
export function friendlyValue(field: string, value: unknown): unknown {
  if (field === 'animation') return animationRef(value);
  if (field === 'animations') {
    return Array.isArray(value) ? value.map(animationRef) : [animationRef(value)];
  }
  if (field === 'frame' && typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}
