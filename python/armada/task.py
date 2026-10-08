"""armada's typed API, Python-side: `task` defines one, by an id unique in its deployment; its body runs in a
container on each item, returning a value, or a `sh` command whose `out` file is the answer. `python -m armada
push` sends a project's task folder, and `.map`, `.stream`, `.run` and `.local` run a task by its id."""

import base64
import json
import os
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import (Any, BinaryIO, Callable, Generic, Iterable, Iterator, Literal, Optional, Protocol, TypedDict,
                    TypeVar, Union, cast, overload)

from .client import Armada, connect, JobStatus, Summary, summary_of
from .recipe import Recipe, RecipeBuilder, recipe as default_recipe
from .sh import OutFile, Shell, ShellError, execute, out_file
from .wire import Json, remote_error

I = TypeVar("I")
O = TypeVar("O")
O_co = TypeVar("O_co", covariant=True)
V = TypeVar("V")
V_co = TypeVar("V_co", covariant=True)

# An open job's items go in batches of this many, or what came in this long.
BATCH = 500
BATCH_S = 0.25

# How long a job's reader waits when no outcome landed.
POLL_S = 1.0


class SchemaError(Exception):
    """An item or an answer that failed its validator."""

    def __init__(self, what: str, problem: object) -> None:
        super().__init__(f"{what} does not fit its schema: {problem}")
        self.what = what
        self.problem = problem


class Validates(Protocol[O_co]):
    """A model class whose `model_validate` checks a JSON value — pydantic's shape."""

    @classmethod
    def model_validate(cls, value: object) -> O_co: ...


# What `input`/`output` take: a callable that raises on a bad value, or a model class with `model_validate`.
Validator = Union[Callable[[object], O_co], "type[Validates[O_co]]"]


def _check(validator: object, value: object, what: str) -> Any:
    """`value` through its validator: a model class's `model_validate`, or any callable that raises on bad input."""
    if validator is None:
        return value
    try:
        model_validate = getattr(validator, "model_validate", None)
        if callable(model_validate):
            return model_validate(value)
        if callable(validator):
            return validator(value)
    except Exception as cause:
        raise SchemaError(what, cause) from cause
    raise TypeError(f"{what}'s validator is not callable: {validator!r}")


@dataclass(frozen=True)
class RemoteError:
    """The error a task's body threw, as the envelope carries it."""

    name: str
    message: str
    stack: str


@dataclass(frozen=True)
class Meta:
    """What a task's run reports: the same fields the TS `Meta` carries, snake_cased."""

    seconds: float
    attempt: int
    container: str
    exit_code: int
    tail: str
    peak_memory: Optional[int] = None
    cpu_seconds: Optional[float] = None
    artifacts: bool = False
    cached: bool = False


@dataclass(frozen=True)
class Ok(Generic[I, O]):
    index: int
    item: I
    meta: Meta
    value: O
    ok: Literal[True] = True
    kind: Literal["ok"] = "ok"


@dataclass(frozen=True)
class Errored(Generic[I, O]):
    """The body threw, its value failed its validator, or its command exited nonzero."""

    index: int
    item: I
    meta: Meta
    error: RemoteError
    ok: Literal[False] = False
    kind: Literal["error"] = "error"


@dataclass(frozen=True)
class TimedOut(Generic[I, O]):
    index: int
    item: I
    meta: Meta
    ok: Literal[False] = False
    kind: Literal["timeout"] = "timeout"


@dataclass(frozen=True)
class Cancelled(Generic[I, O]):
    index: int
    item: I
    meta: Meta
    reason: str
    ok: Literal[False] = False
    kind: Literal["cancelled"] = "cancelled"


@dataclass(frozen=True)
class Lost(Generic[I, O]):
    """The platform lost the task on every attempt."""

    index: int
    item: I
    meta: Meta
    reason: str
    ok: Literal[False] = False
    kind: Literal["lost"] = "lost"


Result = Union[Ok[I, O], Errored[I, O], TimedOut[I, O], Cancelled[I, O], Lost[I, O]]


