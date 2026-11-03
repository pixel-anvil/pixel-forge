/** Hand-written ASCII oracles: images from rows of characters and back. Independent of the code under test. */
import type { RgbaImage } from '@pixel-forge/raster';

/** Maps a character to an RGBA colour. */
export type Legend = Readonly<Record<string, readonly [number, number, number, number]>>;

/** Image from rows of characters (`legend` maps a character to RGBA). */
export function fromAscii(rows: readonly string[], legend: Legend): RgbaImage {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const data = new Uint8Array(w * h * 4);
  rows.forEach((row, y) => {
    if (row.length !== w) throw new Error(`row ${String(y)} has length ${String(row.length)}`);
    Array.from(row).forEach((ch, x) => {
      const c = legend[ch];
      if (c === undefined) throw new Error(`no legend entry for ${JSON.stringify(ch)}`);
      data.set(c, (y * w + x) * 4);
    });
  });
  return { width: w, height: h, data };
}

/** Rows of characters of an image; a pixel that is not in `legend` shows as `?`. */
export function toAscii(img: RgbaImage, legend: Legend): string[] {
  const rows: string[] = [];
  for (let y = 0; y < img.height; y++) {
    let row = '';
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      const px = [...img.data.subarray(o, o + 4)];
      const hit = Object.entries(legend).find(([, c]) => c.every((v, i) => v === px[i]));
      row += hit === undefined ? '?' : hit[0];
    }
    rows.push(row);
  }
  return rows;
}
