#!/bin/sh
# Installs armada: Bun if it is missing or too old, a checkout of armada in ~/.armada, and the armada command beside Bun's.
# Run it again to update.
#
#   curl -fsSL https://raw.githubusercontent.com/AshishKumar4/armada/main/install.sh | sh
set -eu

repo=https://github.com/AshishKumar4/armada.git
dir="$HOME/.armada"
bin="${BUN_INSTALL:-$HOME/.bun}/bin"
path="$PATH"

if ! command -v git >/dev/null 2>&1; then
  echo "armada needs git: install it, then run this again" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  PATH="$bin:$PATH"
fi

if [ -d "$dir/.git" ]; then
  git -C "$dir" pull -q --ff-only
else
  git clone -q --depth=1 "$repo" "$dir"
fi

cd "$dir"
# The lockfile's format needs the Bun that package.json names; an older Bun cannot read it.
if ! bun -e 'process.exit(Bun.semver.satisfies(Bun.version, require("./package.json").engines.bun) ? 0 : 1)'; then
  echo "armada needs Bun $(bun -e 'console.log(require("./package.json").engines.bun)'), and this is Bun $(bun --version): upgrading it"
  bun upgrade
fi
bun install --frozen-lockfile
mkdir -p "$bin"
ln -sf "$dir/src/cli.ts" "$bin/armada"

echo
echo "armada is installed: $bin/armada"
case ":$path:" in
  *":$bin:"*) ;;
  *) echo "$bin is not on your PATH yet: open a new shell, or add it" ;;
esac
echo "next: armada deploy"
