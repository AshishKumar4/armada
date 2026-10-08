"""armada's typed API, Python-side: `task` defines one, by an id unique in its deployment; its body runs in a
container on each item, returning a value, or a `sh` command whose `out` file is the answer. `python -m armada
push` sends a project's task folder, and `.map`, `.stream`, `.run` and `.local` run a task by its id."""

import base64
import dataclasses
import json
import os
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO, Callable, Generic, Iterable, Iterator, Optional, TypeVar, Union, cast

from .client import Armada, connect, summary_of
from .recipe import Recipe, RecipeBuilder, recipe as default_recipe
from .sh import OutFile, Shell, ShellError, execute, out_file
from .wire import remote_error

I = TypeVar("I")
O = TypeVar("O")

# The most items one job takes (MAX_TASKS in protocol.ts).
MAX_TASKS = 10000

# An open job's items go in batches of this many, or what came in this long.
BATCH = 500
BATCH_MS = 0.25

# How long a job's reader waits when no outcome landed.
POLL_S = 1.0


class SchemaError(Exception):
    """An item or an answer that failed its validator."""

    def __init__(self, what: str, problem: object) -> None:
        super().__init__(f"{what} does not fit its schema: {problem}")
        self.what = what
        self.problem = problem


Validator = Callable[[Any], Any]


def _check(validator: object, value: Any, what: str) -> Any:
    """`value` through its validator: a model class's `model_validate`, or any callable that raises on bad input."""
    if validator is None:
        return value
    try:
        validate = getattr(validator, "model_validate", None)
        if callable(validate):
            return validate(value)
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
class Result(Generic[I, O]):
    """What each item's task came to: `ok` with `value`, or `kind` `error`/`timeout`/`cancelled`/`lost`."""

    index: int
    item: I
    meta: Meta
    ok: bool
    kind: str  # 'ok' | 'error' | 'timeout' | 'cancelled' | 'lost'
    value: Optional[O] = None
    error: Optional[RemoteError] = None
    reason: str = ""


class MapError(Exception, Generic[I, O]):
    """A job whose results are not all `ok`: every result is here, in input order."""

    def __init__(self, results: list["Result[I, O]"]) -> None:
        self.results = results
        failed = [result for result in results if not result.ok]
        first = failed[0] if failed else None
        super().__init__(f"{len(failed)} of {len(results)} tasks did not succeed" + ("" if first is None else f"; item {first.index}: {_describe(first)}"))


def _describe(result: Result[Any, Any]) -> str:
    if result.kind == "ok":
        return "ok"
    if result.kind == "error":
        return f"{result.error.name if result.error else 'Error'}: {result.error.message if result.error else ''}"
    if result.kind == "timeout":
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


def _command_answer(output: object, exit_code: int, tail: str, read: Callable[[], Optional[bytes]], value: Optional[str] = None) -> Union[tuple[str, Any], tuple[str, RemoteError]]:
    """A command's answer: its `out` read as `output` says, once it exited 0 — the same shapes the TS `answer` gives."""
    if exit_code != 0:
        return ("error", RemoteError("Exit", f"the command exited {exit_code}", tail))
    if output is None:
        return ("ok", None)
    if output == "bytes":
        return ("ok", read() or b"")
    try:
        text = value if value is not None else (read() or b"").decode()
        return ("ok", text if output == "text" else _check(output, json.loads(text), "the output"))
    except Exception as cause:
        return ("error", RemoteError(**remote_error(cause)))


def _envelope_answer(outcome: dict[str, Any], read: Callable[[], Optional[bytes]]) -> Union[tuple[str, Any], tuple[str, RemoteError]]:
    """A pushed task's answer: the envelope its process wrote, or an Exit when it died before answering."""
    raw = outcome.get("value")
    text = raw if isinstance(raw, str) else (read() or b"").decode()
    try:
        envelope = json.loads(text)
        ok = envelope.get("ok") is True if isinstance(envelope, dict) else False
        if not isinstance(envelope, dict) or "ok" not in envelope:
            raise ValueError("not an envelope")
    except Exception:
        return ("error", RemoteError("Exit", f"the task's process exited {outcome.get('exitCode', 1)}", str(outcome.get("tail", ""))))
    if not ok:
        error = envelope.get("error", {})
        return ("error", RemoteError(str(error.get("name", "Error")), str(error.get("message", "")), str(error.get("stack", ""))))
    if "bytes" in envelope:
        return ("ok", base64.b64decode(str(envelope["bytes"])))
    return ("ok", envelope.get("value"))


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
        """Runs in a thread: batches items into the open job, 500 to a batch or every BATCH_MS, then closes it."""
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
                if len(batch) >= BATCH or time.monotonic() - last >= BATCH_MS:
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
        return self._held[index]  # type: ignore[no-any-return]

    def _result(self, outcome: dict[str, Any]) -> Result[I, O]:
        item = self._item(int(outcome["index"]))
        meta = Meta(
            seconds=float(outcome.get("seconds", 0)), attempt=int(outcome.get("attempt", 1)), container=str(outcome.get("vessel", "")),
            exit_code=int(outcome.get("exitCode", 0)), tail=str(outcome.get("tail", "")), peak_memory=outcome.get("peakMemory"),
            cpu_seconds=outcome.get("cpuSeconds"), artifacts=outcome.get("artifacts") is True, cached=outcome.get("cached") is True,
        )
        index = int(outcome["index"])
        if outcome.get("kind") == "failed":
            kind = "cancelled" if outcome.get("reason") == "cancelled" else "lost"
            return Result(index, item, meta, False, kind, reason=meta.tail)
        if outcome.get("reason") == "timeout":
            return Result(index, item, meta, False, "timeout")
        kind, value = self._task.answer(outcome, lambda: self.armada.output(self.id, index))
        if kind == "ok":
            return Result(index, item, meta, True, "ok", value=value)
        assert isinstance(value, RemoteError)
        return Result(index, item, meta, False, "error", error=value)

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
        return [result.value for result in results]  # type: ignore[misc]

    def cancel(self) -> None:
        self.submission.stopped = True
        self.armada.cancel(self.id)

    def status(self) -> dict[str, Any]:
        return self.armada.status(self.id)

    def summary(self) -> dict[str, Any]:
        return summary_of(self.status())

    def log(self, index: int) -> Optional[str]:
        return self.armada.log(self.id, index)

    def output(self, index: int) -> Optional[bytes]:
        return self.armada.output(self.id, index)

    def output_stream(self, index: int) -> Optional[BinaryIO]:
        return self.armada.output_stream(self.id, index)

    def artifacts(self, index: int) -> Optional[bytes]:
        return self.armada.artifacts(self.id, index)


