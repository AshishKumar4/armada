#!/bin/sh
# armada's own CI system, as root, once per environment (.armada.json): the
# bun its scripts run under, pinned, on the runner layer's path.
set -eu
BUN_VERSION=1.4.0
curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"
unzip -q /tmp/bun.zip -d /tmp
install -m 755 /tmp/bun-linux-x64/bun /usr/local/bin/bun
rm -rf /tmp/bun.zip /tmp/bun-linux-x64
curl -fsSL -o /tmp/elan.tar.gz https://github.com/leanprover/elan/releases/download/v4.1.2/elan-x86_64-unknown-linux-gnu.tar.gz
mkdir /tmp/armada-elan
tar xzf /tmp/elan.tar.gz -C /tmp/armada-elan
/tmp/armada-elan/elan-init -y --default-toolchain none
ELAN_HOME=/opt/elan /tmp/armada-elan/elan-init -y --default-toolchain leanprover/lean4:v4.19.0
chmod -R a+rX /opt/elan
ln -s /opt/elan/bin/lake /usr/local/bin/lake
ln -s /opt/elan/bin/lean /usr/local/bin/lean
