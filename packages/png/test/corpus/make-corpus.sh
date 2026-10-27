#!/bin/sh
# Regenerates packages/png/test/corpus/*.png. The PNGs are committed; run this only to rebuild them.
#   - hero-*.png        copies of the CC0 sheets in fixtures/cc0/hero_swordsman/
#   - pngjs-*.png       written by pngjs (independent encoder)
#   - handmade-*.png    palette / low-bit-depth / tRNS / all-filter / multi-IDAT, built by gen-corpus.mjs
#   - sips-*.png        re-encoded by macOS `sips` (skipped when sips is not installed)
#   - aseprite-*.png    re-encoded by the Aseprite CLI (skipped when it is not found; set ASEPRITE
#                       to its path, default $HOME/code/aseprite/build/bin/aseprite)
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
aseprite=${ASEPRITE:-$HOME/code/aseprite/build/bin/aseprite}

cd "$here"
rm -f -- ./*.png

for f in "$root"/fixtures/cc0/hero_swordsman/*.png; do
  cp "$f" "hero-$(basename "$f" | tr '_' '-')"
done

node gen-corpus.mjs "$here"

if command -v sips >/dev/null 2>&1; then
  sips -s format png pngjs-rgba.png --out sips-rgba.png >/dev/null
  sips -s format png hero-idle.png --out sips-hero-idle.png >/dev/null
  sips -s format png pngjs-gray.png --out sips-gray.png >/dev/null
else
  echo "note: sips not found, skipping sips-*.png" >&2
fi

if [ -x "$aseprite" ]; then
  "$aseprite" -b pngjs-rgba.png --save-as aseprite-rgba.png
  "$aseprite" -b pngjs-rgba.png --color-mode indexed --save-as aseprite-indexed.png
  "$aseprite" -b pngjs-rgba.png --color-mode grayscale --save-as aseprite-gray.png
  "$aseprite" -b hero-idle.png --save-as aseprite-hero-idle.png
else
  echo "note: Aseprite not found at $aseprite, skipping aseprite-*.png" >&2
fi

ls -1 -- ./*.png
