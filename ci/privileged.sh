#!/bin/sh
# The tests that need root beside armada's runner layer on cgroup v2 (task cgroups, a phase run twice, a checkout under /armada), which a
# CI task, always the ci user, cannot run. In a disposable privileged container; red if any of them skips.
set -eu
cd "$(dirname "$0")/.."
# /armada and the checkout on tmpfs, which an overlay takes as its upper and lower dirs, as a container's own disk is;
# Docker's own root is overlayfs, which it does not.
docker run --rm --privileged --cgroupns=private --tmpfs /armada --tmpfs /work -e TMPDIR=/work -v "$PWD":/src:ro oven/bun:1.4.0 sh -c '
set -eu
apt-get update -qq >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends procps util-linux tini git >/dev/null
useradd -m -s /bin/bash ci
# As a container gets it: this shell out of the root group, so the root can hand its controllers down.
mkdir /sys/fs/cgroup/init && echo $$ > /sys/fs/cgroup/init/cgroup.procs
echo "+memory +pids +cpu +cpuset" > /sys/fs/cgroup/cgroup.subtree_control
cp -r /src /w && cd /w && bun install --frozen-lockfile >/dev/null
bun test worker/tests/cgroup.test.ts worker/tests/preparation.test.ts worker/tests/checkout.test.ts > /tmp/out 2>&1 || { cat /tmp/out; exit 1; }
cat /tmp/out
! grep -q " skip$" /tmp/out
'
