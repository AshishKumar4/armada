"""armada's typed API, Python-side: `task` defines one, by an id unique in its deployment; its body runs in a
container on each item, returning a value, or a `sh` command whose `out` file is the answer. `python -m armada
push` sends a project's task folder, and `.map`, `.stream`, `.run` and `.local` run a task by its id."""

import base64
import json
import os
import tempfile
import threading
import time
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Generic, Literal, Protocol, TypedDict, TypeVar, Union, cast, overload

from .client import Armada, JobStatus, Summary, connect, summary_of
from .recipe import Recipe, RecipeBuilder, recipe as default_recipe
from .sh import OutFile, Shell, ShellError, execute, out_file
from .wire import Json, maybe_number_of, number_of, object_of, remote_error, text_of

# A job's items travel as JSON, so an item type is one JSON can carry.
In = TypeVar("In", bound=Json)
Out = TypeVar("Out")
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


def _check(validator: object, value: object, what: str) -> object:
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
    peak_memory: int | None = None
    cpu_seconds: float | None = None
    artifacts: bool = False
    cached: bool = False


@dataclass(frozen=True)
class Ok(Generic[In, Out]):
    index: int
    item: In
    meta: Meta
    value: Out
    ok: Literal[True] = True
    kind: Literal["ok"] = "ok"


@dataclass(frozen=True)
class Errored(Generic[In, Out]):
    """The body threw, its value failed its validator, or its command exited nonzero."""

    index: int
    item: In
    meta: Meta
    error: RemoteError
    ok: Literal[False] = False
    kind: Literal["error"] = "error"


@dataclass(frozen=True)
class TimedOut(Generic[In, Out]):
    index: int
    item: In
    meta: Meta
    ok: Literal[False] = False
    kind: Literal["timeout"] = "timeout"


@dataclass(frozen=True)
class Cancelled(Generic[In, Out]):
    index: int
    item: In
    meta: Meta
    reason: str
    ok: Literal[False] = False
    kind: Literal["cancelled"] = "cancelled"


@dataclass(frozen=True)
class Lost(Generic[In, Out]):
    """The platform lost the task on every attempt."""

    index: int
    item: In
    meta: Meta
    reason: str
    ok: Literal[False] = False
    kind: Literal["lost"] = "lost"


Result = Ok[In, Out] | Errored[In, Out] | TimedOut[In, Out] | Cancelled[In, Out] | Lost[In, Out]


class MapError(Exception, Generic[In, Out]):
    """A job whose results are not all `ok`: every result is here, in input order."""

    def __init__(self, results: list[Result[In, Out]]) -> None:
        self.results = results
        failed = [result for result in results if not result.ok]
        first = failed[0] if failed else None
        said = "" if first is None else f"; item {first.index}: {_describe(first)}"
        super().__init__(f"{len(failed)} of {len(results)} tasks did not succeed{said}")


def _describe(result: Result[In, Out]) -> str:
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


@dataclass(frozen=True)
class _Value:
    """An answer that came back ok, before it is joined with its item and meta into a Result."""

    value: object


def _command_answer(
    output: object, exit_code: int, tail: str, read: Callable[[], bytes | None], inline: Json = None,
) -> _Value | RemoteError:
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


def _envelope_answer(outcome: Mapping[str, Json], read: Callable[[], bytes | None]) -> _Value | RemoteError:
    """A pushed task's answer: the envelope its process wrote, or an Exit when it died before answering."""
    inline = outcome.get("value")
    text = inline if isinstance(inline, str) else (read() or b"").decode()
    try:
        parsed: Json = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
    envelope = object_of(parsed)
    ok = envelope.get("ok")
    if not isinstance(ok, bool):
        return RemoteError("Exit", f"the task's process exited {number_of(outcome, 'exitCode', 1):.0f}", text_of(outcome, "tail"))
    if not ok:
        error = object_of(envelope.get("error"))
        return RemoteError(text_of(error, "name", "Error"), text_of(error, "message"), text_of(error, "stack"))
    encoded = envelope.get("bytes")
    return _Value(base64.b64decode(encoded) if isinstance(encoded, str) else envelope.get("value"))


