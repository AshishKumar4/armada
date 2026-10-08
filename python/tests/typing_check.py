"""mypy-checked typing cases for the SDK's public API: run under `mypy --strict` (the python CI row), not under
unittest — every `assert_type` asserts the type mypy infers for the API's shape."""

import sys
from pathlib import Path
from typing import assert_type

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from armada import Context, Ok, Result, Task, task
from armada.client import JobStatus, Summary
from armada.sh import Shell, sh
from armada.task import Cancelled, Errored, Job, Lost, MapError, TimedOut
from armada.wire import Json


# A body returning a value, no output: the Task's item and answer types are the body's.
@task(id="square")
def square(n: int, ctx: Context) -> int:
    return n * n


assert_type(square, Task[int, int])


# Without an output, any JSON a body answers keeps its type: a list or a dict of numbers fits.
@task(id="spread")
def spread(n: int, ctx: Context) -> list[int]:
    return [n, n + 1]


assert_type(spread, Task[int, list[int]])


# A body returning a Shell with output="text" answers str; "bytes" answers bytes; none answers None.
@task(id="shout", output="text")
def shout(word: str, ctx: Context) -> Shell:
    return sh("echo {} > {}", word, ctx.out)


assert_type(shout, Task[str, str])


@task(id="raw", output="bytes")
def raw_task(n: int, ctx: Context) -> Shell:
    return sh("printf x > {}", ctx.out)


assert_type(raw_task, Task[int, bytes])


@task(id="quiet")
def quiet(n: int, ctx: Context) -> Shell:
    return sh("true")


assert_type(quiet, Task[int, None])


# An output validator decides the answer type: a callable, or a model class with model_validate.
class Point:
    @classmethod
    def model_validate(cls, value: object) -> "Point":
        if not isinstance(value, dict) or not isinstance(value.get("x"), (int, float)):
            raise ValueError("no x")
        return cls()

    x: float = 0.0


@task(id="point", output=Point)
def point(n: int, ctx: Context) -> dict[str, float]:
    return {"x": float(n)}


assert_type(point, Task[int, Point])


@task(id="doubled", output=lambda v: str(v))
def doubled(n: int, ctx: Context) -> int:
    return n * 2


assert_type(doubled, Task[int, str])


# An input validator: callers pass its input type, the body gets its output type.
def _whole(v: str) -> int:
    return int(v)


@task(id="halved", input=_whole)
def halved(n: int, ctx: Context) -> int:
    return n // 2


assert_type(halved, Task[str, int])


class Port:
    @classmethod
    def model_validate(cls, value: object) -> "Port":
        return cls()


@task(id="served", input=Port)
def served(port: Port, ctx: Context) -> int:
    return 0


assert_type(served, Task[Json, int])


# Results narrow on `ok`: the union's discriminant gives `value` only to an ok result.
def read(result: Result[int, str]) -> None:
    if result.ok:
        assert_type(result, Ok[int, str])
        assert_type(result.value, str)
    else:
        assert_type(result, Errored[int, str] | TimedOut[int, str] | Cancelled[int, str] | Lost[int, str])


# A MapError holds every result, in input order.
def held(error: MapError[int, str]) -> list[Result[int, str]]:
    return error.results


# A job's status and summary are the client's typed records.
def followed(job: Job[int, str]) -> None:
    assert_type(job.status(), JobStatus)
    assert_type(job.summary(), Summary)
