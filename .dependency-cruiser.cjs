/**
 * Encodes the package graph of spec section 6.2 (plus `png` and `testkit`).
 * Each package may import only the workspace packages listed in ALLOWED (direct edges).
 */
const ALLOWED = {
  png: [],
  testkit: ['png'],
  schema: [],
  color: ['schema'],
  raster: ['schema', 'color'],
  rig: ['schema', 'raster'],
  convert: ['schema', 'color', 'raster'],
  core: ['schema', 'raster', 'rig'],
  lint: ['core', 'rig'],
  io: ['core', 'convert', 'png'],
  ops: ['core', 'lint', 'io', 'rig', 'convert'],
  server: ['ops'],
  cli: ['server', 'ops'],
};
const ALL = Object.keys(ALLOWED);

// Matches a package whether resolved to its folder, through node_modules, or left unresolved.
const target = (names) =>
  `(^packages/(${names.join('|')})/|node_modules/@pixel-forge/(${names.join('|')})/|^@pixel-forge/(${names.join('|')})(/|$))`;

// src may use only the allowed packages; test files may additionally use testkit.
const forbiddenEdges = ALL.flatMap((pkg) => {
  const forbidden = ALL.filter((o) => o !== pkg && !ALLOWED[pkg].includes(o));
  const comment = `${pkg} may only depend on: ${ALLOWED[pkg].join(', ') || 'nothing'} (spec 6.2).`;
  return [
    {
      name: `layering-${pkg}-src`,
      comment,
      severity: 'error',
      from: { path: `^packages/${pkg}/src/` },
      to: { path: target(forbidden) },
    },
    {
      name: `layering-${pkg}-test`,
      comment,
      severity: 'error',
      from: { path: `^packages/${pkg}/test/` },
      to: { path: target(forbidden.filter((o) => o !== 'testkit')) },
    },
  ];
});

module.exports = {
  forbidden: [
    ...forbiddenEdges,
    {
      name: 'no-deep-imports',
      comment: 'Import packages through their public entry point, not their src/dist internals.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '(node_modules/@pixel-forge/[^/]+/(src|dist)/|^@pixel-forge/[^/]+/(src|dist)/)' },
    },
    {
      name: 'no-relative-cross-package',
      comment: 'Packages must not reach into a sibling package by relative path.',
      severity: 'error',
      from: { path: '^packages/([^/]+)/' },
      // A sibling's built output (dist/) is how `@pixel-forge/<pkg>` resolves through the workspace symlink.
      to: { path: '^packages/([^/]+)/', pathNot: ['^packages/$1/', '^packages/[^/]+/dist/'] },
    },
    {
      name: 'no-editor-or-godot-internals',
      comment: 'Editor (M2) and the Godot addon are leaves; nothing in packages/ may import them.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '(^packages/editor/|@pixel-forge/editor|^godot/)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: '(node_modules|/dist/)' },
    exclude: { path: '(^|/)(\\.check|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
    },
  },
};
