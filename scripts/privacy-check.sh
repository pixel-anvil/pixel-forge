#!/bin/sh
# Rejects absolute home paths and any term from the local (untracked) denylist.
# Usage: privacy-check.sh --all | privacy-check.sh FILE...
DENY="${PF_DENYLIST:-$HOME/pf-work/denylist.txt}"
self="scripts/privacy-check.sh"
if [ "$1" = "--all" ]; then
  files=$(git ls-files -co --exclude-standard)
else
  files="$*"
fi
[ -f "$DENY" ] || echo "privacy-check: denylist not found ($DENY); checking home paths only." >&2
fail=0
for f in $files; do
  [ "$f" = "$self" ] && continue
  [ -f "$f" ] || continue
  grep -Iq . "$f" 2>/dev/null || continue
  if grep -nE '/Users/' "$f" | sed "s|^|$f:|" | grep .; then fail=1; fi
  if [ -f "$DENY" ]; then
    if grep -niF -f "$DENY" "$f" | sed "s|^|$f:|" | grep .; then fail=1; fi
  fi
done
[ "$fail" = 0 ] || { echo "privacy-check: FAILED" >&2; exit 1; }
