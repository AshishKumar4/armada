#!/bin/sh
# As the user, in the checkout, once per environment: the locked install.
set -eu
bun install --frozen-lockfile
