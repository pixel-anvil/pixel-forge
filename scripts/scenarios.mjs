// `pnpm scenarios`: the W-scenario suite (spec 2: W2, W2b, W3-manual, W4-CLI). Each scenario is a
// `scenarios/*.steps.json` run by the real `pf` bundle (`pf check`); this file only prepares inputs in a
// temp folder, runs `pf`, and checks what a step script cannot (counts, hand-written oracles, the CLI
// round trip). Nothing is written into the repo. Run after `pnpm build`.
// Set PF_SCENARIOS_KEEP=1 to keep the temp folder (it is always kept when a scenario fails).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from '../packages/png/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PF = join(ROOT, 'packages/cli/bundle/pf.mjs');
const FIXTURES = join(ROOT, 'fixtures');
const SCENARIOS = join(ROOT, 'scenarios');
const TMP = mkdtempSync(join(tmpdir(), 'pf-scenarios-'));
const HOME = join(TMP, 'home');

/** Runs `pf` in `cwd`. Returns `{ status, stdout, stderr }`; throws unless `status` is 0 (or `allowFail`). */
function pf(args, cwd, allowFail = false) {
  const r = spawnSync(process.execPath, [PF, ...args, '--home', HOME], { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`pf ${args.join(' ')} exited ${String(r.status)}\n${r.stderr}${r.stdout}`);
  }
  return r;
}

/** A scenario folder holding copies of the script(s) and the given fixture files (name -> source path). */
function workspace(name, scripts, files = {}) {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  for (const s of scripts) copyFileSync(join(SCENARIOS, s), join(dir, s));
  for (const [to, from] of Object.entries(files)) copyFileSync(from, join(dir, to));
  return dir;
}

/** `pf check` on one script of `dir`; the run must pass every step. Returns the steps by id. */
function check(dir, script, { lintClean = true } = {}) {
  const out = script.replace('.steps.json', '');
  pf(['check', '--script', join(dir, script), '--out', join(dir, 'out', out)], dir);
  const report = JSON.parse(readFileSync(join(dir, 'out', out, 'report.json'), 'utf8'));
  assert.equal(report.ok, true, `${script}: report not ok`);
  assert.deepEqual(report.counts.failed + report.counts.skipped, 0);
  if (lintClean)
    // rig.rotationResidual is a known warning on the hero (RIG-10); every other finding fails.
    for (const l of report.lint) {
      const bad = l.findings.filter((f) => f.rule !== 'rig.rotationResidual');
      assert.equal(
        bad.length,
        0,
        `${script}: lint findings in ${l.doc}: ${bad.map((f) => f.rule)}`,
      );
    }
  const steps = Object.fromEntries(report.steps.filter((s) => s.id).map((s) => [s.id, s]));
  return Object.defineProperty(steps, 'report', { value: report });
}

const pixel = (img, x, y) => [
  ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
];
const decode = (file) => decodePng(new Uint8Array(readFileSync(file)));

// ---- W2: hero_parts.aseprite, humanoid-side template, auto-bind --------------------------------------

/** Pivots of the hero's joints (child bone -> canvas pixel), written by hand in fixtures/src/hero.ts. */
const HERO_PIVOTS = {
  torso: [24, 23],
  neck: [24, 10],
  head: [24, 8],
  upper_arm_l: [24, 12],
  upper_arm_r: [24, 12],
  lower_arm_l: [24, 19],
  lower_arm_r: [24, 19],
  hand_l: [24, 25],
  hand_r: [24, 25],
  thigh_l: [24, 25],
  thigh_r: [24, 25],
  shin_l: [24, 35],
  shin_r: [24, 35],
  foot_l: [24, 45],
  foot_r: [24, 45],
};