class Submission(Generic[In]):
    """How a job's items reach it: all at once, or streamed into an open job in batches a timer flushes too."""

    def __init__(self, armada: Armada) -> None:
        self.armada = armada
        self.sent: list[In] | None = []
        self.id: str | None = None
        self.failure: BaseException | None = None
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

    def pump(self, items: Iterable[In], make: Callable[[In, int], "WireTask"]) -> None:
        """Runs in a thread: batches items into the open job, 500 to a batch or every BATCH_S, then closes it."""
        job = self.id
        assert job is not None
        batch: list[WireTask] = []
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


class Job(Generic[In, Out]):
    """A job's results: in completion order by iterating it, or in input order."""

    def __init__(self, armada: Armada, task: "Task[In, Out]", submission: Submission[In]) -> None:
        self.armada = armada
        self._task = task
        self.submission = submission
        self._held: list[Json] | None = None

    @property
    def id(self) -> str:
        self.submission.known.wait()
        if self.submission.failure is not None:
            raise self.submission.failure
        assert self.submission.id is not None
        return self.submission.id

    def _item(self, index: int) -> In:
        if self.submission.sent is not None:
            return self.submission.sent[index]
        if self._held is None or index >= len(self._held):
            self._held = self.armada.items(self.id)
        # The items a job holds are the ones its caller gave this task, as task.ts trusts them too.
        return cast(In, self._held[index])

    def _result(self, index: int, outcome: Mapping[str, Json]) -> Result[In, Out]:
        item = self._item(index)
        peak = maybe_number_of(outcome, "peakMemory")
        meta = Meta(
            seconds=number_of(outcome, "seconds", 0), attempt=int(number_of(outcome, "attempt", 1)), container=text_of(outcome, "vessel"),
            exit_code=int(number_of(outcome, "exitCode", 0)), tail=text_of(outcome, "tail"),
            peak_memory=None if peak is None else int(peak), cpu_seconds=maybe_number_of(outcome, "cpuSeconds"),
            artifacts=outcome.get("artifacts") is True, cached=outcome.get("cached") is True,
        )
        if outcome.get("kind") == "failed":
            if outcome.get("reason") == "cancelled":
                return Cancelled(index, item, meta, meta.tail)
            return Lost(index, item, meta, meta.tail)
        if outcome.get("reason") == "timeout":
            return TimedOut(index, item, meta)
        answered = self._task.answer(outcome, lambda: self.armada.output(self.id, index))
        if isinstance(answered, RemoteError):
            return Errored(index, item, meta, answered)
        # The decorator's overload typed Out by this task's body and output; the wire carries what that body answered.
        return Ok(index, item, meta, cast(Out, answered.value))

    def __iter__(self) -> Iterator[Result[In, Out]]:
        after = 0
        seen: set[int] = set()
        while True:
            page = self.armada.events(self.id, after)
            listed = page.get("events")
            events = listed if isinstance(listed, list) else []
            for event in map(object_of, events):
                outcome = object_of(event.get("outcome"))
                index = int(number_of(outcome, "index", -1))
                after = max(after, int(number_of(event, "seq", after)))
                if index < 0 or index in seen:
                    continue
                seen.add(index)
                yield self._result(index, outcome)
            if page.get("done") is True:
                self.submission.stopped = True
                if self.submission.failure is not None:
                    raise self.submission.failure
                return
            if not events:
                time.sleep(POLL_S)

    def ordered(self) -> Iterator[Result[In, Out]]:
        """Results in input order, each as soon as those before it have landed."""
        landed: dict[int, Result[In, Out]] = {}
        following = 0
        for result in self:
            landed[result.index] = result
            while following in landed:
                yield landed.pop(following)
                following += 1
        yield from sorted(landed.values(), key=lambda result: result.index)

    def settled(self) -> list[Result[In, Out]]:
        return sorted(self, key=lambda result: result.index)

    def values(self) -> list[Out]:
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

    def log(self, index: int) -> str | None:
        return self.armada.log(self.id, index)

    def output(self, index: int) -> bytes | None:
        return self.armada.output(self.id, index)

    def output_stream(self, index: int) -> BinaryIO | None:
        return self.armada.output_stream(self.id, index)

    def artifacts(self, index: int) -> bytes | None:
        return self.armada.artifacts(self.id, index)


