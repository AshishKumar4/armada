"""An environment's recipe: a base image, a root `setup` script, a user `install` script and a size —
built a step at a time like task.ts's RecipeBuilder, so the same recipe hashes to the same environment key."""

import copy

from .sh import quote
from .wire import DEFAULT_BASE, SIZES

Recipe = dict[str, object]


def _spec(base: str | None, setup: str, install: str, size: str) -> Recipe:
    if size not in SIZES:
        raise ValueError(f"a size is {', '.join(SIZES)}, not {size}")
    return {"base": base or DEFAULT_BASE, "setup": setup, "install": install, "size": size}


class RecipeBuilder:
    """The recipe as a job takes it. Each step returns a new recipe, so two tasks can share one as a base."""

    def __init__(
        self, base: str | None = None, setup: str = "", install: str = "", size: str = "medium", spec: Recipe | None = None,
    ) -> None:
        self.spec: Recipe = spec if spec is not None else _spec(base, setup, install, size)

    def apt(self, *packages: str) -> "RecipeBuilder":
        """Debian packages, installed in setup as root."""
        installs = "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends"
        return self._then("setup", f"{installs} {' '.join(quote(each) for each in packages)}")

    def setup(self, script: str) -> "RecipeBuilder":
        """More of setup, run as root once per environment."""
        return self._then("setup", script)

    def install(self, script: str) -> "RecipeBuilder":
        """More of install, run as the user in the checkout once per environment."""
        return self._then("install", script)

    def size(self, size: str) -> "RecipeBuilder":
        grown = copy.copy(self.spec)
        grown["size"] = size
        _spec(None, "", "", size)  # the check
        return RecipeBuilder(spec=grown)

    def _then(self, which: str, step: str) -> "RecipeBuilder":
        grown = copy.copy(self.spec)
        before = str(grown[which])
        grown[which] = step if before == "" else before + "\n" + step
        return RecipeBuilder(spec=grown)


def debian() -> RecipeBuilder:
    """`cloudflare/debian-trixie`, the base a recipe has by default."""
    return RecipeBuilder()


def from_(base: str) -> RecipeBuilder:
    """Another base image, one the runtime starts by name."""
    return RecipeBuilder(base)


class _RecipeOf:
    """`recipe()` builds a recipe; `recipe.debian()` and `recipe.from_` its bases — task.ts's RecipeOf."""

    def __call__(self, base: str | None = None, setup: str = "", install: str = "", size: str = "medium") -> RecipeBuilder:
        return RecipeBuilder(base, setup, install, size)

    def debian(self) -> RecipeBuilder:
        return debian()

    def from_(self, base: str) -> RecipeBuilder:
        return from_(base)


recipe = _RecipeOf()