class MapError(Exception, Generic[I, O]):
    """A job whose results are not all `ok`: every result is here, in input order."""

    def __init__(self, results: list[Result[I, O]]) -> None:
        self.results = results
        failed = [result for result in results if not result.ok]
        first = failed[0] if failed else None
        super().__init__(f"{len(failed)} of {len(results)} tasks did not succeed" + ("" if first is None else f"; item {first.index}: {_describe(first)}"))


def _describe(result: Result[Any, Any]) -> str:
    if isinstance(result, Ok):
        return "ok"
    if isinstance(result, Errored):
        return f"{result.error.name}: {result.error.message}"
    if isinstance(result, TimedOut):
        return f"timed out after {result.meta.seconds:.0f} s"
    return f"{result.kind}: {result.reason}"


@dataclass
class Context:
    """What a body gets beside its input."""

    index: int
    attempt: int
    stopped: threading.Event
    out: OutFile
    files: str
    artifacts: str
    secrets: dict[str, str]


def _command_answer(output: object, exit_code: int, tail: str, read: Callable[[], Optional[bytes]], inline: object = None) -> Union[_Value, RemoteError]:
    """A command's answer: its `out` read as `output` says, once it exited 0 — the same shapes the TS `answer` gives."""
    if exit_code != 0:
        return RemoteError("Exit", f"the command exited {exit_code}", tail)
    if output is None:
        return _Value(None)
    if output == "bytes":
        return _Value(read() or b"")
    try:
        text = inline if isinstance(inline, str) else (read() or b"").decode()
        return _Value(text if output == "text" else _check(output, json.loads(text), "the output"))
    except Exception as cause:
        return RemoteError(**remote_error(cause))


def _envelope_answer(outcome: dict[str, Any], read: Callable[[], Optional[bytes]]) -> Union[_Value, RemoteError]:
    """A pushed task's answer: the envelope its process wrote, or an Exit when it died before answering."""
    inline = outcome.get("value")
    text = inline if isinstance(inline, str) else (read() or b"").decode()
    parsed: Any = None
    try:
        parsed = json.loads(text)
    except Exception:
        pass
    if not isinstance(parsed, dict):
        return RemoteError("Exit", f"the task's process exited {outcome.get('exitCode', 1)}", str(outcome.get("tail", "")))
    envelope: dict[Any, Any] = parsed
    if not isinstance(envelope.get("ok"), bool):
        return RemoteError("Exit", f"the task's process exited {outcome.get('exitCode', 1)}", str(outcome.get("tail", "")))
    if envelope["ok"] is not True:
        error_field: Any = envelope.get("error")
        error = error_field if isinstance(error_field, dict) else {}
        return RemoteError(str(error.get("name", "Error")), str(error.get("message", "")), str(error.get("stack", "")))
    if isinstance(envelope.get("bytes"), str):
        return _Value(base64.b64decode(envelope["bytes"]))
    return _Value(envelope.get("value"))


@dataclass(frozen=True)
class _Value:
    """An answer that came back ok, before it is joined with its item and meta into a Result."""

    value: Any


class Submission(Generic[I]):
    """How a job's items reach it: all at once, or streamed into an open job in batches a timer flushes too."""

    def __init__(self, armada: Armada) -> None:
        self.armada = armada
        self.sent: Optional[list[I]] = []
        self.id: Optional[str] = None
        self.failure: Optional[BaseException] = None
        self.known = threading.Event()
        self.done = threading.Event()
        self.stopped = False

    def resolve(self, job: str) -> None:
        self.id = job
        self.known.set()

    def fail(self, cause: BaseException) -> None:
        self.failure = cause
        self.stopped = True
        self.known.set()
        self.done.set()

    def pump(self, items: Iterable[I], make: Callable[[I, int], dict[str, Any]]) -> None:
        """Runs in a thread: batches items into the open job, 500 to a batch or every BATCH_S, then closes it."""
        job = self.id
        assert job is not None
        batch: list[dict[str, Any]] = []
        last = time.monotonic()
        try:
            for item in items:
                if self.stopped:
                    return
                assert self.sent is not None
                batch.append(make(item, len(self.sent)))
                self.sent.append(item)
                if len(batch) >= BATCH or time.monotonic() - last >= BATCH_S:
                    self.armada.add(job, batch)
                    batch = []
                    last = time.monotonic()
            if batch:
                self.armada.add(job, batch)
            self.armada.close(job)
            self.done.set()
        except BaseException as cause:
            self.armada.cancel(job)
            self.fail(cause)