class Retries(TypedDict, total=False):
    """`{"attempts": 3, "on": [137, "TimeoutError"]}` — runs again on those exit codes or error names."""

    attempts: int
    on: list[int | str]
    backoffSeconds: float


class WireTask(TypedDict):
    """An item as the wire carries it."""

    item: Json


def _retries(retries: Retries | None) -> dict[str, object] | None:
    if retries is None:
        return None
    on = retries.get("on", [])
    return {
        "attempts": retries["attempts"],
        **({"backoffSeconds": retries["backoffSeconds"]} if "backoffSeconds" in retries else {}),
        "exitCodes": [each for each in on if isinstance(each, int)],
        "errors": [each for each in on if isinstance(each, str)],
    }


class Task(Generic[In, Out]):
    """A task: `task(...)` on a function gives it this — its id, its spec options, and the runs."""

    def __init__(self, *, task_id: str, body: Callable[..., object], recipe_: object = None, output: object = None,
                 timeout: float = 3600, speculative: bool = False, retries: Retries | None = None,
                 secrets: Iterable[str] = (), cache: dict[str, int] | None = None, input: object = None) -> None:
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

    def _spec(self, pool: int | None, slots: int | None, label: str, env: dict[str, str] | None,
              files: dict[str, str] | None, tmpfs: list[str] | None, bundle: str | None) -> dict[str, object]:
        spec = {
            "recipe": self.recipe,
            "run": {"kind": "task", "id": self.id, **({"bundle": bundle, "runtime": "python"} if bundle is not None else {})},
            "output": True, "pool": pool, "slots": slots, "label": label,
            "env": env or {}, "files": files or {}, "tmpfs": tmpfs or ["/tmp", "/dev/shm"],
            "timeout": self.timeout, "speculative": self.speculative, "retries": _retries(self.retries),
            "secrets": self.secrets, "cache": self.cache,
        }
        return {key: value for key, value in spec.items() if value is not None}

    def stream(self, items: Iterable[In], *, pool: int | None = None, slots: int | None = None,
               label: str = "", env: dict[str, str] | None = None, files: dict[str, str] | None = None,
               tmpfs: list[str] | None = None, armada: Armada | None = None) -> Job[In, Out]:
        """The job, whose results arrive as they land. Items stream in when given as a generator."""
        client = armada or connect()
        from .push import pushed

        bundle = pushed(client)
        submission: Submission[In] = Submission(client)

        def create() -> None:
            try:
                if isinstance(items, list):
                    submission.sent = list(items)
                    wired = [self._wire(item, at) for at, item in enumerate(items)]
                    spec = {**self._spec(pool, slots, label, env, files, tmpfs, bundle), "items": wired}
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

    def map(self, items: Iterable[In], *, pool: int | None = None, slots: int | None = None,
            label: str = "", env: dict[str, str] | None = None, files: dict[str, str] | None = None,
            tmpfs: list[str] | None = None, armada: Armada | None = None) -> list[Out]:
        """Every item's value, in input order, or a MapError holding every result when one is not ok."""
        return self.stream(items, pool=pool, slots=slots, label=label, env=env, files=files, tmpfs=tmpfs, armada=armada).values()

    def run(self, item: In, *, pool: int | None = None, slots: int | None = None,
            label: str = "", env: dict[str, str] | None = None, files: dict[str, str] | None = None,
            tmpfs: list[str] | None = None, armada: Armada | None = None) -> Out:
        """One item's value, on one container."""
        results = self.stream([item], pool=pool, slots=slots, label=label, env=env, files=files, tmpfs=tmpfs, armada=armada).settled()
        first = results[0] if results else None
        if not isinstance(first, Ok):
            raise MapError(results)
        return first.value

    def local(self, item: In) -> Out:
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
                # The decorator's overload typed Out by this body's return and the output's validator.
                return cast(Out, answered)
            ran = execute(returned.script, env={"ARMADA_OUT": out, "ARMADA_ARTIFACTS": artifacts})
            if ran.exit_code != 0:
                raise ShellError(returned.script, ran.exit_code, ran.stderr)
            answered = _command_answer(self.output, 0, ran.stderr, lambda: Path(out).read_bytes() if os.path.exists(out) else None)
            if isinstance(answered, RemoteError):
                raise RuntimeError(answered.message)
            # The decorator's overload typed Out by this command's output.
            return cast(Out, answered.value)

    def job(self, job_id: str, *, armada: Armada | None = None) -> Job[In, Out]:
        """A job this task ran, by its id."""
        client = armada or connect()
        submission: Submission[In] = Submission(client)
        submission.sent = None
        submission.resolve(job_id)
        return Job(client, self, submission)

    def _wire(self, item: In, index: int) -> WireTask:
        """An item as a wire task, checked first."""
        if self.input is not None:
            _check(self.input, item, f"item {index}")
        return {"item": item}

    def answer(self, outcome: Mapping[str, Json], read: Callable[[], bytes | None]) -> _Value | RemoteError:
        """An exited task's answer."""
        if outcome.get("answer") == "command":
            exit_code = int(number_of(outcome, "exitCode", 1))
            return _command_answer(self.output, exit_code, text_of(outcome, "tail"), read, outcome.get("value"))
        return _envelope_answer(outcome, read)

    def run_envelope(self, item: Json, context: Context) -> Union["Envelope", Shell]:
        """The body on an item: its value or its shell, the bundle's runner's contract (runner.ts's RUN)."""
        try:
            checked = _check(self.input, item, "the input")
            returned = self.body(checked, context)
            if isinstance(returned, Shell):
                return returned
            value = returned if self.output is None or isinstance(self.output, str) else _check(self.output, returned, "the value")
            if isinstance(value, (bytes, bytearray)):
                return Envelope({"ok": True, "bytes": base64.b64encode(value).decode()}, None)
            return Envelope({"ok": True, "value": value}, None)
        except Exception as cause:
            error = remote_error(cause)
            return Envelope({"ok": False, "error": error}, error["name"])


