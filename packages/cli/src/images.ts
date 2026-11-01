import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The `image` field of an image-returning op's output (`render.frame`, `render.contactSheet`). */
export interface OutputImage {
  readonly mimeType: string;
  /** The PNG, base64. */
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

/** The top-level `image` of an op output, or `undefined` when it has none. */
export function imageOf(output: unknown): OutputImage | undefined {
  if (typeof output !== 'object' || output === null || !('image' in output)) return undefined;
  const image = output.image;
  if (typeof image !== 'object' || image === null) return undefined;
  const { mimeType, data, width, height } = image as Record<string, unknown>;
  if (
    typeof mimeType === 'string' &&
    typeof data === 'string' &&
    typeof width === 'number' &&
    typeof height === 'number'
  ) {
    return { mimeType, data, width, height };
  }
  return undefined;
}

/** Decodes `image` and writes the PNG to `file` (creating its folder). */
export function writeImage(file: string, image: OutputImage): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(image.data, 'base64'));
}

/** The output with `image.data` replaced by the file the PNG was written to. */
export function withoutImageData(output: unknown, file: string): unknown {
  const image = imageOf(output);
  if (image === undefined) return output;
  return {
    ...(output as Record<string, unknown>),
    image: { mimeType: image.mimeType, width: image.width, height: image.height, file },
  };
}
