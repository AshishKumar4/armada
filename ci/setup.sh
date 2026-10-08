#!/bin/sh
# armada's own CI system, as root, once per environment (.armada.json): the
# bun its scripts run under, pinned, on the runner layer's path.
set -eu
BUN_VERSION=1.4.0
curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"
unzip -q /tmp/bun.zip -d /tmp
install -m 755 /tmp/bun-linux-x64/bun /usr/local/bin/bun
rm -rf /tmp/bun.zip /tmp/bun-linux-x64

# elan + the pinned Lean toolchain for the proofs row (ci/proofs.sh), installed
# under the task user's ~/.elan so the shims resolve without PATH or env work.
ELAN_VERSION=4.2.4
ELAN_SHA256=42b94d4244e8353142c456ec0e4ca6528fd898a6c604d4059f494e706e431f63
curl -fsSL -o /tmp/elan.tar.gz "https://github.com/leanprover/elan/releases/download/v${ELAN_VERSION}/elan-x86_64-unknown-linux-gnu.tar.gz"
echo "${ELAN_SHA256}  /tmp/elan.tar.gz" | sha256sum -c
tar xzf /tmp/elan.tar.gz -C /tmp
ELAN_HOME=/home/ci/.elan /tmp/elan-init -y --no-modify-path --default-toolchain leanprover/lean4:v4.34.1
chown -R ci: /home/ci/.elan
rm -f /tmp/elan.tar.gz /tmp/elan-init
