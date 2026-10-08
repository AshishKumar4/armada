"""A deployment of armada and the requests it answers — the Python twin of sdk.ts: jobs, their events and
outputs, packs and bundles, over urllib with the protocol header and the read retries it does."""

import json
import os
import time
import urllib.error
import urllib.request
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from .wire import PROTOCOL, PROTOCOL_HEADER, Json, JsonObject, list_of, maybe_text_of, maybe_whole_of, number_of, object_of, text_of

CONFIG_DIR = Path.home() / ".config" / "armada"

# How often a read is asked of a runner whose gateway failed to answer it.
READ_ATTEMPTS = 5

# The largest pack, in bytes, sent in one request.
PACK_PART = 64 * 1024 * 1024


@dataclass(frozen=True)
class Connection:
    url: str
    token: str
    account: str = ""


class RequestError(Exception):
    """A request the Worker answered with an error: its status, and what it said."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def connection_file(name: str) -> Path:
    """Where `armada deploy --name=<name>` writes a deployment's connection."""
    return CONFIG_DIR / ("connection.json" if name == "armada" else f"{name}.json")


def connect() -> "Armada":
    """The runner this machine deployed, the one ARMADA_CONNECTION names, or ARMADA_URL and ARMADA_TOKEN."""
    url = os.environ.get("ARMADA_URL")
    token = os.environ.get("ARMADA_TOKEN")
    if url is not None and token is not None:
        return Armada(Connection(url, token, os.environ.get("ARMADA_ACCOUNT", "")))
    named = os.environ.get("ARMADA_CONNECTION")
    file = Path(named) if named else connection_file("armada")

    if not file.exists():
        raise RuntimeError(
            "not deployed from this machine: run `armada deploy`, or set ARMADA_URL and ARMADA_TOKEN"
            if named is None
            else f"no connection file at {file}"
        )
    given = json.loads(file.read_text())

    return Armada(Connection(str(given["url"]), str(given["token"]), str(given.get("account", ""))))


def _failure_of(status: int, body: bytes) -> str:
    """A failed response in one line: the Worker's own error, or the status and the first line of any page."""
    text = body.decode(errors="replace")
    try:
        said = json.loads(text)
        if isinstance(said, dict) and isinstance(said.get("error"), str):
            return f"{status} {said['error']}"
    except json.JSONDecodeError:
        pass
    line = next((each.strip() for each in text.split("\n") if each.strip() != ""), "")[:200]

    return f"{status} from the Worker (it may still be deploying)" + ("" if line == "" else f": {line}")


@dataclass(frozen=True)
class Response:
    """What a call got back: its status and body, the stream when one was asked for."""

    status: int
    body: bytes
    headers: dict[str, str]
    stream: BinaryIO | None = None

    def json(self) -> Json:
        parsed: Json = json.loads(self.body)
        return parsed