class Job(Generic[I, O]):
    """A job's results: in completion order by iterating it, or in input order."""

    def __init__(self, armada: Armada, task: "Task[I, O]", submission: Submission[I]) -> None:
        self.armada = armada
        self._task = task
        self.submission = submission
        self._held: Optional[list[Any]] = None

    @property
    def id(self) -> str:
        self.submission.known.wait()
        if self.submission.failure is not None:
            raise self.submission.failure
        assert self.submission.id is not None
        return self.submission.id

    def _item(self, index: int) -> I:
        if self.submission.sent is not None:
            return self.submission.sent[index]
        if self._held is None or index >= len(self._held):
            self._held = self.armada.items(self.id)
        held: I = self._held[index]
        return held

    def _result(self, outcome: dict[str, Any]) -> Result[I, O]:
        item = self._item(int(outcome["index"]))
        meta = Meta(
            seconds=float(outcome.get("seconds", 0)), attempt=int(outcome.get("attempt", 1)), container=str(outcome.get("vessel", "")),
            exit_code=int(outcome.get("exitCode", 0)), tail=str(outcome.get("tail", "")), peak_memory=outcome.get("peakMemory"),
            cpu_seconds=outcome.get("cpuSeconds"), artifacts=outcome.get("artifacts") is True, cached=outcome.get("cached") is True,
        )
        index = int(outcome["index"])
        if outcome.get("kind") == "failed":
            if outcome.get("reason") == "cancelled":
                return Cancelled(index, item, meta, meta.tail)
            return Lost(index, item, meta, meta.tail)
        if outcome.get("reason") == "timeout":
            return TimedOut(index, item, meta)
        answered = self._task.answer(outcome, lambda: self.armada.output(self.id, index))
        if isinstance(answered, RemoteError):
            return Errored(index, item, meta, answered)
        return Ok(index, item, meta, answered.value)

    def __iter__(self) -> Iterator[Result[I, O]]:
        after = 0
        seen: set[int] = set()
        while True:
            batch = self.armada.events(self.id, after)
            for event in batch.get("events", []):
                outcome = event["outcome"]
                if outcome["index"] in seen:
                    continue
                seen.add(outcome["index"])
                after = max(after, int(event.get("seq", after)))
                yield self._result(outcome)
            if batch.get("done"):
                self.submission.stopped = True
                if self.submission.failure is not None:
                    raise self.submission.failure
                return
            if not batch.get("events"):
                time.sleep(POLL_S)

    def ordered(self) -> Iterator[Result[I, O]]:
        """Results in input order, each as soon as those before it have landed."""
        landed: dict[int, Result[I, O]] = {}
        following = 0
        for result in self:
            landed[result.index] = result
            while following in landed:
                yield landed.pop(following)
                following += 1
        yield from sorted(landed.values(), key=lambda result: result.index)

    def settled(self) -> list[Result[I, O]]:
        return sorted(list(self), key=lambda result: result.index)

    def values(self) -> list[O]:
        """Every value, in input order, or a MapError holding every result when one is not `ok`."""
        results = self.settled()
        if any(not result.ok for result in results):
            raise MapError(results)
        return [result.value for result in results if isinstance(result, Ok)]

    def cancel(self) -> None:
        self.submission.stopped = True
        self.armada.cancel(self.id)

    def status(self) -> JobStatus:
        return self.armada.status(self.id)

    def summary(self) -> Summary:
        return summary_of(self.status())

    def log(self, index: int) -> Optional[str]:
        return self.armada.log(self.id, index)

    def output(self, index: int) -> Optional[bytes]:
        return self.armada.output(self.id, index)

    def output_stream(self, index: int) -> Optional[BinaryIO]:
        return self.armada.output_stream(self.id, index)

    def artifacts(self, index: int) -> Optional[bytes]:
        return self.armada.artifacts(self.id, index)


class Retries(TypedDict, total=False):
    """`{"attempts": 3, "on": [137, "TimeoutError"]}` — runs again on those exit codes or error names."""

    attempts: int
    on: list[Union[int, str]]
    backoffSeconds: float


