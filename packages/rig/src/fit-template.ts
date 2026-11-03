/**
 * Fit a humanoid skeleton template to art from a few landmark points (card T5.16).
 * Pure integer maths: every bone length is a whole-pixel share of a measured distance, split by the
 * ratios of {@link DEFAULT_PROPORTIONS} with a deterministic rounding (half up) that puts the
 * remainder on the last piece, so the pieces always add up to the measured distance.
 * No external source.
 * @packageDocumentation
 */
import { RigError } from './errors.js';
import {
  DEFAULT_PROPORTIONS,
  humanoidBack,
  humanoidFront,
  humanoidSide,
  type HumanoidProportions,
  type SkeletonTemplate,
} from './templates.js';

/** A canvas pixel (origin top-left, y down). */
export interface Landmark {
  readonly x: number;
  readonly y: number;
}

/**
 * Landmarks of a standing character, in canvas pixels. Integers; `headTop.y < hips.y < feet.y`.
 * `feet` is the point between the feet on the sole row: it becomes the root pivot (centre line and
 * feet row). `handL` / `handR` are fingertips with the arms hanging (the rest pose); give none, one
 * (used for both arms) or both. In a front or back view `_l` is at +x on screen.
 */
export interface TemplateLandmarks {
  readonly headTop: Landmark;
  readonly hips: Landmark;
  readonly feet: Landmark;
  readonly handL?: Landmark;
  readonly handR?: Landmark;
}

/** Which humanoid template to fit. */
export type TemplateKind = 'side' | 'front' | 'back';

/** Result of {@link fitHumanoid}. */
export interface FittedTemplate {
  readonly template: SkeletonTemplate;
  /** Character height in px (feet row to top of head). */
  readonly height: number;
  /** Root pivot: the `feet` landmark. */
  readonly origin: Landmark;
  /** The proportions that were passed to the template generator. */
  readonly proportions: HumanoidProportions;
}

const GENERATORS = { side: humanoidSide, front: humanoidFront, back: humanoidBack } as const;

/** Share weight in 1/1000 of a default proportion. */
const w = (f: number): number => Math.round(f * 1000);

/** `round(a * num / den)` for non-negative integers, half up, in integer maths. */
const mulDiv = (a: number, num: number, den: number): number =>
  Math.floor((2 * a * num + den) / (2 * den));

/** Splits `total` by integer `weights`; all but the last piece are rounded, the last takes the rest. */
function split3(total: number, a: number, b: number, c: number): [number, number, number] {
  const sum = a + b + c;
  const x = mulDiv(total, a, sum);
  const y = mulDiv(total, b, sum);
  return [x, y, total - x - y];
}

function checkPoint(name: string, p: Landmark): void {
  if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) {
    throw new RigError('BAD_VALUE', `landmark ${name} must be integer pixels`);
  }
}

/**
 * Fits the humanoid template `kind` to the landmarks. Height = feet row - head top. The hip height
 * splits the leg (ankle, shin, thigh) and the body above it (pelvis, torso, neck, head); the hands
 * set the arm length (upper arm, lower arm, hand). Everything else keeps the default ratios.
 * The result is an ordinary {@link SkeletonTemplate} (root at `feet`), ready for `applySkeletonTemplate`.
 * @throws RigError `BAD_VALUE` for non-integer or badly ordered landmarks, a height outside 8..1024,
 * or a hand at or above the shoulder (the rest pose has the arms down).
 */
export function fitHumanoid(kind: TemplateKind, landmarks: TemplateLandmarks): FittedTemplate {
  const { headTop, hips, feet } = landmarks;
  checkPoint('headTop', headTop);
  checkPoint('hips', hips);
  checkPoint('feet', feet);
  const height = feet.y - headTop.y;
  const hipH = feet.y - hips.y;
  if (height < 8 || height > 1024) {
    throw new RigError(
      'BAD_VALUE',
      `height (feet.y - headTop.y) must be 8..1024, got ${String(height)}`,
    );
  }
  if (hipH < 1 || hipH >= height) {
    throw new RigError('BAD_VALUE', 'landmarks must satisfy headTop.y < hips.y < feet.y');
  }
  const d = DEFAULT_PROPORTIONS;
  const [ankle, shin, thigh] = split3(hipH, w(d.ankle), w(d.shin), w(d.thigh));
  const upper = height - hipH;
  const wu = w(d.pelvis) + w(d.torso) + w(d.neck) + w(d.head);
  const pelvis = mulDiv(upper, w(d.pelvis), wu);
  const torso = mulDiv(upper, w(d.torso), wu);
  const neck = mulDiv(upper, w(d.neck), wu);
  const head = upper - pelvis - torso - neck;
  const shoulderDrop = mulDiv(height, w(d.shoulderDrop), 1000);
  const shoulderH = hipH + pelvis + torso - shoulderDrop;
  let arm = split3(
    mulDiv(height, w(d.upperArm) + w(d.lowerArm) + w(d.hand), 1000),
    w(d.upperArm),
    w(d.lowerArm),
    w(d.hand),
  );
  const tips = [landmarks.handL, landmarks.handR].filter((p): p is Landmark => p !== undefined);
  for (const t of tips) {
    checkPoint('hand', t);
    if (t.y > feet.y) throw new RigError('BAD_VALUE', 'a hand lies below the feet row');
  }
  if (tips.length > 0) {
    const sum = tips.reduce((s, t) => s + (feet.y - t.y), 0);
    const reach = shoulderH - mulDiv(sum, 1, tips.length);
    if (reach < 3) {
      throw new RigError('BAD_VALUE', 'hands must hang below the shoulders (reach under 3 px)');
    }
    arm = split3(reach, w(d.upperArm), w(d.lowerArm), w(d.hand));
  }
  const f = (px: number): number => px / height;
  const proportions: HumanoidProportions = {
    ...d,
    ankle: f(ankle),
    shin: f(shin),
    thigh: f(thigh),
    pelvis: f(pelvis),
    torso: f(torso),
    neck: f(neck),
    head: f(head),
    shoulderDrop: f(shoulderDrop),
    upperArm: f(arm[0]),
    lowerArm: f(arm[1]),
    hand: f(arm[2]),
  };
  const origin = { x: feet.x, y: feet.y };
  return {
    template: GENERATORS[kind]({ height, origin, proportions }),
    height,
    origin,
    proportions,
  };
}
