#!/bin/sh
# armada's own CI system, as root, once per environment (.armada.json): the
# bun its scripts run under, pinned, on the runner layer's path.
set -eu
BUN_VERSION=1.4.0
curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"
unzip -q /tmp/bun.zip -d /tmp
install -m 755 /tmp/bun-linux-x64/bun /usr/local/bin/bun
rm -rf /tmp/bun.zip /tmp/bun-linux-x64