@dataclass(frozen=True)
class Envelope:
    """What a pushed task's process writes as its out: its value, its bytes, or the error its body threw, whose
    name a retry matches."""

    body: dict[str, object]
    error: str | None


# `@task` overloads: the body's and `output`'s shapes decide the Task's item and answer types, through the
# callable each shape returns — `input` types the wire item by its own argument and the body by its output.


class _FromText(Protocol[In, V_co]):
    """`@task(..., output="text", input=f)` on a body returning a Shell."""

    def __call__(self, body: Callable[[V_co, Context], Shell], /) -> Task[In, str]: ...


class _FromBytes(Protocol[In, V_co]):
    def __call__(self, body: Callable[[V_co, Context], Shell], /) -> Task[In, bytes]: ...


class _FromValidate(Protocol[In, V_co, Out]):
    def __call__(self, body: Callable[[V_co, Context], object], /) -> Task[In, Out]: ...


class _FromDecorate(Protocol[In, V_co]):
    @overload
    def __call__(self, body: Callable[[V_co, Context], Shell], /) -> Task[In, None]: ...

    @overload
    def __call__(self, body: Callable[[V_co, Context], Out], /) -> Task[In, Out]: ...


class _Text(Protocol):
    def __call__(self, body: Callable[[In, Context], Shell], /) -> Task[In, str]: ...


class _Bytes(Protocol):
    def __call__(self, body: Callable[[In, Context], Shell], /) -> Task[In, bytes]: ...


class _Validate(Protocol[Out]):
    def __call__(self, body: Callable[[In, Context], object], /) -> Task[In, Out]: ...


class _Decorate(Protocol):
    @overload
    def __call__(self, body: Callable[[In, Context], Shell], /) -> Task[In, None]: ...

    @overload
    def __call__(self, body: Callable[[In, Context], Out], /) -> Task[In, Out]: ...


@overload
def task(*, id: str, recipe: object = None, output: Literal["text"], timeout: float = 3600, speculative: bool = False,
         retries: Retries | None = None, secrets: Iterable[str] = (), cache: dict[str, int] | None = None,
         input: Callable[[In], V]) -> _FromText[In, V]: ...