function w2() {
  const dir = workspace('W2', ['W2.steps.json'], {
    'hero_parts.aseprite': join(FIXTURES, 'aseprite/hero_parts.aseprite'),
  });
  const s = check(dir, 'W2.steps.json');
  // Every part is bound: 16 part layers, none left as a pixel layer, 17 variants (the sleeve is one).
  const { layers, rig } = s.summary.output;
  assert.equal(layers.length, 16);
  assert.ok(
    layers.every((l) => l.kind === 'part'),
    'a layer is not a part',
  );
  assert.equal(rig.parts.length, 16);
  assert.equal(
    rig.parts.reduce((n, p) => n + p.variants.length, 0),
    17,
  );
  // Pivots are set: the 15 joints sit where the hero's hand-written geometry puts them.
  const joints = Object.fromEntries(s.joints.output.joints.map((j) => [j.bone, j.pivot]));
  assert.deepEqual(joints, HERO_PIVOTS);
  return `hero_parts: 17 variants bound to 16 parts, 15 joints, 0 gaps`;
}

// ---- W2-joint: the hand-written joint fixtures as real rig documents --------------------------------

/** Writes `<name>-parent.png` and `<name>-child.png` from frame 0 of `fixtures/joint/<name>.txt`. */
function jointPngs(dir, name) {
  const lines = readFileSync(join(FIXTURES, 'joint', `${name}.txt`), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === 'frame 0');
  const rows = [];
  for (let i = start + 1; i < lines.length && lines[i].trim() !== ''; i++)
    rows.push(lines[i].trim());
  const [w, h] = [rows[0].length, rows.length];
  for (const [tag, own, rgba] of [
    ['parent', 'PB', [255, 0, 0, 255]],
    ['child', 'CB', [0, 0, 255, 255]],
  ]) {
    const data = new Uint8Array(w * h * 4);
    rows.forEach((row, y) =>
      [...row].forEach((c, x) => own.includes(c) && data.set(rgba, (y * w + x) * 4)),
    );
    writeFileSync(
      join(dir, `${name}-${tag}.png`),
      encodePng({ width: w, height: h, data, kind: 'rgba' }),
    );
  }
}

const JOINT_FIXTURES = [
  'gappy_elbow',
  'gappy_knee',
  'clean_capped_elbow',
  'clean_inner_corner',
  'clean_pockets',
  'clean_staircase',
];

function w2Joint() {
  const dir = workspace('W2-joint', ['W2-joint.steps.json']);
  for (const name of JOINT_FIXTURES) jointPngs(dir, name);
  const s = check(dir, 'W2-joint.steps.json', { lintClean: false });
  let seeded = 0;
  for (const name of JOINT_FIXTURES) {
    const expected = JSON.parse(
      readFileSync(join(FIXTURES, 'joint', `${name}.expected.json`), 'utf8'),
    );
    const { summary, joints } = s[`${name}_check`].output;
    if (name.startsWith('clean_')) {
      // 0 gaps, exactly, in the sweep of every clean fixture.
      assert.equal(expected.gapCount, 0);
      assert.deepEqual(summary, { joints: 1, jointsWithGaps: 0, gapCount: 0, unionCount: 0 }, name);
    } else {
      // At the fixture's own radius and angles the report must equal the hand-written oracle. A sweep
      // is symmetric but a fixture frame is one-sided: gappy_knee has no -10 frame, so only seeded
      // angles are compared.
      for (const { angle, gaps } of expected.angles) {
        const found = joints[0].angles.find((a) => a.angle === angle);
        assert.deepEqual(found?.gaps, gaps, `${name} at ${String(angle)}`);
        seeded += gaps.length;
      }
    }
  }
  assert.equal(seeded, 3, 'gaps across the gappy fixtures');
  return `6 fixtures: 4 clean (0 gaps), 2 gappy (exactly ${String(seeded)} seeded gaps)`;
}

// ---- W2b: split a flat frame, paint the hidden overlap -----------------------------------------------

