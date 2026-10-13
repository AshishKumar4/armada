"""The wire's constants, shared by the client, the pusher and the in-container runner — the same values
protocol.ts holds, so a Python task and a TypeScript one speak the same bytes."""

import json
from collections.abc import Mapping, Sequence
from typing import TypeAlias, cast

# A JSON value, as protocol.ts's `Json` — what items and envelopes carry.
Json: TypeAlias = str | float | int | bool | None | list["Json"] | dict[str, "Json"]

JsonObject = dict[str, Json]

# What a body answers without an output: JSON, read covariantly so a `list[int]` or a `dict[str, float]` fits, and
# bytes, which an envelope carries as base64.
Answerable: TypeAlias = str | float | int | bool | None | bytes | Sequence["Answerable"] | Mapping[str, "Answerable"]


class WireError(ValueError):
    """An answer of the deployment's that is not what the wire says it is."""


class Fields:
    """A JSON object of the wire's, read field by field as protocol.ts's schemas say: a required field holds its type,
    an optional one its type or nothing (absent or null). Anything else is a WireError naming the field."""

    def __init__(self, value: Json, where: str) -> None:
        if not isinstance(value, dict):
            raise WireError(f"{where} is not an object: {json.dumps(value)[:200]}")
        self._fields = value
        self.where = where

    def _held(self, key: str, kinds: tuple[type, ...], name: str, *, required: bool) -> Json:
        value = self._fields.get(key)
        # A boolean is no number, though Python counts it an int.
        if (value is None and not required) or (isinstance(value, kinds) and (bool in kinds or not isinstance(value, bool))):
            return self._fields.get(key)
        raise WireError(f"{self.where}.{key} is not {name}: {json.dumps(value)[:200]}")

    def text(self, key: str) -> str:
        return str(self._held(key, (str,), "a string", required=True))

    def optional_text(self, key: str) -> str | None:
        value = self._held(key, (str,), "a string", required=False)
        return None if value is None else str(value)

    def number(self, key: str) -> float:
        return float(cast(float, self._held(key, (int, float), "a number", required=True)))

    def optional_number(self, key: str) -> float | None:
        value = self._held(key, (int, float), "a number", required=False)
        return None if value is None else float(cast(float, value))

    def whole(self, key: str) -> int:
        return int(self.number(key))

    def optional_whole(self, key: str) -> int | None:
        value = self.optional_number(key)
        return None if value is None else int(value)

    def flag(self, key: str) -> bool:
        return self._held(key, (bool,), "a boolean", required=False) is True

    def object(self, key: str) -> "Fields":
        return Fields(self._fields.get(key), f"{self.where}.{key}")

    def optional_object(self, key: str) -> "Fields | None":
        value = self._fields.get(key)
        return None if value is None else Fields(value, f"{self.where}.{key}")

    def array(self, key: str) -> list[Json]:
        return list(cast(list[Json], self._held(key, (list,), "an array", required=True)))

    def objects(self, key: str) -> list["Fields"]:
        return [Fields(each, f"{self.where}.{key}[{at}]") for at, each in enumerate(self.array(key))]

    def optional_objects(self, key: str) -> list["Fields"] | None:
        return None if self._fields.get(key) is None else self.objects(key)

    def texts(self, key: str) -> list[str]:
        listed = self.array(key)
        if not all(isinstance(each, str) for each in listed):
            raise WireError(f"{self.where}.{key} is not an array of strings: {json.dumps(listed)[:200]}")
        return [str(each) for each in listed]

    def numbers(self) -> dict[str, float]:
        """Every field, each a number: a record of numbers."""
        return {key: self.number(key) for key in self._fields}

    def raw(self, key: str) -> Json:
        """A field carried as it is, whatever its type: an item, a value."""
        return self._fields.get(key)


# The wire's version, which every request names in PROTOCOL_HEADER.
PROTOCOL = 10

PROTOCOL_HEADER = "armada-protocol"

# Where a task's container keeps what armada gives it: the job's files, the pushed tasks' bundle,
# the file a task writes its output to, and the file the runner says there which kind of answer that is.
FILES_DIR = "/armada/files"
OUT_PATH = "/armada/task/out"
ANSWER_PATH = "/armada/task/answer"
ARTIFACTS_PATH = "/armada/task/artifacts"

# The container sizes, smallest first: protocol.ts's SIZES, which the Worker checks a recipe against.
SIZES = ("micro", "mini", "small", "medium")

DEFAULT_BASE = "cloudflare/debian-trixie"


def remote_error(cause: BaseException) -> dict[str, str]:
    """A thrown error as an envelope carries it: its name, message and stack, for a retry named by the name."""
    import traceback

    return {"name": type(cause).__name__, "message": str(cause), "stack": "".join(traceback.format_exception(cause))}
