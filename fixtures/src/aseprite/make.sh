#!/usr/bin/env bash
# Regenerates fixtures/aseprite/*.aseprite plus oracles (<name>.expected.json,
# <name>/ per-layer per-frame PNGs). Requires an Aseprite binary (tool use only).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$HERE/../../aseprite" && pwd)"
ASE="${ASEPRITE:-$HOME/code/aseprite/build/bin/aseprite}"
NAMES=(layers_parts tags_overlap linked_cels indexed_palette hero_parts)

for n in "${NAMES[@]}"; do
  rm -rf "$OUT/$n" "$OUT/$n.aseprite" "$OUT/$n.expected.json"
  "$ASE" -b --script-param "out=$OUT" --script-param "dir=$HERE" --script "$HERE/$n.lua"
  mkdir -p "$OUT/$n"
  # Pixel oracle: one PNG per (layer, frame); hidden layers included.
  "$ASE" -b --all-layers "$OUT/$n.aseprite" --save-as "$OUT/$n/{layer}-{frame}.png"
  # Portable file names: ':', '#' and '@' are invalid on Windows. Replace each with '~' in the
  # layer part of the name (the parser tests apply the same rule; see README "Oracle PNG names").
  for f in "$OUT/$n"/*.png; do
    b=$(basename "$f"); s=$(printf '%s' "$b" | tr ':#@' '~~~')
    [ "$b" != "$s" ] && mv "$f" "$OUT/$n/$s"
  done
  # Structure oracle: layers, tags, frame durations (sheet itself discarded).
  "$ASE" -b --all-layers --list-layers --list-tags "$OUT/$n.aseprite" \
    --data "$OUT/$n.expected.json" --format json-array \
    --sheet "$(mktemp -d)/sheet.png" > /dev/null
  # Strip absolute paths (privacy-check).
  node -e '
    const fs=require("fs"),f=process.argv[1];
    const j=JSON.parse(fs.readFileSync(f,"utf8"));
    if(j.meta){delete j.meta.image; delete j.meta.version;}
    fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");' "$OUT/$n.expected.json"
done
ls -l "$OUT"/*.aseprite