function w2b() {
  const dir = workspace('W2b', ['W2b.steps.json'], {
    'hero.pxf': join(FIXTURES, 'generated/hero.pxf'),
  });
  // The flat frame: the synthetic hero's rest frame, exported at scale 1 (no pack art).
  pf(['export', 'hero.pxf', 'flat.png', '--animations', 'default'], dir);
  const s = check(dir, 'W2b.steps.json');
  // The recomposite is compared in the script (PNG bytes of the render, equal after the split and after
  // the paint). Here: the splits cut real pixels, and the paint was needed and fixed it.
  assert.equal(s.head.output.pixels + s.neck.output.pixels + s.torso.output.pixels > 0, true);
  assert.ok(s.before.output.summary.gapCount > 0, 'the split parts have no gap: nothing to paint');
  assert.ok(s.paint.output.painted.length > 0);
  assert.equal(s.after.output.summary.gapCount, 0);
  const orig = decode(join(dir, 'out/W2b/03-orig.png'));
  const done = decode(join(dir, 'out/W2b/15-painted.png'));
  assert.deepEqual([...done.data], [...orig.data], 'recomposite differs from the source frame');
  return `7 parts cut, ${String(s.before.output.summary.gapCount)} gap px over the sweep before, 0 after, frame identical`;
}

// ---- W3-manual: scripted run cycle ------------------------------------------------------------------

function w3() {
  const dir = workspace('W3-manual', ['W3-manual.steps.json'], {
    'hero.pxf': join(FIXTURES, 'generated/hero.pxf'),
  });
  const s = check(dir, 'W3-manual.steps.json');
  const sheet = join(dir, 'out/W3-manual', s.sheet.image.file);
  assert.ok(existsSync(sheet), 'no contact sheet was rendered');
  assert.equal(decode(sheet).width, s.sheet.image.width);
  return `6 frames x 83 ms, lint clean, 7 ops = 7 undo steps, sheet ${String(s.sheet.image.width)}x${String(s.sheet.image.height)}`;
}

// ---- W3-presets: the five motion presets on the joint-piece hero ------------------------------------

function w3Presets() {
  const dir = workspace('W3-presets', ['W3-presets.steps.json'], {
    'hero_joints.pxf': join(FIXTURES, 'generated/hero_joints.pxf'),
  });
  const s = check(dir, 'W3-presets.steps.json', { lintClean: false });
  const frames = {};
  for (const id of ['walk', 'run', 'jump', 'idle', 'swing']) {
    assert.equal(s[id].output.created, true);
    assert.deepEqual(s[id].output.warnings, []);
    frames[id] = s[id].output.frames;
  }
  // Lint is clean except the known warnings (docs/ai/KNOWN_ISSUES.md RIG-10, RIG-11, RIG-12).
  const known = new Set(['rig.rotationResidual', 'pixels.clipped']);
  for (const l of s.report.lint)
    for (const f of l.findings) assert.ok(known.has(f.rule), `unexpected lint finding ${f.rule}`);
  assert.ok(existsSync(join(dir, 'out/W3-presets', s.sheet.image.file)), 'no contact sheet');
  return `walk ${String(frames.walk)}, run ${String(frames.run)}, jump ${String(frames.jump)}, idle ${String(frames.idle)}, swing ${String(frames.swing)} frames, ${String(s.report.lint.reduce((n, l) => n + l.count, 0))} known lint warnings`;
}

// ---- W4-CLI: touch up with pf export + pf override import, then lean +5 deg --------------------------

const MAGENTA = [255, 0, 255, 255];
/** Edited pixels of frame 2 [x, y, expected colour before]: one hair pixel (head), two torso-edge pixels (torso). */
const EDITS = [
  [26, 0, [70, 45, 30, 255]],
  [22, 14, [60, 110, 190, 255]],
  [22, 15, [60, 110, 190, 255]],
];

/** Frame `k` of the strip `pf export` wrote (48 px frames, from the JSON beside it). */
function frameOf(dir, k) {
  const sheet = decode(join(dir, 'sheet.png'));
  const { frame } = JSON.parse(readFileSync(join(dir, 'sheet.json'), 'utf8')).frames[
    `run/side ${String(k)}`
  ];
  const data = new Uint8Array(frame.w * frame.h * 4);
  for (let y = 0; y < frame.h; y++) {
    const from = ((frame.y + y) * sheet.width + frame.x) * 4;
    data.set(sheet.data.subarray(from, from + frame.w * 4), y * frame.w * 4);
  }
  return { width: frame.w, height: frame.h, data };
}

const countColour = (img, rgba) => {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) if (rgba.every((c, j) => img.data[i + j] === c)) n++;
  return n;
};