def _retries(retries: Optional[Retries]) -> Optional[dict[str, Any]]:
    if retries is None:
        return None
    on = retries.get("on", [])
    return {
        "attempts": retries["attempts"],
        **({"backoffSeconds": retries["backoffSeconds"]} if "backoffSeconds" in retries else {}),
        "exitCodes": [each for each in on if isinstance(each, int)],
        "errors": [each for each in on if isinstance(each, str)],
    }


class Task(Generic[I, O]):
    """A task: `task(...)` on a function gives it this — its id, its spec options, and the runs."""

    def __init__(self, *, task_id: str, body: Callable[[I, Context], Any], recipe_: object = None, output: object = None,
                 timeout: float = 3600, speculative: bool = False, retries: Optional[Retries] = None,
                 secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None, input: object = None) -> None:
        self.id = task_id
        self.body = body
        self._recipe = recipe_
        self.output = output
        self.timeout = timeout
        self.speculative = speculative
        self.retries = retries
        self.secrets = list(secrets)
        self.cache = cache
        self.input = input

    @property
    def recipe(self) -> Recipe:
        given = self._recipe() if callable(self._recipe) else self._recipe
        built = given.spec if isinstance(given, RecipeBuilder) else given
        return built if isinstance(built, dict) else default_recipe().spec

    def _spec(self, pool: Optional[int], slots: Optional[int], label: str, env: Optional[dict[str, str]],
              files: Optional[dict[str, str]], tmpfs: Optional[list[str]], bundle: Optional[str]) -> dict[str, Any]:
        spec = {
            "recipe": self.recipe,
            "run": {"kind": "task", "id": self.id, **({"bundle": bundle, "runtime": "python"} if bundle is not None else {})},
            "output": True, "pool": pool, "slots": slots, "label": label,
            "env": env or {}, "files": files or {}, "tmpfs": tmpfs or ["/tmp", "/dev/shm"],
            "timeout": self.timeout, "speculative": self.speculative, "retries": _retries(self.retries),
            "secrets": self.secrets, "cache": self.cache,
        }
        return {key: value for key, value in spec.items() if value is not None}

    def stream(self, items: Iterable[I], *, pool: Optional[int] = None, slots: Optional[int] = None,
               label: str = "", env: Optional[dict[str, str]] = None, files: Optional[dict[str, str]] = None,
               tmpfs: Optional[list[str]] = None, armada: Optional[Armada] = None) -> Job[I, O]:
        """The job, whose results arrive as they land. Items stream in when given as a generator."""
        client = armada or connect()
        from .push import pushed

        bundle = pushed(client)
        submission: Submission[I] = Submission(client)

        def create() -> None:
            try:
                if isinstance(items, list):
                    submission.sent = list(items)
                    spec = {**self._spec(pool, slots, label, env, files, tmpfs, bundle), "items": [self._wire(item, at) for at, item in enumerate(items)]}
                    submission.resolve(client.create(spec))
                    submission.done.set()
                else:
                    spec = {**self._spec(pool, slots, label, env, files, tmpfs, bundle), "items": [], "open": True}
                    submission.resolve(client.create(spec))
                    submission.pump(items, self._wire)
            except BaseException as cause:
                submission.fail(cause)

        threading.Thread(target=create, daemon=True).start()
        return Job(client, self, submission)

    def map(self, items: Iterable[I], *, pool: Optional[int] = None, slots: Optional[int] = None,
            label: str = "", env: Optional[dict[str, str]] = None, files: Optional[dict[str, str]] = None,
            tmpfs: Optional[list[str]] = None, armada: Optional[Armada] = None) -> list[O]:
        """Every item's value, in input order, or a MapError holding every result when one is not ok."""
        return self.stream(items, pool=pool, slots=slots, label=label, env=env, files=files, tmpfs=tmpfs, armada=armada).values()

    def run(self, item: I, *, pool: Optional[int] = None, slots: Optional[int] = None,
            label: str = "", env: Optional[dict[str, str]] = None, files: Optional[dict[str, str]] = None,
            tmpfs: Optional[list[str]] = None, armada: Optional[Armada] = None) -> O:
        """One item's value, on one container."""
        results = self.stream([item], pool=pool, slots=slots, label=label, env=env, files=files, tmpfs=tmpfs, armada=armada).settled()
        first = results[0] if results else None
        if not isinstance(first, Ok):
            raise MapError(results)
        return first.value

    def local(self, item: I) -> O:
        """One item's value, on this machine, with no container."""
        with tempfile.TemporaryDirectory(prefix="armada-local-") as scratch:
            out = os.path.join(scratch, "out")
            artifacts = os.path.join(scratch, "artifacts")
            os.mkdir(artifacts)
            missing = next((name for name in self.secrets if name not in os.environ), None)
            if missing is not None:
                raise RuntimeError(f".local reads the secret {missing} from this machine's environment, which lacks it")
            context = Context(0, 1, threading.Event(), out_file(out), scratch, artifacts, {name: os.environ[name] for name in self.secrets})
            checked = _check(self.input, item, "the input")
            returned = self.body(checked, context)
            if not isinstance(returned, Shell):
                answered = returned if self.output is None or isinstance(self.output, str) else _check(self.output, returned, "the value")
                return cast(O, answered)
            ran = execute(returned.script, env={"ARMADA_OUT": out, "ARMADA_ARTIFACTS": artifacts})
            if ran.exit_code != 0:
                raise ShellError(returned.script, ran.exit_code, ran.stderr)
            answered = _command_answer(self.output, 0, ran.stderr, lambda: Path(out).read_bytes() if os.path.exists(out) else None)
            if isinstance(answered, RemoteError):
                raise RuntimeError(answered.message)
            return cast(O, answered.value)

    def job(self, job_id: str, *, armada: Optional[Armada] = None) -> Job[I, O]:
        """A job this task ran, by its id."""
        client = armada or connect()
        submission: Submission[I] = Submission(client)
        submission.sent = None
        submission.resolve(job_id)
        return Job(client, self, submission)

    def _wire(self, item: I, index: int) -> dict[str, Any]:
        """An item as a wire task, checked first."""
        if self.input is not None:
            _check(self.input, item, f"item {index}")
        return {"item": item}

    def answer(self, outcome: dict[str, Any], read: Callable[[], Optional[bytes]]) -> Union[_Value, RemoteError]:
        """An exited task's answer."""
        if outcome.get("answer") == "command":
            return _command_answer(self.output, int(outcome.get("exitCode", 1)), str(outcome.get("tail", "")), read, outcome.get("value"))
        return _envelope_answer(outcome, read)

    def run_envelope(self, item: Json, context: Context) -> Union[dict[str, Any], Shell]:
        """The body on an item: its value or its shell, the bundle's runner's contract (runner.ts's RUN)."""
        try:
            checked = _check(self.input, item, "the input")
            returned = self.body(checked, context)
            if isinstance(returned, Shell):
                return returned
            value = returned if self.output is None or isinstance(self.output, str) else _check(self.output, returned, "the value")
            return {"ok": True, "bytes": base64.b64encode(value).decode()} if isinstance(value, (bytes, bytearray)) else {"ok": True, "value": value}
        except Exception as cause:
            return {"ok": False, "error": remote_error(cause)}


