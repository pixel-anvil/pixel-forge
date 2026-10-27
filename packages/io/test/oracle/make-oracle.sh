#!/bin/sh
# Regenerates the Aseprite oracles for sheet-export.test.ts. Needs the Aseprite CLI.
# Usage: ASEPRITE=/path/to/aseprite packages/io/test/oracle/make-oracle.sh
set -e
ASE="${ASEPRITE:-aseprite}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
"$ASE" -b --script-param out="$TMP/oracle.aseprite" --script "$DIR/make-oracle.lua"
# Scale 1: one row per tag (3 columns), keys "<tag> <frame in tag>".
"$ASE" -b "$TMP/oracle.aseprite" --sheet "$DIR/oracle-sheet.png" --data "$DIR/oracle-sheet.json" \
  --format json-hash --sheet-type rows --sheet-columns 3 --filename-format '{tag} {tagframe}' \
  --list-tags --list-layers --list-slices
# Scale 2: the same, integer-scaled by Aseprite itself.
"$ASE" -b "$TMP/oracle.aseprite" --scale 2 --sheet "$DIR/oracle-sheet-x2.png" --data "$DIR/oracle-sheet-x2.json" \
  --format json-hash --sheet-type rows --sheet-columns 3 --filename-format '{tag} {tagframe}' \
  --list-tags --list-layers --list-slices
rm -rf "$TMP"
