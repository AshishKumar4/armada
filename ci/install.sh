#!/bin/sh
# As the user, in the checkout, once per environment: the locked install, and
# the Lean toolchain the proofs pin.
set -eu
bun install --frozen-lockfile
"$HOME/.elan/bin/elan" toolchain install "$(cat lean/lean-toolchain)"