# `@task` overloads: the body's and `output`'s shapes decide the Task's item and answer types, through the
# callable each shape returns — `input` types the wire item by its own argument and the body by its output.


class _FromText(Protocol[I, V_co]):
    """`@task(..., output="text", input=f)` on a body returning a Shell."""

    def __call__(self, body: Callable[[V_co, Context], Shell], /) -> Task[I, str]: ...


class _FromBytes(Protocol[I, V_co]):
    def __call__(self, body: Callable[[V_co, Context], Shell], /) -> Task[I, bytes]: ...


class _FromValidate(Protocol[I, V_co, O]):
    def __call__(self, body: Callable[[V_co, Context], Any], /) -> Task[I, O]: ...


class _FromDecorate(Protocol[I, V_co]):
    @overload
    def __call__(self, body: Callable[[V_co, Context], Shell], /) -> Task[I, None]: ...

    @overload
    def __call__(self, body: Callable[[V_co, Context], O], /) -> Task[I, O]: ...


class _Text(Protocol):
    def __call__(self, body: Callable[[I, Context], Shell], /) -> Task[I, str]: ...


class _Bytes(Protocol):
    def __call__(self, body: Callable[[I, Context], Shell], /) -> Task[I, bytes]: ...


class _Validate(Protocol[O]):
    def __call__(self, body: Callable[[I, Context], Any], /) -> Task[I, O]: ...