def _retries(retries: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """`{"attempts": n, "on": [137, "TimeoutError"]}` as the spec's `{attempts, exitCodes, errors}`."""
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

    def __init__(self, *, task_id: str, body: Callable[..., Any], recipe_: Any = None, output: object = None,
                 timeout: float = 3600, speculative: bool = False, retries: Optional[dict[str, Any]] = None,
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
        return built if built is not None else default_recipe().spec

    def _spec(self, options: dict[str, Any], bundle: Optional[str]) -> dict[str, Any]:
        spec = {
            "recipe": self.recipe,
            "run": {"kind": "task", "id": self.id, **({"bundle": bundle, "runtime": "python"} if bundle is not None else {})},
            "output": True, "pool": options.get("pool"), "slots": options.get("slots"), "label": options.get("label", ""),
            "env": options.get("env", {}), "files": options.get("files", {}), "tmpfs": options.get("tmpfs", ["/tmp", "/dev/shm"]),
            "timeout": self.timeout, "speculative": self.speculative, "retries": _retries(self.retries),
            "secrets": self.secrets, "cache": self.cache,
        }
        return {key: value for key, value in spec.items() if value is not None}

    def stream(self, items: Iterable[I], **options: Any) -> Job[I, O]:
        """The job, whose results arrive as they land. Items stream in when given as a generator."""
        armada: Armada = options.get("armada") or connect()
        from .push import pushed

        bundle = pushed(armada)
        submission: Submission[I] = Submission(armada)

        def create() -> None:
            try:
                if isinstance(items, list):
                    if len(items) > MAX_TASKS:
                        raise ValueError(f"a job takes at most {MAX_TASKS} items, not {len(items)}")
                    spec = {**self._spec(options, bundle), "items": [self._wire(item, at) for at, item in enumerate(items)]}
                    submission.resolve(armada.create(spec))
                    submission.sent = list(items)
                    submission.done.set()
                else:
                    spec = {**self._spec(options, bundle), "items": [], "open": True}
                    submission.resolve(armada.create(spec))
                    submission.pump(items, self._wire)
            except BaseException as cause:
                submission.fail(cause)

        threading.Thread(target=create, daemon=True).start()
        return Job(armada, self, submission)

    def map(self, items: Iterable[I], **options: Any) -> list[O]:
        """Every item's value, in input order, or a MapError holding every result when one is not ok."""
        return self.stream(items, **options).values()

    def run(self, item: I, **options: Any) -> O:
        """One item's value, on one container."""
        results = self.stream([item], **options).settled()
        if not results or not results[0].ok:
            raise MapError(results)
        return results[0].value  # type: ignore[return-value]

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
            kind, value = _command_answer(self.output, 0, ran.stderr, lambda: Path(out).read_bytes() if os.path.exists(out) else None)
            if kind == "error":
                raise RuntimeError(value.message)
            return cast(O, value)

    def job(self, job_id: str, **options: Any) -> Job[I, O]:
        """A job this task ran, by its id."""
        armada: Armada = options.get("armada") or connect()
        submission: Submission[I] = Submission(armada)
        submission.sent = None
        submission.resolve(job_id)
        return Job(armada, self, submission)

    def _wire(self, item: I, index: int) -> dict[str, Any]:
        """An item as a wire task, checked first."""
        if self.input is not None:
            _check(self.input, item, f"item {index}")
        return {"item": item}

    def answer(self, outcome: dict[str, Any], read: Callable[[], Optional[bytes]]) -> Union[tuple[str, Any], tuple[str, RemoteError]]:
        """An exited task's answer."""
        if outcome.get("answer") == "command":
            return _command_answer(self.output, int(outcome.get("exitCode", 1)), str(outcome.get("tail", "")), read, outcome.get("value"))
        return _envelope_answer(outcome, read)

    def run_envelope(self, item: Any, context: Context) -> Union[dict[str, Any], Shell]:
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


def task(*, id: str, recipe: Any = None, output: object = None, timeout: float = 3600, speculative: bool = False,
         retries: Optional[dict[str, Any]] = None, secrets: Iterable[str] = (), cache: Optional[dict[str, int]] = None,
         input: object = None) -> Callable[[Callable[..., Any]], Task[Any, Any]]:
    """A task, exported from a file in the project's task folder so `python -m armada push` finds it."""

    def wrap(body: Callable[..., Any]) -> Task[Any, Any]:
        return Task(task_id=id, body=body, recipe_=recipe, output=output, timeout=timeout, speculative=speculative,
                    retries=retries, secrets=secrets, cache=cache, input=input)

    return wrap
