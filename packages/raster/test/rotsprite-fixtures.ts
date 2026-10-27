/**
 * Synthetic rotation subjects drawn by hand for T1.6 (no third-party art). They mirror the spike's
 * subject set in size and structure: a 2-px upper arm, a forearm with a 1-px hook, a 4-px shin and
 * foot with six colours, and a 32×32 head-and-torso "large part". Data only (no imports), so the bench
 * script can load this file with Node's type stripping too.
 */

/** `[r, g, b, a]` bytes. */
export type Colour = readonly [number, number, number, number];

/** Legend for the ASCII subjects; `.` is transparent. */
export const LEGEND: Readonly<Record<string, Colour>> = {
  K: [40, 32, 48, 255], // outline
  S: [232, 180, 140, 255], // skin
  s: [190, 130, 100, 255], // skin shadow
  H: [120, 70, 30, 255], // hair
  h: [170, 110, 50, 255], // hair highlight
  W: [240, 240, 240, 255], // eye white
  E: [20, 20, 30, 255], // pupil
  R: [190, 40, 40, 255], // mouth
  C: [60, 90, 170, 255], // cloth
  c: [40, 60, 120, 255], // cloth shadow
  L: [150, 120, 40, 255], // belt / strap
  Y: [230, 200, 60, 255], // buckle
  B: [100, 60, 40, 255], // boot
  b: [70, 40, 30, 255], // boot shadow
};

/** One subject: ASCII art (one char per pixel) and the pivot pixel (the joint). */
export interface Subject {
  readonly name: string;
  readonly ascii: string;
  readonly pivot: { readonly x: number; readonly y: number };
}

/** 2-px-wide diagonal upper arm, one colour, 12 px; pivot at the shoulder end. */
export const UPPER_ARM: Subject = {
  name: 'upper-arm',
  pivot: { x: 1, y: 1 },
  ascii: `
SS....
SSSS..
..SSSS
....SS
`,
};

/** Forearm and hand with a 1-px hooked thumb, one colour, 9 px; pivot at the elbow. */
export const FOREARM: Subject = {
  name: 'forearm',
  pivot: { x: 0, y: 0 },
  ascii: `
SS...
.SS..
..SSS
...S.
..S..
`,
};

/** Outlined 4-px shin and boot, six colours, 37 px; pivot at the knee. */
export const SHIN: Subject = {
  name: 'shin',
  pivot: { x: 1, y: 0 },
  ascii: `
KCCK..
KCcK..
KCcK..
KLLK..
KBbK..
KBBbK.
KBBBbK
KKKKKK
`,
};

/** 32×32 head and torso, twelve colours; pivot at the neck joint. */
export const TORSO: Subject = {
  name: 'torso',
  pivot: { x: 15, y: 17 },
  ascii: `
................................
...........KKKKKKKKK............
.........KKHHHHhhHHHKK..........
........KHHHHHhhhHHHHHK.........
.......KHHHHHHHHHHHHHHHK........
.......KHHSSSSSSSSSSHHHK........
......KHHSSSSSSSSSSSSSHHK.......
......KHSSSSSSSSSSSSSSSHK.......
......KHSSWESSSSSSWESSSHK.......
......KHSSWESSSSSSWESSSHK.......
......KSSSSSSSSSSSSSSSSSK.......
......KSSSSSSSssSSSSSSSSK.......
.......KSSSSSSSSSSSSSSSK........
.......KSSSSSRRRRSSSSSSK........
........KSSSSSSSSSSSSSK.........
.........KKsSSSSSSSsKK..........
...........KsSSSSSsK............
.......KKKKKCCCCCCCKKKKK........
.....KKCCCCCCCCCCCCCCCCCKK......
....KCCCCCCCCCCCCCCCCCCCCCK.....
...KCCCcCCCCCCCCCCCCCCcCCCCK....
...KCCcKCCCCCCCCCCCCCCKcCCCK....
...KCCcKCCCCCCCCCCCCCCKcCCCK....
...KSSsKCCCCCCCCCCCCCCKsSSSK....
...KSSsKLLLLLLLLLLLLLLKsSSSK....
...KSSKKLLLLLLLYYLLLLLKKSSSK....
....KK.KCCCCCCCCCCCCCCK.KKK.....
.......KCCCCCCcCCCCCCCK.........
.......KCCCCCCcCCCCCCCK.........
.......KCCCCCCcCCCCCCCK.........
.......KKKKKKKKKKKKKKKK.........
................................
`,
};

/** The four-subject synthetic set used by the sentinel, area and reference-agreement tests. */
export const SUBJECTS: readonly Subject[] = [UPPER_ARM, FOREARM, SHIN, TORSO];