class _Decorate(Protocol):
    @overload
    def __call__(self, body: Callable[[I, Context], Shell], /) -> Task[I, None]: ...

    @overload
    def __call__(self, body: Callable[[I, Context], O], /) -> Task[I, O]: ...


@overload
def task(*, id: str, recipe: object = None, output: Literal["text"], timeout: float = 3600, speculative: bool = False,
         retries: Optional[Retries] = None, secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None,
         input: Callable[[I], V]) -> _FromText[I, V]: ...


@overload
def task(*, id: str, recipe: object = None, output: Literal["text"], timeout: float = 3600, speculative: bool = False,
         retries: Optional[Retries] = None, secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None,
         input: "type[Validates[V]]") -> _FromText[object, V]: ...


@overload
def task(*, id: str, recipe: object = None, output: Literal["text"], timeout: float = 3600, speculative: bool = False,
         retries: Optional[Retries] = None, secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None,
         input: None = None) -> _Text: ...


@overload
def task(*, id: str, recipe: object = None, output: Literal["bytes"], timeout: float = 3600, speculative: bool = False,
         retries: Optional[Retries] = None, secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None,
         input: Callable[[I], V]) -> _FromBytes[I, V]: ...


@overload
def task(*, id: str, recipe: object = None, output: Literal["bytes"], timeout: float = 3600, speculative: bool = False,
         retries: Optional[Retries] = None, secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None,
         input: "type[Validates[V]]") -> _FromBytes[object, V]: ...


@overload
def task(*, id: str, recipe: object = None, output: Literal["bytes"], timeout: float = 3600, speculative: bool = False,
         retries: Optional[Retries] = None, secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None,
         input: None = None) -> _Bytes: ...


@overload
def task(*, id: str, recipe: object = None, output: Validator[O], timeout: float = 3600, speculative: bool = False,
         retries: Optional[Retries] = None, secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None,
         input: Callable[[I], V]) -> _FromValidate[I, V, O]: ...


@overload
def task(*, id: str, recipe: object = None, output: Validator[O], timeout: float = 3600, speculative: bool = False,
         retries: Optional[Retries] = None, secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None,
         input: "type[Validates[V]]") -> _FromValidate[object, V, O]: ...


@overload
def task(*, id: str, recipe: object = None, output: Validator[O], timeout: float = 3600, speculative: bool = False,
         retries: Optional[Retries] = None, secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None,
         input: None = None) -> _Validate[O]: ...


@overload
def task(*, id: str, recipe: object = None, output: None = None, timeout: float = 3600, speculative: bool = False,
         retries: Optional[Retries] = None, secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None,
         input: Callable[[I], V]) -> _FromDecorate[I, V]: ...


@overload
def task(*, id: str, recipe: object = None, output: None = None, timeout: float = 3600, speculative: bool = False,
         retries: Optional[Retries] = None, secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None,
         input: "type[Validates[V]]") -> _FromDecorate[object, V]: ...


@overload
def task(*, id: str, recipe: object = None, output: None = None, timeout: float = 3600, speculative: bool = False,
         retries: Optional[Retries] = None, secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None,
         input: None = None) -> _Decorate: ...


def task(*, id: str, recipe: object = None, output: object = None, timeout: float = 3600, speculative: bool = False,
         retries: Optional[Retries] = None, secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None,
         input: object = None) -> Callable[[Callable[..., Any]], Task[Any, Any]]:
    """A task, exported from a file in the project's task folder so `python -m armada push` finds it. With an
    `input` validator, callers pass its input and the body gets its output. A body's value, or a command's out,
    is checked by `output` before it counts as ok."""

    def wrap(body: Callable[..., Any]) -> Task[Any, Any]:
        return Task(task_id=id, body=body, recipe_=recipe, output=output, timeout=timeout, speculative=speculative,
                    retries=retries, secrets=secrets, cache=cache, input=input)

    return wrap