class Armada:
    """A deployment's client: every request carries the token and the wire's version."""

    def __init__(self, connection: Connection) -> None:
        self.connection = connection

    def call(self, path: str, method: str = "GET", body: bytes | BinaryIO | None = None,
             headers: dict[str, str] | None = None, stream: bool = False, protocol: int = PROTOCOL) -> Response:
        """A request to the runner. A read that meets a gateway's 502/503/504, the Worker's own 500, or a dropped
        connection is asked again, up to READ_ATTEMPTS times a second apart more each time."""
        attempts = READ_ATTEMPTS if method in ("GET", "HEAD") else 1
        # urllib's default agent is blocked by Cloudflare's bot rules; the SDK names itself instead.
        heads = {
            "authorization": f"Bearer {self.connection.token}", PROTOCOL_HEADER: str(protocol), "user-agent": "armada-python/0.1",
            **(headers or {}),
        }

        for attempt in range(1, attempts + 1):
            request = urllib.request.Request(self.connection.url.rstrip("/") + path, data=body, headers=heads, method=method)
            try:
                raw = urllib.request.urlopen(request)
                if stream:
                    return Response(raw.status, b"", dict(raw.headers.items()), raw)
                with raw:
                    return Response(raw.status, raw.read(), dict(raw.headers.items()))
            except urllib.error.HTTPError as failed:
                content = failed.headers.get("content-type", "") if failed.headers else ""
                if failed.code in (500, 502, 503, 504) and attempt < attempts:
                    time.sleep(attempt)
                    continue
                # The Worker's own 404 says a thing is absent; an HTML one is a page from a Worker not yet answering.
                absent = failed.code == 404 and not content.startswith("text/html")
                if not absent:
                    raise RequestError(failed.code, f"{method} {path}: {_failure_of(failed.code, failed.read())}") from failed
                return Response(failed.code, failed.read(), dict(failed.headers.items()))
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                if attempt < attempts:
                    time.sleep(attempt)
                    continue
                raise
        raise AssertionError("unreachable")

    def post(self, path: str, body: object) -> Json:
        return self.call(path, "POST", json.dumps(body).encode(), {"content-type": "application/json"}).json()

    def health(self) -> JsonObject:
        return object_of(self.call("/health").json())

    def create(self, spec: Mapping[str, object]) -> str:
        job = text_of(object_of(self.post("/jobs", spec)), "id")
        if job == "":
            raise RequestError(200, "POST /jobs answered without a job id")
        return job

    def add(self, job: str, items: Sequence[Mapping[str, object]]) -> None:
        self.post(f"/jobs/{job}/items", {"items": items})

    def close(self, job: str) -> None:
        self.call(f"/jobs/{job}/close", "POST")

    def cancel(self, job: str) -> None:
        self.call(f"/jobs/{job}/cancel", "POST")

    def status(self, job: str) -> "JobStatus":
        return JobStatus.of(self.call(f"/jobs/{job}").json())

    def events(self, job: str, after: int) -> JsonObject:
        return object_of(self.call(f"/jobs/{job}/events?after={after}").json())

    def items(self, job: str) -> list[Json]:
        items = object_of(self.call(f"/jobs/{job}/items").json()).get("items")
        return items if isinstance(items, list) else []

    def output(self, job: str, index: int) -> bytes | None:
        response = self.call(f"/jobs/{job}/tasks/{index}/output")
        return None if response.status == 404 else response.body

    def output_stream(self, job: str, index: int) -> BinaryIO | None:
        response = self.call(f"/jobs/{job}/tasks/{index}/output", stream=True)
        return response.stream

    def log(self, job: str, index: int) -> str | None:
        response = self.call(f"/jobs/{job}/tasks/{index}/log")
        return None if response.status == 404 else response.body.decode()

    def artifacts(self, job: str, index: int) -> bytes | None:
        response = self.call(f"/jobs/{job}/tasks/{index}/artifacts")
        return None if response.status == 404 else response.body

    def upload_bundle(self, content: bytes) -> str:
        """Stores a bundle once, under the sha-256 of its bytes, and returns that digest."""
        import hashlib

        digest = hashlib.sha256(content).hexdigest()
        if self.call(f"/bundles/{digest}", "HEAD").status == 404:
            self.call(f"/bundles/{digest}", "PUT", content)
        return digest

    def set_secret(self, name: str, value: str) -> None:
        self.call(f"/secrets/{name}", "PUT", value.encode())

    def secrets(self) -> list[str]:
        names = object_of(self.call("/secrets").json()).get("names")
        return [name for name in names if isinstance(name, str)] if isinstance(names, list) else []

    def delete_secret(self, name: str) -> bool:
        return object_of(self.call(f"/secrets/{name}", "DELETE").json()).get("deleted") is True

    def resolve(self, recipe: Mapping[str, object]) -> dict[str, str]:
        answer = object_of(self.post("/environments/resolve", {"recipe": recipe}))
        return {"key": text_of(answer, "key"), "base": text_of(answer, "base")}


@dataclass(frozen=True)
class TaskCounts:
    total: int
    queued: int
    running: int
    exited: int
    red: int
    failed: int


