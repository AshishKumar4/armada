"""A deployment of armada and the requests it answers — the Python twin of sdk.ts: jobs, their events and
outputs, packs and bundles, over urllib with the protocol header and the read retries it does."""

import json
import os
import time
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from .wire import PROTOCOL, PROTOCOL_HEADER, Fields, Json

CONFIG_DIR = Path.home() / ".config" / "armada"

# How often a read is asked of a runner whose gateway failed to answer it.
READ_ATTEMPTS = 5

# How often a bundle is stored while another client stores the same at that moment.
STORE_ATTEMPTS = 6


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
    """The runner ARMADA_CONNECTION names; else the one ARMADA_URL and ARMADA_TOKEN give; else the one this machine
    deployed. A named connection comes first: it is the one asked for."""
    named = os.environ.get("ARMADA_CONNECTION")
    url = os.environ.get("ARMADA_URL")
    token = os.environ.get("ARMADA_TOKEN")
    if named is None and url is not None and token is not None:
        return Armada(Connection(url, token, os.environ.get("ARMADA_ACCOUNT", "")))
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

    def health(self) -> Fields:
        return Fields(self.call("/health").json(), "GET /health")

    def create(self, spec: Mapping[str, object]) -> str:
        return Fields(self.post("/jobs", spec), "POST /jobs").text("id")

    def add(self, job: str, items: Sequence[Mapping[str, object]]) -> None:
        self.post(f"/jobs/{job}/items", {"items": items})

    def close(self, job: str) -> None:
        self.call(f"/jobs/{job}/close", "POST")

    def cancel(self, job: str) -> None:
        self.call(f"/jobs/{job}/cancel", "POST")

    def status(self, job: str) -> "JobStatus":
        answer = self.call(f"/jobs/{job}")
        if answer.status == 404:
            raise RequestError(404, f"no job {job} in this deployment")
        return JobStatus.of(Fields(answer.json(), f"GET /jobs/{job}"))

    def events(self, job: str, after: int) -> Fields:
        return Fields(self.call(f"/jobs/{job}/events?after={after}").json(), f"GET /jobs/{job}/events")

    def items(self, job: str) -> list[Json]:
        return Fields(self.call(f"/jobs/{job}/items").json(), f"GET /jobs/{job}/items").array("items")

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
        """Stores a bundle once, under the sha-256 of its bytes, and returns that digest. While another client stores the
        same bundle at that moment, the Worker answers 429 and it is asked for again (#62)."""
        import hashlib

        digest = hashlib.sha256(content).hexdigest()
        attempt = 1
        while self.call(f"/bundles/{digest}", "HEAD").status == 404:
            try:
                self.call(f"/bundles/{digest}", "PUT", content)
                break
            except RequestError as failed:
                if failed.status != 429 or attempt == STORE_ATTEMPTS:
                    raise
            time.sleep(attempt)
            attempt += 1
        return digest

    def set_secret(self, name: str, value: str) -> None:
        self.call(f"/secrets/{name}", "PUT", value.encode())

    def secrets(self) -> list[str]:
        return Fields(self.call("/secrets").json(), "GET /secrets").texts("names")

    def delete_secret(self, name: str) -> bool:
        return Fields(self.call(f"/secrets/{name}", "DELETE").json(), f"DELETE /secrets/{name}").flag("deleted")

    def resolve(self, recipe: Mapping[str, object]) -> dict[str, str]:
        answer = Fields(self.post("/environments/resolve", {"recipe": recipe}), "POST /environments/resolve")
        return {"key": answer.text("key"), "base": answer.text("base")}


@dataclass(frozen=True)
class TaskCounts:
    total: int
    queued: int
    running: int
    exited: int
    red: int
    failed: int


@dataclass(frozen=True)
class Boot:
    """Where a container's boot went: waiting for capacity, its start (the snapshot's restore and any start made again,
    each said in `restarts`), and the setup before its first task."""

    wait_ms: float
    start_ms: float
    restarts: list[str]
    setup_ms: float
    # The host it started on; None from an earlier Worker.
    host: "Host | None" = None


@dataclass(frozen=True)
class Host:
    """A host that ran a task: its CPU (vendor, family and model, as /proc/cpuinfo has them), the CPU's name, and its
    x86-64 level (4 for x86-64-v4; 0 below v2 or off x86). Hosts of one CPU compute a float operation alike."""

    vendor: str
    family: int
    model: int
    name: str
    level: int

    @staticmethod
    def of(fields: Fields | None) -> "Host | None":
        if fields is None:
            return None
        return Host(fields.text("vendor"), fields.whole("family"), fields.whole("model"), fields.text("name"), fields.whole("level"))


@dataclass(frozen=True)
class Vessel:
    """One container's row in a job's status."""

    name: str
    state: str
    tasks: int
    boot_ms: int | None
    busy_ms: float
    error: str | None
    boot: Boot | None = None


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
    def of(fields: Fields) -> "JobStatus":
        counts = fields.object("tasks")
        environment = fields.optional_object("environment")
        running = fields.optional_objects("running")
        return JobStatus(
            id=fields.text("id"), label=fields.text("label"), phase=fields.text("phase"), key=fields.text("key"),
            created_at=fields.whole("createdAt"), started_at=fields.optional_whole("startedAt"),
            finished_at=fields.optional_whole("finishedAt"),
            tasks=TaskCounts(**{key: counts.whole(key) for key in ("total", "queued", "running", "exited", "red", "failed")}),
            vessels=[_vessel(each) for each in fields.objects("vessels")],
            problems=fields.texts("problems"),
            environment=None if environment is None else _environment(environment),
            running=None if running is None else [_running(each) for each in running],
        )


def _vessel(fields: Fields) -> Vessel:
    boot = fields.optional_object("boot")
    return Vessel(
        fields.text("name"), fields.text("state"), fields.whole("tasks"), fields.optional_whole("bootMs"),
        fields.number("busyMs"), fields.optional_text("error"), None if boot is None else _boot(boot),
    )


def _boot(fields: Fields) -> Boot:
    return Boot(fields.number("waitMs"), fields.number("startMs"), fields.texts("restarts"), fields.number("setupMs"),
                Host.of(fields.optional_object("host")))


def _environment(fields: Fields) -> Environment:
    return Environment(fields.text("key"), fields.optional_text("sha"), fields.whole("created"), fields.object("seconds").numbers())


def _running(fields: Fields) -> Running:
    return Running(fields.whole("index"), fields.text("vessel"), fields.whole("started"), fields.optional_whole("slot"))


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
    boots: list[Boot]


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
        boots=[vessel.boot for vessel in status.vessels if vessel.boot is not None],
    )
