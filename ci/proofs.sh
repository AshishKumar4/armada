#!/bin/sh
# The scheduler's Lean proofs (ci row `proofs`): `lake build --wfail` — so a
# theorem left on `sorry` fails the build, not just the axiom list — then `#print
# axioms` of every named theorem and refuse anything outside the three axioms
# Lean itself uses — a hidden `sorry` would surface here as `sorryAx`.
set -eu
cd "$(dirname "$0")/../lean"

LAKE=${LAKE:-$(command -v lake || echo "$HOME/.elan/bin/lake")}
if [ ! -x "$LAKE" ]; then
  echo "lake not installed; ci/setup.sh's elan step did not run" >&2
  exit 1
fi

"$LAKE" build --wfail

LEAN=${LEAN:-$(command -v lean || echo "$HOME/.elan/bin/lean")}
out=$("$LAKE" env "$LEAN" Axioms.lean)
printf '%s\n' "$out"

bad=$(printf '%s\n' "$out" | grep -oE '\[[^]]*\]' | tr -d '[]' | tr ',' '\n' | sed 's/^ *//; s/ *$//' | sort -u | grep -v -e '^$' -e '^propext$' -e '^Classical\.choice$' -e '^Quot\.sound$' || true)
if [ -n "$bad" ]; then
  echo "forbidden axioms: $bad" >&2
  exit 1
fi
echo "axioms: only propext, Classical.choice, Quot.sound allowed; none other seen"