@overload
def task(*, id: str, recipe: object = None, output: Literal["text"], timeout: float = 3600, speculative: bool = False,
         retries: Retries | None = None, secrets: Iterable[str] = (), cache: dict[str, int] | None = None,
         input: "type[Validates[V]]") -> _FromText[Json, V]: ...


@overload
def task(*, id: str, recipe: object = None, output: Literal["text"], timeout: float = 3600, speculative: bool = False,
         retries: Retries | None = None, secrets: Iterable[str] = (), cache: dict[str, int] | None = None,
         input: None = None) -> _Text: ...


@overload
def task(*, id: str, recipe: object = None, output: Literal["bytes"], timeout: float = 3600, speculative: bool = False,
         retries: Retries | None = None, secrets: Iterable[str] = (), cache: dict[str, int] | None = None,
         input: Callable[[In], V]) -> _FromBytes[In, V]: ...


@overload
def task(*, id: str, recipe: object = None, output: Literal["bytes"], timeout: float = 3600, speculative: bool = False,
         retries: Retries | None = None, secrets: Iterable[str] = (), cache: dict[str, int] | None = None,
         input: "type[Validates[V]]") -> _FromBytes[Json, V]: ...


@overload
def task(*, id: str, recipe: object = None, output: Literal["bytes"], timeout: float = 3600, speculative: bool = False,
         retries: Retries | None = None, secrets: Iterable[str] = (), cache: dict[str, int] | None = None,
         input: None = None) -> _Bytes: ...


@overload
def task(*, id: str, recipe: object = None, output: Validator[Out], timeout: float = 3600, speculative: bool = False,
         retries: Retries | None = None, secrets: Iterable[str] = (), cache: dict[str, int] | None = None,
         input: Callable[[In], V]) -> _FromValidate[In, V, Out]: ...


@overload
def task(*, id: str, recipe: object = None, output: Validator[Out], timeout: float = 3600, speculative: bool = False,
         retries: Retries | None = None, secrets: Iterable[str] = (), cache: dict[str, int] | None = None,
         input: "type[Validates[V]]") -> _FromValidate[Json, V, Out]: ...


@overload
def task(*, id: str, recipe: object = None, output: Validator[Out], timeout: float = 3600, speculative: bool = False,
         retries: Retries | None = None, secrets: Iterable[str] = (), cache: dict[str, int] | None = None,
         input: None = None) -> _Validate[Out]: ...


@overload
def task(*, id: str, recipe: object = None, output: None = None, timeout: float = 3600, speculative: bool = False,
         retries: Retries | None = None, secrets: Iterable[str] = (), cache: dict[str, int] | None = None,
         input: Callable[[In], V]) -> _FromDecorate[In, V]: ...


@overload
def task(*, id: str, recipe: object = None, output: None = None, timeout: float = 3600, speculative: bool = False,
         retries: Retries | None = None, secrets: Iterable[str] = (), cache: dict[str, int] | None = None,
         input: "type[Validates[V]]") -> _FromDecorate[Json, V]: ...


@overload
def task(*, id: str, recipe: object = None, output: None = None, timeout: float = 3600, speculative: bool = False,
         retries: Retries | None = None, secrets: Iterable[str] = (), cache: dict[str, int] | None = None,
         input: None = None) -> _Decorate: ...


def task(*, id: str, recipe: object = None, output: object = None, timeout: float = 3600, speculative: bool = False,
         retries: Retries | None = None, secrets: Iterable[str] = (), cache: dict[str, int] | None = None,
         input: object = None) -> object:
    """A task, exported from a file in the project's task folder so `python -m armada push` finds it. With an
    `input` validator, callers pass its input and the body gets its output. A body's value, or a command's out,
    is checked by `output` before it counts as ok."""

    def wrap(body: Callable[..., object]) -> Task[Json, object]:
        return Task(task_id=id, body=body, recipe_=recipe, output=output, timeout=timeout, speculative=speculative,
                    retries=retries, secrets=secrets, cache=cache, input=input)

    return wrap
