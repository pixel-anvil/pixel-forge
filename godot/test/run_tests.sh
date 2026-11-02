#!/usr/bin/env bash
# Runs the GUT test suite headless. Extra args go to GUT, e.g. -gselect=test_asset_build
#
# Godot is taken from $GODOT, else `godot` on PATH.
#
# The project is imported first so that the .pxf fixtures go through the import plugin and the
# global classes are registered.
#
# GUT exits 0 even when a test script fails to load (a parse error, or a class that does not exist
# yet), so this script also fails when it sees one.
set -uo pipefail
cd "$(dirname "$0")"

GODOT="${GODOT:-godot}"
if ! command -v "$GODOT" >/dev/null 2>&1; then
  echo "run_tests.sh: Godot not found: set GODOT or put godot on PATH" >&2
  exit 1
fi

# --import may exit non-zero on a first run (class cache not built yet); the run below decides.
"$GODOT" --headless --path . --import >/dev/null 2>&1 || true

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
"$GODOT" --headless --path . -s addons/gut/gut_cmdln.gd -gdir=res://tests -gexit "$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}

if grep -qE "SCRIPT ERROR|Failed to load script|Could not find script" "$log"; then
  echo "run_tests.sh: a script failed to load or no test matched (see errors above)" >&2
  exit 1
fi
if [ "$status" -ne 0 ]; then
  echo "run_tests.sh: failed (exit $status)" >&2
  exit "$status"
fi
exit 0