function w4() {
  const scripts = ['W4-CLI.prepare.steps.json', 'W4-CLI.lean.steps.json'];
  const dir = workspace('W4-CLI', scripts, { 'hero.pxf': join(FIXTURES, 'generated/hero.pxf') });
  check(dir, scripts[0]);
  const exportFrame2 = () => {
    pf(['export', 'hero.pxf', 'sheet.png', '--animations', 'run/side'], dir);
    return frameOf(dir, 2);
  };
  // 1. Export (scale 1, from `pf export`, not `pf render`: CLI-05) and fix 3 px on frame 2.
  const base = exportFrame2();
  const edited = { ...base, data: new Uint8Array(base.data) };
  for (const [x, y, was] of EDITS) {
    assert.deepEqual(pixel(base, x, y), was, `the pose changed: pixel ${String(x)},${String(y)}`);
    edited.data.set(MAGENTA, (y * base.width + x) * 4);
  }
  writeFileSync(join(dir, 'frame2.png'), encodePng({ ...edited, kind: 'rgba' }));
  const imported = JSON.parse(
    pf(['override', 'import', 'hero.pxf', 'run/side', '2', 'frame2.png', '--save'], dir).stdout,
  );
  assert.equal(imported.output.changed, 3);
  assert.equal(imported.output.newlyStale.length, 0);
  assert.equal(imported.output.overrides.length, 2, 'one head stroke and one torso stroke');
  // The round trip: the exported frame 2 now equals the edited PNG, pixel for pixel.
  assert.deepEqual(
    [...exportFrame2().data],
    [...edited.data],
    'export after import differs from the edit',
  );
  const list = () => JSON.parse(pf(['override', 'list', 'hero.pxf'], dir).stdout).output;
  assert.deepEqual(list().counts, { total: 2, valid: 2, stale: 0, errors: 0 });
  // 2. Lean +5 deg on all 6 frames: the head moves without rotating, the torso rotates.
  // The lint of the leaned document reports the stale override and nothing else.
  const lean = check(dir, scripts[1], { lintClean: false });
  assert.deepEqual(
    lean.report.lint[0].findings.map((f) => f.rule),
    ['rig.staleOverride'],
  );
  const after = list();
  assert.equal(after.counts.total, 2, 'an override was lost');
  assert.equal(after.counts.errors, 0);
  assert.equal(after.counts.valid, 1, 'the head override should still be valid');
  assert.equal(after.counts.stale, 1, 'the torso override should be stale');
  assert.equal(after.stale[0].target, 'torso');
  assert.equal(after.stale[0].frameIndex, 2);
  assert.ok(imported.output.overrides.includes(after.valid[0]));
  // Nothing is silently lost: stale overrides still draw, so frame 2 keeps its 3 edited pixels.
  assert.equal(countColour(exportFrame2(), MAGENTA), 3);
  return `3 px edited, 2 overrides; after +5 deg lean: head override valid, torso override stale, none lost`;
}

// ---- run ----------------------------------------------------------------------------------------------

if (!existsSync(PF)) {
  console.error(`${PF} is missing: run "pnpm build" first`);
  process.exit(2);
}
const SCENARIOS_RUN = [
  ['W2', w2],
  ['W2-joint', w2Joint],
  ['W2b', w2b],
  ['W3-manual', w3],
  ['W3-presets', w3Presets],
  ['W4-CLI', w4],
];
let failed = 0;
const started = Date.now();
for (const [name, run] of SCENARIOS_RUN) {
  const t = Date.now();
  try {
    const note = run();
    console.log(`PASS ${name} (${String(Date.now() - t)} ms): ${note}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} (${String(Date.now() - t)} ms)`);
    console.log(String(e instanceof Error ? e.stack : e).replace(/^/gm, '    '));
  }
}
console.log(
  `${String(SCENARIOS_RUN.length - failed)}/${String(SCENARIOS_RUN.length)} scenarios passed in ${String(Date.now() - started)} ms`,
);
if (failed === 0 && process.env.PF_SCENARIOS_KEEP !== '1')
  rmSync(TMP, { recursive: true, force: true });
else console.log(`temp folder kept: ${TMP}`);
process.exit(failed === 0 ? 0 : 1);
