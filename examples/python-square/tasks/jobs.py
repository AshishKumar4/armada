"""The example's tasks: a value, bytes, a command, validators, a secret, artifacts, a retry and a cache."""

from armada import Context, sh, task


@task(id="square")
def square(n: int, ctx: Context) -> int:
    return n * n


@task(id="png", output="bytes")
def png(n: int, ctx: Context) -> bytes:
    return bytes([n & 0xFF]) * 4


@task(id="shout", output="text")
def shout(word: str, ctx: Context):
    return sh("echo {} | tr a-z A-Z > {}", word, ctx.out)


@task(id="even", input=lambda n: n if n % 2 == 0 else (_ for _ in ()).throw(ValueError("odd")))
def even(n: int, ctx: Context) -> int:
    return n // 2


class Halves:
    """An output model: what `halves` answers, checked where the result lands."""

    def __init__(self, whole: int, half: float) -> None:
        self.whole = whole
        self.half = half

    @classmethod
    def model_validate(cls, value: object) -> "Halves":
        if not isinstance(value, dict) or not isinstance(value.get("whole"), int) or not isinstance(value.get("half"), float):
            raise ValueError(f"not halves: {value!r}")
        return cls(value["whole"], value["half"])


@task(id="halves", output=Halves)
def halves(n: int, ctx: Context) -> dict[str, float]:
    return {"whole": n, "half": n / 2}


@task(id="whoami", secrets=["ARMADA_EXAMPLE_WORD"])
def whoami(n: int, ctx: Context) -> str:
    return ctx.secrets["ARMADA_EXAMPLE_WORD"]


@task(id="keeper")
def keeper(n: int, ctx: Context) -> str:
    import os
    with open(os.path.join(ctx.artifacts, f"note-{n}.txt"), "w") as file:
        file.write(f"kept {n}")
    return f"wrote note-{n}.txt"


@task(id="flake", retries={"attempts": 3, "on": ["FlakeError"]})
def flake(n: int, ctx: Context) -> int:
    class FlakeError(Exception):
        pass

    if ctx.attempt < 2:
        raise FlakeError("first try")
    return n


@task(id="seen", cache={"days": 7})
def seen(n: int, ctx: Context) -> int:
    return n + 1