@dataclass(frozen=True)
class Vessel:
    """One container's row in a job's status."""

    name: str
    state: str
    tasks: int
    boot_ms: int | None
    busy_ms: float
    error: str | None


@dataclass(frozen=True)
class Environment:
    key: str
    sha: str | None
    created: int
    seconds: dict[str, float]


@dataclass(frozen=True)
class Running:
    index: int
    vessel: str
    started: int
    slot: int | None


@dataclass(frozen=True)
class JobStatus:
    """A job's status, as the deployment reports it (`GET /jobs/<id>`)."""

    id: str
    label: str
    phase: str
    key: str
    created_at: int
    started_at: int | None
    finished_at: int | None
    tasks: TaskCounts
    vessels: list[Vessel]
    problems: list[str]
    environment: Environment | None
    running: list[Running] | None

    @staticmethod
    def of(raw: Json) -> "JobStatus":
        fields = object_of(raw)
        counts = object_of(fields.get("tasks"))
        environment = fields.get("environment")
        return JobStatus(
            id=text_of(fields, "id"), label=text_of(fields, "label"), phase=text_of(fields, "phase"), key=text_of(fields, "key"),
            created_at=int(number_of(fields, "createdAt", 0)), started_at=maybe_whole_of(fields, "startedAt"),
            finished_at=maybe_whole_of(fields, "finishedAt"),
            tasks=TaskCounts(**{key: int(number_of(counts, key, 0)) for key in ("total", "queued", "running", "exited", "red", "failed")}),
            vessels=[_vessel(object_of(each)) for each in list_of(fields.get("vessels"))],
            problems=[each for each in list_of(fields.get("problems")) if isinstance(each, str)],
            environment=None if not isinstance(environment, dict) else _environment(environment),
            running=None if fields.get("running") is None else [_running(object_of(each)) for each in list_of(fields.get("running"))],
        )


def _vessel(fields: JsonObject) -> Vessel:
    return Vessel(
        text_of(fields, "name"), text_of(fields, "state"), int(number_of(fields, "tasks", 0)), maybe_whole_of(fields, "bootMs"),
        number_of(fields, "busyMs", 0), maybe_text_of(fields, "error"),
    )


def _environment(fields: JsonObject) -> Environment:
    seconds = object_of(fields.get("seconds"))
    return Environment(
        text_of(fields, "key"), maybe_text_of(fields, "sha"), int(number_of(fields, "created", 0)),
        {key: number_of(seconds, key, 0) for key in seconds},
    )


def _running(fields: JsonObject) -> Running:
    started = int(number_of(fields, "started", 0))
    return Running(int(number_of(fields, "index", 0)), text_of(fields, "vessel"), started, maybe_whole_of(fields, "slot"))


@dataclass(frozen=True)
class Summary:
    """A job's times and counts, from its status."""

    tasks: int
    green: int
    red: int
    failed: int
    wall_ms: int
    map_ms: int
    vessels: int
    boot_ms: list[int]
    tasks_per_second: float


def summary_of(status: JobStatus) -> Summary:
    """A job's times and counts, from its status."""
    finished = status.finished_at if status.finished_at is not None else int(time.time() * 1000)
    started = status.started_at if status.started_at is not None else finished
    map_ms = finished - started

    return Summary(
        tasks=status.tasks.total, green=status.tasks.exited - status.tasks.red, red=status.tasks.red, failed=status.tasks.failed,
        wall_ms=finished - status.created_at, map_ms=map_ms, vessels=len(status.vessels),
        boot_ms=sorted(vessel.boot_ms for vessel in status.vessels if vessel.boot_ms is not None),
        tasks_per_second=(status.tasks.exited + status.tasks.failed) / (map_ms / 1000) if map_ms > 0 else 0,
    )


def _as_iter_bytes(stream: BinaryIO, chunk: int = 65536) -> Iterator[bytes]:
    while True:
        part = stream.read(chunk)
        if not part:
            return
        yield part
