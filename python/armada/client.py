"""A deployment of armada and the requests it answers — the Python twin of sdk.ts: jobs, their events and
outputs, packs and bundles, over urllib with the protocol header and the read retries it does."""

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterator, Optional, Union

from .wire import PROTOCOL, PROTOCOL_HEADER

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
    stream: Optional[BinaryIO] = None

    def json(self) -> Any:
        return json.loads(self.body)


class Armada:
    """A deployment's client: every request carries the token and the wire's version."""

    def __init__(self, connection: Connection) -> None:
        self.connection = connection

    def call(self, path: str, method: str = "GET", body: Optional[Union[bytes, BinaryIO]] = None,
             headers: Optional[dict[str, str]] = None, stream: bool = False, protocol: int = PROTOCOL) -> Response:
        """A request to the runner. A read that meets a gateway's 502/503/504, the Worker's own 500, or a dropped
        connection is asked again, up to READ_ATTEMPTS times a second apart more each time."""
        attempts = READ_ATTEMPTS if method in ("GET", "HEAD") else 1
        # urllib's default agent is blocked by Cloudflare's bot rules; the SDK names itself instead.
        heads = {"authorization": f"Bearer {self.connection.token}", PROTOCOL_HEADER: str(protocol), "user-agent": "armada-python/0.1", **(headers or {})}

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

    def post(self, path: str, body: object) -> Any:
        return self.call(path, "POST", json.dumps(body).encode(), {"content-type": "application/json"}).json()

    def health(self) -> dict[str, Any]:
        answer = self.call("/health").json()
        return dict(answer) if isinstance(answer, dict) else {}

    def create(self, spec: dict[str, Any]) -> str:
        created = self.post("/jobs", spec)
        return str(created["id"])

    def add(self, job: str, items: list[dict[str, Any]]) -> None:
        self.post(f"/jobs/{job}/items", {"items": items})

    def close(self, job: str) -> None:
        self.call(f"/jobs/{job}/close", "POST")

    def cancel(self, job: str) -> None:
        self.call(f"/jobs/{job}/cancel", "POST")

    def status(self, job: str) -> dict[str, Any]:
        answer = self.call(f"/jobs/{job}").json()
        return dict(answer) if isinstance(answer, dict) else {}

    def events(self, job: str, after: int) -> dict[str, Any]:
        answer = self.call(f"/jobs/{job}/events?after={after}").json()
        return dict(answer) if isinstance(answer, dict) else {}

    def items(self, job: str) -> list[Any]:
        answer = self.call(f"/jobs/{job}/items").json()
        return list(answer["items"])

    def output(self, job: str, index: int) -> Optional[bytes]:
        response = self.call(f"/jobs/{job}/tasks/{index}/output")
        return None if response.status == 404 else response.body

    def output_stream(self, job: str, index: int) -> Optional[BinaryIO]:
        response = self.call(f"/jobs/{job}/tasks/{index}/output", stream=True)
        return response.stream

    def log(self, job: str, index: int) -> Optional[str]:
        response = self.call(f"/jobs/{job}/tasks/{index}/log")
        return None if response.status == 404 else response.body.decode()

    def artifacts(self, job: str, index: int) -> Optional[bytes]:
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
        return list(self.call("/secrets").json()["names"])

    def delete_secret(self, name: str) -> bool:
        return bool(self.call(f"/secrets/{name}", "DELETE").json()["deleted"])

    def resolve(self, recipe: dict[str, Any]) -> dict[str, str]:
        answer: dict[str, Any] = self.post("/environments/resolve", {"recipe": recipe})
        return {"key": str(answer["key"]), "base": str(answer["base"])}


def summary_of(status: dict[str, Any]) -> dict[str, Any]:
    """A job's times and counts, from its status."""
    finished = status["finishedAt"] if status.get("finishedAt") is not None else int(time.time() * 1000)
    started = status["startedAt"] if status.get("startedAt") is not None else finished
    map_ms = finished - started
    tasks = status["tasks"]

    return {
        "tasks": tasks["total"], "green": tasks["exited"] - tasks["red"], "red": tasks["red"], "failed": tasks["failed"],
        "wallMs": finished - status["createdAt"], "mapMs": map_ms, "vessels": len(status.get("vessels", [])),
        "bootMs": sorted(v["bootMs"] for v in status.get("vessels", []) if v.get("bootMs") is not None),
        "tasksPerSecond": (tasks["exited"] + tasks["failed"]) / (map_ms / 1000) if map_ms > 0 else 0,
    }


def _as_iter_bytes(stream: BinaryIO, chunk: int = 65536) -> Iterator[bytes]:
    while True:
        part = stream.read(chunk)
        if not part:
            return
        yield part
