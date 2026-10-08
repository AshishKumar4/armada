#!/bin/sh
set -eu
cd lean
# Lean records admitted declarations as sorryAx. The build prints every exported theorem's axioms.
lake build
lake env lean Armada.lean > /tmp/armada-axioms
if grep -q 'sorryAx' /tmp/armada-axioms; then
  cat /tmp/armada-axioms
  exit 1
fi
cat /tmp/armada-axioms
